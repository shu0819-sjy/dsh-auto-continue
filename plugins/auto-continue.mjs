/**
 * auto-continue v1.3 — 轮次失败自动续跑（DSH 原生版，思路二次加工自
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
 * 3. 防竞争（goal-round-driver 同款围栏）：发送前复查 agent 仍存活、仍 idle、inbox 无排队、运行时未关闭。
 * 4. 真人接管即重置：inbox 出现真人 user 消息 → 清计数、撤挂起定时器。
 * 5. 子 agent 默认不碰：session.header.origin === "subagent" 的跳过，避免与父级重试打架。
 * 6. 干净收尾即重置：无失败的 idle 把两条计数都归零。
 *
 * v1.3 变更：
 * - 用户在 UI 删掉排队中的 auto-continue「继续」→ 视为真人否决，立即全部清零（不再重发）；
 * - 任一条链到顶放弃时同时重置两条计数器（v1.2 只重置本链，存在跨链计数泄漏）；
 * - 已核实 agent 身份解析的可靠性：agents 服务 initiator 为 AsyncLocalStorage（getStore），
 *   withInitiator 包裹整个异步 turn 生命周期，流消费期间的 currentInitiator() 恒为当前 agent，
 *   软熔断链的 agent 解析无竞态。
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
  "\\b(?:429|500|502|503|504|529)\\b"
];

export const Config = z.object({
  /** 总开关 */
  enabled: z.boolean().default(true),
  /** 自动续跑时代发的文本 */
  continueText: z.string().default("继续"),
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
  includeSubagents: z.boolean().default(false)
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

  /** @type {WeakMap<object, {failed: boolean, errorText: string, attempt: number, softStop: object|null, softAttempt: number, timer: any}>} */
  const states = new WeakMap();

  function stateFor(agent) {
    let state = states.get(agent);
    if (state === undefined) {
      state = { failed: false, errorText: "", attempt: 0, softStop: null, softAttempt: 0, timer: null };
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

  /** inbox 里已有真人消息或我们自己的排队续跑 → 不再插手 */
  function inboxBlocked(agent) {
    try {
      return agent.inbox.nextTurn.some((m) => {
        const kind = m?.source?.kind;
        return kind === "user" || kind === "auto-continue";
      });
    } catch {
      return true; // 读不到 inbox 时保守跳过
    }
  }

  function schedule(state, agent, attempt, reason, tag) {
    clearTimer(state); // 防叠加：同一 agent 任何时刻至多一个挂起定时器
    const list = config.backoffSeconds.length > 0 ? config.backoffSeconds : [5];
    const seconds = list[Math.min(attempt - 1, list.length - 1)];
    state.timer = setTimeout(() => {
      state.timer = null;
      if (!config.enabled || !live(agent)) return;
      if (agent.status !== "idle") return;
      if (inboxBlocked(agent)) return;
      try {
        agent.followup(createUserMessage({
          content: [{ type: "text", text: config.continueText }],
          source: {
            kind: "auto-continue",
            path: tag,
            attempt,
            reason: String(reason).slice(0, 300)
          }
        }));
        if (tag === "soft") state.softAttempt = attempt;
        else state.attempt = attempt;
        ctx.logger?.info?.(
          `auto-continue: 已代发「${config.continueText}」（${tag === "soft" ? "软熔断" : "硬失败"} 第 ${attempt} 次，原因：${String(reason).slice(0, 120)}）`
        );
      } catch (error) {
        ctx.logger?.warn?.(`auto-continue: followup 失败: ${renderError(error) || "unknown"}`);
      }
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
    if (inboxBlocked(agent)) return false;
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
      repeats: info.repeats
    };
  });

  // ③ idle 后择机续跑；只有真正重新开跑（running）才撤防，未知状态忽略
  ctx.on("agent/status", ({ agent, status }) => {
    const state = stateFor(agent);
    if (status === "running") {
      clearTimer(state);
      state.failed = false;
      state.softStop = null;
      return;
    }
    if (status !== "idle") return; // 未来新增状态一律不动

    if (state.failed) {
      // A 链：硬失败
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
      schedule(state, agent, attempt, state.errorText, "error");
      return;
    }

    if (state.softStop !== null) {
      // B 链：软熔断（复读被掐 / 上游断流）
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
      const reason =
        info.kind === "stream-incomplete"
          ? "anti-repetition: 上游流未正常收尾"
          : `anti-repetition 熔断（${info.detector || info.kind}${info.repeats ? " ×" + info.repeats : ""}）`;
      schedule(state, agent, attempt, reason, "soft");
      return;
    }

    // 干净收尾：两条计数都归零
    state.attempt = 0;
    state.softAttempt = 0;
  });

  // ④ 真人插话 → 立即让位（撤定时器、清全部计数与标记）
  ctx.on("agent/inbox/inserted", ({ agent, message }) => {
    if (message?.source?.kind !== "user") return;
    resetAll(stateFor(agent));
  });

  // ⑤ v1.3：用户删掉排队中的 auto-continue 消息 → 视为否决，全量清零
  ctx.on("agent/inbox/discarded", ({ agent, message }) => {
    if (message?.source?.kind !== "auto-continue") return;
    ctx.logger?.info?.("auto-continue: 排队的续跑被移除，视为真人否决，全部清零");
    resetAll(stateFor(agent));
  });

  ctx.logger?.info?.(
    `auto-continue v1.3: enabled=${config.enabled} maxAttempts=${config.maxAttempts} ` +
    `soft=${config.resumeAfterRepetitionStop}/${config.maxRepetitionResumes} ` +
    `backoff=[${config.backoffSeconds.join(",")}]s includeSubagents=${config.includeSubagents} ` +
    `patterns=${regexes.length} 条 agentsService=${hasAgents}`
  );
}
