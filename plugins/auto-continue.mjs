/**
 * auto-continue v1.8 — 轮次失败自动续跑（DSH 原生版，思路二次加工自
 * cheapestinference/claude-auto-retry + goal-round-driver 防竞争模式）。
 *
 * 两条触发链：
 * A) 硬失败：LLM 内部重试耗尽 → 整轮失败（agent/error，需命中错误白名单）→ idle → 退避后续跑；
 * B) 软熔断：anti-repetition 拦截复读/断流（总线事件 anti-repetition/stopped）→ idle → 退避后续跑。
 * 两条链计数独立（attempt / softAttempt），共用退避表与防竞争围栏。
 *
 * 加固设计：
 * 1. 错误白名单：仅超时/网络/5xx/overload 类错误才续跑，其他失败（鉴权、内容审查等）不动。
 * 2. 退避表 + 连发上限：默认 5s→15s→30s，最多 3 次；软熔断默认最多 2 次。到顶放弃并写 warn（fail loud）。
 * 3. 防竞争（goal-round-driver 同款围栏）：发送前复查 agent 仍存活、仍 idle、无重复续跑、运行时未关闭。
 * 4. 真人否决（v1.8 收窄）：inbox 出现真人 user 消息默认不再否决（改由插队机制接手）；
 *    用户删除排队中的 auto-continue「继续」仍然立即清零计数并撤定时器；
 *    关闭 priorityOverQueued 时恢复旧的「真人消息即全量重置」行为。
 * 5. 子 agent 默认不碰：session.header.origin === "subagent" 的跳过，避免与父级重试打架。
 * 6. 干净收尾即重置：无失败的 idle 把两条计数都归零。
 *
 * v1.3 变更：
 * - 用户在 UI 删掉排队中的 auto-continue「继续」→ 视为真人否决，立即全部清零（不再重发）；
 * - 任一条链到顶放弃时同时重置两条计数器（v1.2 只重置本链，存在跨链计数泄漏）；
 * - 已核实 agent 身份解析的可靠性：agents 服务 initiator 为 AsyncLocalStorage（getStore），
 *   withInitiator 包裹整个异步 turn 生命周期，流消费期间的 currentInitiator() 恒为当前 agent，
 *   软熔断链的 agent 解析无竞态。
 *
 * v1.4 变更（2026-09-25）：
 * - 新增 C 链「空停/截断续跑」：agent/turn-stopping（轮次即将正常关闭）时检查本 turn
 *   最后一条 assistant/message —— finish=max-tokens（截断）或 finish=stop 且无任何可见
 *   文本、无工具调用（静默空停）→ 用 agent.steer 在本轮内直接补一步续跑，不经过 idle。
 *   连续 maxPrematureSteers 次仍空停则放行关闭（fail loud）；正常带文本收尾即清零；
 *   interrupted（主动取消）、有工具调用（提问类交互收尾）、inbox 有排队消息时一律不插手。
 * - B 链软续跑改发 repetitionResumeText（不再无脑回「继续」，避免喂同一失败模式）。
 *
 * v1.5 变更（2026-09-28，采纳外部评审 #1/#3）：
 * - 互斥槽 resumeSent（一次性让位）：C 链 steer 成功后，紧随该收尾的 idle 上 A/B 链让位
 *   一次并立即释放标记（失败/熔断标记保留，下一轮 idle 若仍失败自然重试）——不吞并任何
 *   链的重试，只堵「同一收尾周期 C 链与 A/B 链各发一条续跑」的窄窗口竞态。running /
 *   干净 idle / 真人接管三处统一撤销。C 链自身连续 steer（in-turn 补步不再触发 running）
 *   不受互斥影响。
 * - idle 统计行：干净收尾时若本周期有过续跑，打一行汇总（A/B/C 各几次、最后触发原因），
 *   给 minRepeats / stallTimeoutSec 等阈值调参提供真实数据。
 *
 * v1.6 变更（2026-09-30）：
 * - 错误白名单补中转上游故障（kldai 等回源失败）的透传错误体：upstream request failed /
 *   upstream service，多为瞬时 5xx 等价物。
 *
 * v1.8 变更（2026-09-30，用户需求「有排队消息时优先执行 continue」）：
 * - 新增 priorityOverQueued（默认开）：inbox 有排队消息时不再否决续跑，改为把续跑消息
 *   inbox.prepend("next-turn") 插到队首（优先于排队消息执行），再补 wakeDriver 唤醒
 *   （idle 即启动驱动；running/maintenance 下安全空转）；无排队消息维持 followup 原路径。
 * - A/B 链在有排队消息时跳过退避定时器、立即插队发送：退避窗口内排队消息会把驱动重新
 *   拉起（running 处理器撤掉挂起定时器），定时器路径在该场景下必然丢失。
 * - 排队消息不再触发真人否决（inserted 的 resetAll 仅在关闭插队时执行）。显式否决仍保留
 *   两条路：删除排队中的 auto-continue 消息（discarded→全量清零）、关掉 priorityOverQueued。
 * - 防叠加：next-turn / next-step 里已有 auto-continue 消息时一律跳过，不双发。
 */
import z from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";

export const name = "auto-continue";
export const inject = ["agents"];

const DEFAULT_PATTERNS = [
  "timed out",
  "timeout",
  "etimedout",
  "econnreset",
  "econnrefused",
  "econnaborted",
  "epipe",
  "socket hang up",
  "fetch failed",
  "network",
  "overloaded",
  "rate limit",
  "\\b(?:429|500|502|503|504|529)\\b",
  // v1.6 补：中转上游故障（kldai 等回源失败）的透传错误体，多为瞬时 5xx 等价物
  "upstream request failed",
  "upstream service"
];

export const Config = z.object({
  /** 总开关 */
  enabled: z.boolean().default(true),
  /** 自动续跑时代发的文本 */
  continueText: z.string().default("[auto-continue] 上游请求失败。接着做未完成的工作，不要复述。"),
  /** 硬失败连发上限 */
  maxAttempts: z.number().step(1).min(1).max(10).default(3),
  /** 软熔断（复读被掐/断流）连发上限 */
  maxRepetitionResumes: z.number().step(1).min(1).max(10).default(2),
  /** 是否启用软熔断自动续跑 */
  resumeAfterRepetitionStop: z.boolean().default(true),
  /** 退避表（秒）：第 n 次续跑前等 backoffSeconds[min(n-1, len-1)] */
  backoffSeconds: z.array(z.number().min(0)).default([5, 15, 30]),
  /** 可续跑错误白名单（不区分大小写的正则，匹配错误链全文） */
  patterns: z.array(z.string()).default(DEFAULT_PATTERNS),
  /** 子 agent 失败是否也自动续跑（默认否，防与父级重试双跑） */
  includeSubagents: z.boolean().default(false),
  /** v1.8：inbox 有排队消息时续跑是否插队优先执行（prepend 队首）；关闭则回到旧的「有排队即让位」 */
  priorityOverQueued: z.boolean().default(true),
  /** B 链软熔断（复读被掐/断流）续跑时改发的引导文本（v1.4）；留空回落 continueText */
  repetitionResumeText: z.string().default(
    "[auto-continue] 复读已熔断。不要重写已有内容，剩余工作用工具落盘，回复只写一行。"
  ),
  /** C 链（v1.4）：轮次关闭但没有任何可见输出/被截断时，是否在本轮内 steer 续跑 */
  watchPrematureStop: z.boolean().default(true),
  /** C 链连续 steer 上限：超过后放行关闭等真人（fail loud） */
  maxPrematureSteers: z.number().step(1).min(1).max(10).default(2),
  /** C 链：静默空停（finish=stop 且无可见文本、无工具调用）的续跑引导文本 */
  prematureResumeText: z.string().default(
    "[auto-continue] 上一条没有可见结果。接着做；做完了就用一行说明。"
  ),
  /** C 链：max-tokens 截断的续跑引导文本 */
  lengthResumeText: z.string().default(
    "[auto-continue] 上一条被长度截断。从断点接着写，不要重写前面。"
  )
});

/** 展开错误链（message/kind/code/cause）成一段可匹配文本 */
function renderError(value, depth = 0) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (depth > 3) return "";
  const parts = [];
  if (typeof value.name === "string") parts.push(value.name);
  if (typeof value.kind === "string") parts.push(value.kind);
  if (typeof value.code === "string" || typeof value.code === "number") parts.push(String(value.code));
  if (typeof value.message === "string") parts.push(value.message);
  const cause = renderError(value.cause ?? value.error, depth + 1);
  if (cause) parts.push(cause);
  if (parts.length === 0) {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return parts.join(" | ");
}

export function apply(ctx, config) {
  // 白名单正则容错编译：无效项跳过；全无效回退默认
  const regexes = [];
  for (const p of config.patterns ?? []) {
    try {
      regexes.push(new RegExp(p, "i"));
    } catch {
      ctx.logger?.warn?.(`auto-continue: 无效正则已跳过: ${p}`);
    }
  }
  if (regexes.length === 0) {
    for (const p of DEFAULT_PATTERNS) regexes.push(new RegExp(p, "i"));
    ctx.logger?.warn?.("auto-continue: patterns 全部无效，已回退默认白名单");
  }

  const hasAgents = ctx.agents !== undefined && typeof ctx.agents.get === "function";
  if (!hasAgents) ctx.logger?.warn?.("auto-continue: agents 服务不可用，插件将以只告警模式空转");

  /** @type {WeakMap<object, {failed: boolean, errorText: string, attempt: number, softStop: object|null, softAttempt: number, prematureSteers: number, resumeSent: boolean, stats: {a: number, b: number, c: number, last: string}, timer: any}>} */
  const states = new WeakMap();

  function stateFor(agent) {
    let state = states.get(agent);
    if (state === undefined) {
      state = {
        failed: false,
        errorText: "",
        attempt: 0,
        softStop: null,
        softAttempt: 0,
        prematureSteers: 0,
        resumeSent: false, // v1.5 互斥槽：本收尾周期已发出一条续跑（followup 或 steer）
        stats: { a: 0, b: 0, c: 0, last: "" },
        timer: null
      };
      states.set(agent, state);
    }
    return state;
  }

  function clearTimer(state) {
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  /** 全量清零（真人接管/否决/干净收尾共用） */
  function resetAll(state) {
    clearTimer(state);
    state.failed = false;
    state.softStop = null;
    state.attempt = 0;
    state.softAttempt = 0;
    state.prematureSteers = 0;
    state.resumeSent = false;
    state.stats = { a: 0, b: 0, c: 0, last: "" };
  }

  function isSubagent(agent) {
    try {
      return agent?.session?.header?.origin === "subagent";
    } catch {
      return false;
    }
  }

  function live(agent) {
    if (!hasAgents) return false;
    try {
      return ctx.agents.get(agent.id) === agent;
    } catch {
      return false;
    }
  }

  /** 当前 turn 的发起 agent（软熔断事件在其 turn 内同步发出；initiator 为 ALS 上下文，覆盖整个异步 turn） */
  function currentInitiator() {
    if (!hasAgents) return undefined;
    try {
      return ctx.agents.currentInitiator?.();
    } catch {
      return undefined;
    }
  }

  /** v1.8：inbox（next-turn / next-step）里已有排队的续跑消息 → 不再叠加，防双发 */
  function inboxHasAutoContinue(agent) {
    try {
      // 逐字段容错：stub/旧运行时可能缺 nextStep；单字段异常按「不存在」处理而非整体否决
      const turn = agent.inbox?.nextTurn;
      const step = agent.inbox?.nextStep;
      return (Array.isArray(turn) && turn.some((m) => m?.source?.kind === "auto-continue"))
        || (Array.isArray(step) && step.some((m) => m?.source?.kind === "auto-continue"));
    } catch {
      return true; // 读不到 inbox 时保守跳过
    }
  }

  /** v1.8：next-turn 排队消息条数（读失败按 0 处理） */
  function queuedTurnCount(agent) {
    try {
      const turn = agent.inbox?.nextTurn;
      return Array.isArray(turn) ? turn.length : 0;
    } catch {
      return 0;
    }
  }

  /** v1.8：立即投递一条续跑。有排队消息 → prepend 插到队首（优先执行）并补唤醒；无排队 → followup 追加+唤醒 */
  function deliverContinue(state, agent, attempt, reason, tag, text) {
    const message = createUserMessage({
      content: [{ type: "text", text: text || config.continueText }],
      source: {
        kind: "auto-continue",
        path: tag,
        attempt,
        reason: String(reason).slice(0, 300)
      }
    });
    const queued = queuedTurnCount(agent);
    let via = "followup";
    try {
      if (config.priorityOverQueued && queued > 0) {
        agent.inbox.prepend("next-turn", message);
        if (typeof agent.wakeDriver === "function") agent.wakeDriver(); // idle 即唤醒；running/maintenance 下安全空转
        via = `插队（prepend 到 ${queued} 条排队消息之前）`;
      } else {
        agent.followup(message);
      }
    } catch (error) {
      ctx.logger?.warn?.(`auto-continue: 投递续跑失败: ${renderError(error) || "unknown"}`);
      return;
    }
    state.resumeSent = true;
    if (tag === "soft") {
      state.softAttempt = attempt;
      state.stats.b += 1;
    } else {
      state.attempt = attempt;
      state.stats.a += 1;
    }
    state.stats.last = String(reason).slice(0, 80);
    ctx.logger?.info?.(
      `auto-continue: 已代发「${text || config.continueText}」（${tag === "soft" ? "软熔断" : "硬失败"} 第 ${attempt} 次，${via}，原因：${String(reason).slice(0, 120)}）`
    );
  }

  function schedule(state, agent, attempt, reason, tag, text) {
    clearTimer(state); // 防叠加：同一 agent 任何时刻至多一个挂起定时器
    const list = config.backoffSeconds.length > 0 ? config.backoffSeconds : [5];
    const seconds = list[Math.min(attempt - 1, list.length - 1)];
    state.timer = setTimeout(() => {
      state.timer = null;
      if (!config.enabled || !live(agent)) return;
      if (agent.status !== "idle") return;
      if (inboxHasAutoContinue(agent)) return; // 已有续跑排队，不叠加
      if (!config.priorityOverQueued && queuedTurnCount(agent) > 0) return; // 旧模式：有排队消息即让位
      if (state.resumeSent) return; // v1.5 互斥：本周期已有续跑在途（如 C 链 steer）
      deliverContinue(state, agent, attempt, reason, tag, text);
    }, seconds * 1000);
  }

  /** 发送前的公共守卫；返回 false 表示放弃本次 */
  function preflight(agent) {
    if (!config.enabled) return false;
    if (ctx.fiber !== undefined && ctx.fiber.state !== 2) return false; // 运行时正在关闭
    if (!live(agent)) return false;
    if (!config.includeSubagents && isSubagent(agent)) {
      ctx.logger?.info?.("auto-continue: 子 agent，默认不自动续跑");
      return false;
    }
    if (inboxHasAutoContinue(agent)) return false;
    if (!config.priorityOverQueued && queuedTurnCount(agent) > 0) return false; // 旧模式：有排队消息即让位
    return true;
  }

  // ① A 链：记录失败（只有白名单内的错误才武装）
  ctx.on("agent/error", ({ agent, error }) => {
    const state = stateFor(agent);
    const text = renderError(error);
    const retryable = regexes.some((re) => re.test(text));
    if (!retryable) {
      ctx.logger?.info?.(
        `auto-continue: 错误不在白名单，不自动续跑（${text.slice(0, 160) || "unclassified"}）`
      );
      return;
    }
    state.failed = true;
    state.errorText = text;
  });

  // ② B 链：anti-repetition 熔断/断流 → 武装软续跑
  ctx.on("anti-repetition/stopped", (info = {}) => {
    if (!config.resumeAfterRepetitionStop) return;
    const agent = currentInitiator();
    if (!agent) return;
    const state = stateFor(agent);
    state.softStop = {
      kind: info.kind || "repetition",
      detector: info.detector || "",
      repeats: info.repeats,
      hadOutput: info.kind === "upstream-silent" ? false : info.hadOutput !== false
    };
  });

  // ③ idle 后择机续跑；只有真正重新开跑（running）才撤防，未知状态忽略
  ctx.on("agent/status", ({ agent, status }) => {
    const state = stateFor(agent);
    if (status === "running") {
      clearTimer(state);
      state.failed = false;
      state.softStop = null;
      state.resumeSent = false; // 重新开跑：本收尾周期结束，互斥槽释放
      return;
    }
    if (status !== "idle") return; // 未来新增状态一律不动

    const silence = state.softStop && (state.softStop.kind === "upstream-silent" || state.softStop.hadOutput === false);
    if (silence) {
      state.failed = false;
      state.softStop = null;
      clearTimer(state);
      ctx.logger?.info?.("auto-continue: 上游无输出，不注入续跑");
      return;
    }
    if (state.softStop?.kind === "repetition" || state.softStop?.kind === "stream-incomplete") state.failed = false;

    if (state.failed) {
      // A 链：硬失败
      if (state.resumeSent) {
        // v1.5 一次性让位：C 链刚在本收尾 steer 过，释放互斥但保留 failed 标记，
        // steered 轮之后若仍失败会在下一轮 idle 自然重试（不吞并重试，只防双发）。
        state.resumeSent = false;
        ctx.logger?.info?.("auto-continue: 本周期已有续跑在途，硬失败链让位");
        return;
      }
      state.failed = false;
      state.softStop = null; // 硬失败续跑会一并接上工作，软标记让位
      if (!preflight(agent)) return;
      const attempt = state.attempt + 1;
      if (attempt > config.maxAttempts) {
        state.attempt = 0;
        state.softAttempt = 0; // v1.3：放弃时两链一起归零，防跨链泄漏
        ctx.logger?.warn?.(
          `auto-continue: 连续 ${config.maxAttempts} 次自动续跑仍失败，放弃等真人介入。最后错误：${state.errorText.slice(0, 200)}`
        );
        return;
      }
      // v1.8：有排队消息时立即插队（退避定时器会被排队消息拉起的 running 撤掉，定时器路径必丢）
      if (config.priorityOverQueued && queuedTurnCount(agent) > 0) {
        deliverContinue(state, agent, attempt, state.errorText, "error", config.continueText);
        return;
      }
      schedule(state, agent, attempt, state.errorText, "error");
      return;
    }

    if (state.softStop !== null) {
      // B 链：软熔断（复读被掐 / 上游断流）
      if (state.resumeSent) {
        // v1.5 一次性让位：C 链刚 steer 过；softStop 标记保留，让位后下一轮 idle 仍可续。
        state.resumeSent = false;
        ctx.logger?.info?.("auto-continue: 本周期已有续跑在途，软熔断链让位");
        return;
      }
      const info = state.softStop;
      state.softStop = null;
      if (!preflight(agent)) return;
      const attempt = state.softAttempt + 1;
      if (attempt > config.maxRepetitionResumes) {
        state.softAttempt = 0;
        state.attempt = 0; // v1.3：放弃时两链一起归零
        ctx.logger?.warn?.(
          `auto-continue: 软熔断自动续跑 ${config.maxRepetitionResumes} 次后仍被掐，放弃等真人介入（${info.kind}${info.detector ? " " + info.detector : ""}）`
        );
        return;
      }
      const reason = info.kind === "stream-incomplete"
        ? "中途断流（已有输出）"
        : `anti-repetition 熔断（${info.detector || info.kind}${info.repeats ? " ×" + info.repeats : ""}）`;
      const resumeText = info.kind === "stream-incomplete"
        ? "[auto-continue] 输出中途断了。不要重写已有内容，剩余工作直接继续。"
        : (String(config.repetitionResumeText || "").trim() || config.continueText);
      // v1.8：有排队消息时立即插队（同 A 链：退避定时器路径在该场景必丢）
      if (config.priorityOverQueued && queuedTurnCount(agent) > 0) {
        deliverContinue(state, agent, attempt, reason, "soft", resumeText);
        return;
      }
      schedule(state, agent, attempt, reason, "soft", resumeText);
      return;
    }

    // 干净收尾：两条计数都归零；本周期有续跑则打一行统计（v1.5）
    if (state.stats.a || state.stats.b || state.stats.c) {
      ctx.logger?.info?.(
        `auto-continue: 本周期续跑统计 agent=${agent.id} 硬失败=${state.stats.a} 软熔断=${state.stats.b} 空停/截断=${state.stats.c} 最后触发=${state.stats.last || "-"}`
      );
    }
    state.attempt = 0;
    state.softAttempt = 0;
    state.resumeSent = false;
    state.stats = { a: 0, b: 0, c: 0, last: "" };
  });

  // ③b C 链（v1.6）：agent/turn-stopping 是 serial 派发，不传 next
  ctx.on("agent/turn-stopping", (payload) => {
    try {
      handleTurnStopping(payload);
    } catch (error) {
      ctx.logger?.warn?.(`auto-continue: turn-stopping 检查失败: ${renderError(error) || "unknown"}`);
    }
  });

  const C_CHAIN_FINISH_KINDS = new Set(["stop", "max-tokens"]);

  /** 读取本 turn 最后一条 assistant/message（尾部倒扫，eventAt 为 O(1) 下标访问） */
  function lastAssistantOfTurn(agent, turn) {
    try {
      for (let seq = agent.session.seq - 1; seq >= 0; seq--) {
        const event = agent.session.eventAt(seq);
        if (!event || event.type !== "assistant/message") continue;
        if (event.data?.turn === turn) return event;
        if (typeof event.data?.turn === "number" && event.data.turn < turn) return undefined;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  /** 从紧凑流记录里取 finish reason kind */
  function finishKindOf(event) {
    const stream = event?.data?.stream;
    if (!Array.isArray(stream)) return undefined;
    for (let i = stream.length - 1; i >= 0; i--) {
      const record = stream[i];
      if (record?.type === "chunk" && record.chunk?.type === "finish") {
        return record.chunk.reason?.kind;
      }
    }
    return undefined;
  }

  function classifyBlocks(event) {
    const content = event?.data?.message?.content;
    const blocks = Array.isArray(content) ? content : [];
    let hasText = false;
    let hasToolCall = false;
    for (const block of blocks) {
      if (block?.type === "text" && String(block.text || "").trim()) hasText = true;
      if (block?.type === "tool-call") hasToolCall = true;
    }
    return { hasText, hasToolCall };
  }

  /** 整段可见正文只有熔断/上游横幅时，不算有效回答，也不再补一轮续跑。 */
  function isFuseOnly(event) {
    const content = event?.data?.message?.content;
    const blocks = Array.isArray(content) ? content : [];
    let text = "";
    for (const block of blocks) {
      if (block?.type === "tool-call") return false;
      if (block?.type === "text") text += String(block.text || "");
    }
    const trimmed = text.trim();
    if (!trimmed) return false;
    return /^\[(upstream|anti-repetition):[\s\S]*\]$/u.test(trimmed);
  }

  function handleTurnStopping({ agent, turn }) {
    if (!config.enabled || !config.watchPrematureStop) return;
    if (ctx.fiber !== undefined && ctx.fiber.state !== 2) return;
    if (!live(agent)) return;
    if (!config.includeSubagents && isSubagent(agent)) return;
    if (inboxHasAutoContinue(agent)) return; // 已有续跑排队/在途，不叠加
    if (!config.priorityOverQueued && queuedTurnCount(agent) > 0) return; // 旧模式：有排队消息即让位
    const state = stateFor(agent);
    const event = lastAssistantOfTurn(agent, turn);
    if (!event) return;
    if (event.data?.interrupted) return; // 主动取消，不插手
    const { hasText, hasToolCall } = classifyBlocks(event);
    if (hasToolCall) return; // 工具/交互收尾（如提问类工具），绝不插手
    if (isFuseOnly(event)) return;
    if (state.softStop && (state.softStop.kind === "upstream-silent" || state.softStop.hadOutput === false)) return;
    const kind = finishKindOf(event);
    if (kind === "stop" && hasText) {
      state.prematureSteers = 0; // 正常带文本收尾：清零
      return;
    }
    if (!C_CHAIN_FINISH_KINDS.has(kind)) return; // aborted/error/tool-calls 不归 C 链管
    const resumeText =
      kind === "max-tokens"
        ? (String(config.lengthResumeText || "").trim() || config.continueText)
        : (String(config.prematureResumeText || "").trim() || config.continueText);
    if (state.prematureSteers >= config.maxPrematureSteers) {
      state.prematureSteers = 0;
      ctx.logger?.warn?.(
        `auto-continue: 连续 ${config.maxPrematureSteers} 次空停/截断续跑仍无输出，放行关闭等真人介入（finish=${kind}，turn=${turn}）`
      );
      return;
    }
    // v1.5：C 链不做互斥检查——in-turn steer 续跑不会再次触发 running，
    // 若在这里检查 resumeSent 会挡死 C 链自身的连续 steer；互斥在 idle 侧一次性让位实现。
    state.prematureSteers += 1;
    try {
      agent.steer(createUserMessage({
        content: [{ type: "text", text: resumeText }],
        source: {
          kind: "auto-continue",
          path: "premature-stop",
          attempt: state.prematureSteers,
          reason: `finish=${kind} turn=${turn}`
        }
      }));
      state.resumeSent = true;
      state.stats.c += 1;
      state.stats.last = `finish=${kind} turn=${turn}`;
      ctx.logger?.info?.(
        `auto-continue: 空停/截断续跑已 steer（finish=${kind}，第 ${state.prematureSteers} 次，turn=${turn}）`
      );
    } catch (error) {
      state.prematureSteers -= 1;
      ctx.logger?.warn?.(`auto-continue: steer 失败: ${renderError(error) || "unknown"}`);
    }
  }

  // ④ v1.8：真人插话默认不再否决（插队机制接手，续跑优先于排队消息）；关闭插队时恢复旧的真人接管重置
  ctx.on("agent/inbox/inserted", ({ agent, message }) => {
    if (message?.source?.kind !== "user") return;
    if (config.priorityOverQueued) return;
    resetAll(stateFor(agent));
  });

  // ⑤ v1.3：用户删掉排队中的 auto-continue 消息 → 视为否决，全量清零
  ctx.on("agent/inbox/discarded", ({ agent, message }) => {
    if (message?.source?.kind !== "auto-continue") return;
    ctx.logger?.info?.("auto-continue: 排队的续跑被移除，视为真人否决，全部清零");
    resetAll(stateFor(agent));
  });

  ctx.logger?.info?.(
    `auto-continue v1.8: enabled=${config.enabled} maxAttempts=${config.maxAttempts} ` +
    `soft=${config.resumeAfterRepetitionStop}/${config.maxRepetitionResumes} ` +
    `premature=${config.watchPrematureStop}/${config.maxPrematureSteers} ` +
    `priorityOverQueued=${config.priorityOverQueued} ` +
    `backoff=[${config.backoffSeconds.join(",")}]s includeSubagents=${config.includeSubagents} ` +
    `patterns=${regexes.length} 条 agentsService=${hasAgents}`
  );
}
