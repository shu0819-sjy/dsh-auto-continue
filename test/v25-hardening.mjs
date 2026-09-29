/**
 * v2.5 / v1.5 加固回归（对部署路径的插件运行）。
 * 覆盖（采纳的外部评审项）：
 *  #1 互斥槽：C 链 steer 后 A/B 链让位；A/B followup 后 C 链让位；running 释放互斥；
 *  #3 统计行：干净 idle 打一行续跑统计，且只打一次；
 *  #5 fetch 惩罚注入热更新安全：install/dispose 任意交错顺序下注入存活、最终还原；
 *  #6 guardStream 导出：合成流回归 consecutive 熔断 / 上游截断 aborted / tool-call 半截块
 *     aborted / 思考链 strict 不误杀。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

function resolvePluginUrl(filename) {
  const pluginsDir = process.env.DSH_PLUGINS_DIR;
  if (pluginsDir) return pathToFileURL(join(pluginsDir, filename)).href;
  const localUrl = new URL(`../plugins/${filename}`, import.meta.url);
  if (existsSync(localUrl)) return localUrl.href;
  throw new Error("找不到插件目录，请设置 DSH_PLUGINS_DIR");
}

const AR = await import(resolvePluginUrl("anti-repetition.mjs"));
const AC = await import(resolvePluginUrl("auto-continue.mjs"));

const results = [];
function check(name, cond) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
}

// ── #6 guardStream 合成流回归 ───────────────────────────────────────
{
  // 1a consecutive 复读：text 块内连打重复单元 → 熔断，干净闭合 finish=stop + 可见 notice
  const stopped = [];
  async function* repStream() {
    yield { type: "block-start", index: 0, blockType: "text" };
    for (let i = 0; i < 8; i++) {
      yield { type: "text-delta", index: 0, text: "allons-y " };
    }
    yield { type: "finish", reason: { kind: "stop" } }; // 永远到不了
  }
  const chunks1 = [];
  for await (const c of AR.guardStream(repStream(), {
    minRepeats: 3, minUnitLen: 5, maxUnitLen: 96, windowChars: 1600,
    minLineRepeats: 3, checkEveryChars: 4, appendNotice: true,
    noticeText: "\n\n[anti-repetition: 检测到复读循环，已自动停止，通常将自动续跑。]",
    enableNormStem: true, enableCollapseDetect: true, stallTimeoutSec: 0,
  }, (info) => stopped.push(info))) {
    chunks1.push(c);
  }
  const fin1 = chunks1.find((c) => c.type === "finish");
  check("1a consecutive 熔断产生 finish=stop", !!fin1 && fin1.reason?.kind === "stop");
  check("1a 广播 kind=repetition detector=consecutive",
    stopped.length === 1 && stopped[0].kind === "repetition" && stopped[0].detector === "consecutive");
  check("1a 用户可见 notice（含检测器名）",
    chunks1.some((c) => c.type === "text-delta" && String(c.text || "").includes("已自动停止")
      && String(c.text || "").includes("consecutive")));

  // 1b 上游流未收尾（无 finish chunk 就结束）→ aborted STREAM_INCOMPLETE
  async function* truncStream() {
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: "正常内容一半" };
  }
  const stopped2 = [];
  const chunks2 = [];
  for await (const c of AR.guardStream(truncStream(), {
    minRepeats: 3, minUnitLen: 5, maxUnitLen: 96, windowChars: 1600, minLineRepeats: 3,
    checkEveryChars: 4, appendNotice: true, stallTimeoutSec: 0,
  }, (info) => stopped2.push(info))) {
    chunks2.push(c);
  }
  const fin2 = chunks2.find((c) => c.type === "finish");
  check("1b 上游截断 → aborted STREAM_INCOMPLETE",
    !!fin2 && fin2.reason?.kind === "aborted" && fin2.reason?.failure?.code === "STREAM_INCOMPLETE");
  check("1b 广播 kind=stream-incomplete", stopped2[0]?.kind === "stream-incomplete");

  // 1c 复读时 tool-call 块还开着 → aborted REPETITION_LOOP（半截块无法安全闭合）
  async function* repWithTool() {
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: "x" };
    yield { type: "block-start", index: 1, blockType: "tool-call" };
    for (let i = 0; i < 8; i++) {
      yield { type: "text-delta", index: 0, text: "allons-y " };
    }
  }
  const chunks3 = [];
  for await (const c of AR.guardStream(repWithTool(), {
    minRepeats: 3, minUnitLen: 5, maxUnitLen: 96, windowChars: 1600, minLineRepeats: 3,
    checkEveryChars: 4, appendNotice: false, stallTimeoutSec: 0,
  }, () => {})) {
    chunks3.push(c);
  }
  const fin3 = chunks3.find((c) => c.type === "finish");
  check("1c tool-call 半截块 → aborted REPETITION_LOOP",
    !!fin3 && fin3.reason?.kind === "aborted" && fin3.reason?.failure?.code === "REPETITION_LOOP");

  // 1d 思考链 strict：极端 char-split 样本不误杀（流正常收尾）
  function sampleText(singleCount, otherCount) {
    const singles = ["p", "c", "x", "i", "n", "=", "-", "t", "d", "s"];
    const others = ["await", "function", "return", "handler", "stream", "config", "value", "error"];
    const parts = [];
    for (let i = 0; i < singleCount; i++) parts.push(singles[i % singles.length]);
    for (let i = 0; i < otherCount; i++) parts.push(others[i % others.length]);
    let seed = 42;
    const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let i = parts.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [parts[i], parts[j]] = [parts[j], parts[i]];
    }
    return parts.join(" ");
  }
  const reasoningChunks = sampleText(300, 20).match(/.{1,40}/g) || [];
  const stopped4 = [];
  async function* reasoningStream() {
    yield { type: "block-start", index: 0, blockType: "reasoning" };
    for (const part of reasoningChunks) {
      yield { type: "reasoning-delta", index: 0, text: part + " " };
    }
    yield { type: "block-end", index: 0, block: { type: "reasoning", text: "done" } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
  const chunks4 = [];
  for await (const c of AR.guardStream(reasoningStream(), {
    minRepeats: 3, minUnitLen: 5, maxUnitLen: 96, windowChars: 1600, minLineRepeats: 3,
    checkEveryChars: 16, appendNotice: true, watchReasoning: true,
    enableNormStem: true, enableCollapseDetect: true, stallTimeoutSec: 0,
  }, (info) => stopped4.push(info))) {
    chunks4.push(c);
  }
  const fin4 = chunks4.find((c) => c.type === "finish");
  check("1d strict 思考链不误杀极端 char-split",
    !!fin4 && fin4.reason?.kind === "stop" && stopped4.length === 0);
}

// ── #5 fetch 惩罚注入：热更新安全（引用计数） ────────────────────────
{
  const realFetch = globalThis.fetch;
  const calls = [];
  const spyOriginal = async (input, init = {}) => {
    calls.push({ url: typeof input === "string" ? input : input?.url || "", init });
    return { ok: true, status: 200 };
  };

  function makeCtx(inject, penalty) {
    const listeners = new Map();
    return {
      ctx: {
        on(type, fn) {
          if (!listeners.has(type)) listeners.set(type, []);
          listeners.get(type).push(fn);
        },
        emit() {},
        logger: { info() {}, warn() {} },
      },
      config: {
        injectSamplingParams: inject,
        samplingModels: ["*glm*"],
        frequencyPenalty: penalty,
        presencePenalty: 0.4,
      },
      dispose() {
        for (const fn of listeners.get("dispose") || []) fn();
      },
    };
  }

  const chatBody = (model) =>
    JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] });

  // 惩罚注入在请求体内部（patch 只替换 body），断言须解析 body
  const bodyPenalty = (call) => {
    try { return JSON.parse(call?.init?.body || "{}").frequency_penalty; } catch { return undefined; }
  };

  try {
    globalThis.fetch = spyOriginal;
    const a = makeCtx(true, 0.55);
    const b = makeCtx(true, 0.9);

    // 2a 安装即注入
    AR.apply(a.ctx, a.config);
    await globalThis.fetch("https://gw/v1/chat/completions", { method: "POST", body: chatBody("glm-5.3-flash") });
    check("2a 安装后 chat 请求注入 penalty", bodyPenalty(calls.at(-1)) === 0.55);

    // 2b 非 chat 路径不注入
    await globalThis.fetch("https://gw/v1/embeddings", { method: "POST", body: chatBody("glm-5.3-flash") });
    check("2b 非 chat 路径不注入", bodyPenalty(calls.at(-1)) === undefined);

    // 2c 热改竞态主场景：新实例先 apply，旧实例后 dispose → 注入不失效
    AR.apply(b.ctx, b.config); // 新配置 penalty=0.9 接管
    await globalThis.fetch("https://gw/v1/chat/completions", { method: "POST", body: chatBody("glm-5.3-flash") });
    check("2c 新实例接管后用新配置", bodyPenalty(calls.at(-1)) === 0.9);
    a.dispose(); // 旧实例才 dispose —— 朴素实现会在这里把新 wrapper 冲掉
    await globalThis.fetch("https://gw/v1/chat/completions", { method: "POST", body: chatBody("glm-5.3-flash") });
    check("2c 旧实例 dispose 后注入仍存活（新配置）", bodyPenalty(calls.at(-1)) === 0.9);
    check("2c 旧实例 dispose 后 fetch 仍是 wrapper", globalThis.fetch !== spyOriginal);
    b.dispose();
    check("2c 全部 dispose 后 fetch 还原", globalThis.fetch === spyOriginal);
    await globalThis.fetch("https://gw/v1/chat/completions", { method: "POST", body: chatBody("glm-5.3-flash") });
    check("2c 还原后不再注入", bodyPenalty(calls.at(-1)) === undefined);

    // 2d 正常顺序：dispose-old → install-new
    const c1 = makeCtx(true, 0.55);
    const c2 = makeCtx(true, 0.9);
    AR.apply(c1.ctx, c1.config);
    c1.dispose();
    check("2d 单实例 dispose 即还原", globalThis.fetch === spyOriginal);
    AR.apply(c2.ctx, c2.config);
    await globalThis.fetch("https://gw/v1/chat/completions", { method: "POST", body: chatBody("glm-5.3-flash") });
    check("2d 还原后重装注入正常", bodyPenalty(calls.at(-1)) === 0.9);
    c2.dispose();
    check("2d 最终还原", globalThis.fetch === spyOriginal);

    // 2e 注入开关关闭时不装 wrapper
    const d1 = makeCtx(false, 0.55);
    AR.apply(d1.ctx, d1.config);
    check("2e injectSamplingParams=false 不装 wrapper", globalThis.fetch === spyOriginal);
    d1.dispose();
  } finally {
    globalThis.fetch = realFetch;
  }
}

// ── #1 互斥槽 + #3 统计行（auto-continue） ──────────────────────────
function makeHarness({ events, nextTurn = [] } = {}) {
  const listeners = new Map();
  const steered = [];
  const followedUp = [];
  const logs = [];
  const agent = {
    id: "a1",
    status: "idle",
    inbox: { nextTurn },
    steer(msg) { steered.push(msg); },
    followup(msg) { followedUp.push(msg); },
    session: {
      header: { origin: "user" },
      seq: events.length,
      eventAt: (i) => events[i],
    },
  };
  const ctx = {
    agents: { get: () => agent, currentInitiator: () => agent },
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    logger: {
      info(...args) { logs.push(args.join(" ")); },
      warn(...args) { logs.push(args.join(" ")); },
    },
    fiber: { state: 2 },
  };
  AC.apply(ctx, {
    enabled: true,
    continueText: "继续",
    repetitionResumeText: "[auto-continue] 复读/空转测试引导",
    prematureResumeText: "[auto-continue] 没有任何可见输出的情况下结束了（测试版）",
    lengthResumeText: "[auto-continue] 输出上限被截断（测试版）",
    resumeAfterRepetitionStop: true,
    backoffSeconds: [0.01],
    watchPrematureStop: true,
    maxPrematureSteers: 2,
  });
  return {
    agent, steered, followedUp, logs, listeners,
    async fire(type, payload, next = async () => {}) {
      for (const fn of listeners.get(type) || []) {
        const out = fn(payload, next);
        if (out && typeof out.then === "function") await out;
      }
    },
  };
}

function assistantEvent(turn, { text = "", reasoning = "", toolCall = false, finish = "stop", interrupted } = {}) {
  const content = [];
  if (reasoning) content.push({ type: "reasoning", text: reasoning });
  if (text) content.push({ type: "text", text });
  if (toolCall) content.push({ type: "tool-call", id: "c1", name: "pwsh", arguments: "{}" });
  const stream = [{ type: "chunk", chunk: { type: "finish", reason: { kind: finish } } }];
  return { type: "assistant/message", data: { turn, step: 1, message: { role: "assistant", content }, stream, interrupted } };
}

{
  // 3a C 链 steer 后，同收尾 idle 上武装的 B 链一次性让位（不双发）
  const h = makeHarness({
    events: [assistantEvent(1, { reasoning: "..." }), assistantEvent(2, { reasoning: "..." })],
  });
  await h.fire("anti-repetition/stopped", { kind: "repetition", detector: "norm-stem", repeats: 22 });
  await h.fire("agent/turn-stopping", { agent: h.agent, turn: 1 }); // C 链 steer
  await h.fire("agent/status", { agent: h.agent, status: "idle" }); // B 链武装 → 让位一次
  await new Promise((r) => setTimeout(r, 80));
  check("3a C 链 steer 后 B 链让位（不双发）", h.steered.length === 1 && h.followedUp.length === 0);
  check("3a 让位有日志", h.logs.some((l) => l.includes("软熔断链让位")));

  // 3b 让位后互斥即释放：steered 轮再空停 → C 链自身可连续 steer（in-turn 不触发 running）
  await h.fire("agent/status", { agent: h.agent, status: "running" });
  await h.fire("agent/turn-stopping", { agent: h.agent, turn: 2 });
  check("3b running 释放后 C 链可再 steer", h.steered.length === 2);

  // 3c B 链 followup 属上一周期：其后续 turn 空停时 C 链正常接管（新收尾周期，非双发）
  const h2 = makeHarness({
    events: [assistantEvent(1, { reasoning: "..." }), assistantEvent(2, { reasoning: "..." })],
  });
  await h2.fire("anti-repetition/stopped", { kind: "repetition", detector: "norm-stem", repeats: 22 });
  await h2.fire("agent/status", { agent: h2.agent, status: "idle" });
  await new Promise((r) => setTimeout(r, 80));
  check("3c B 链正常 followup", h2.followedUp.length === 1);
  await h2.fire("agent/status", { agent: h2.agent, status: "running" });
  await h2.fire("agent/turn-stopping", { agent: h2.agent, turn: 2 });
  check("3c followup 轮空停 → C 链接管", h2.steered.length === 1);

  // 3d 统计行：完成周期后打一行统计，只打一次
  await h2.fire("agent/status", { agent: h2.agent, status: "running" }); // 开跑（释放互斥）
  await h2.fire("agent/status", { agent: h2.agent, status: "idle" }); // 干净收尾 → 统计
  const statLines = h2.logs.filter((l) => l.includes("本周期续跑统计"));
  check("3d 干净 idle 打统计行（软熔断=1 空停=1）",
    statLines.length === 1 && statLines[0].includes("软熔断=1") && statLines[0].includes("空停/截断=1"));
  await h2.fire("agent/status", { agent: h2.agent, status: "idle" }); // 再 idle 不重复
  check("3d 统计只打一次", h2.logs.filter((l) => l.includes("本周期续跑统计")).length === 1);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
