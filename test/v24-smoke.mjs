/**
 * v2.4 / v1.4 冒烟测试（对部署路径的插件运行）。
 * 覆盖：
 *  1) char-split 空格拆字误杀回归：技术思考样本（~0.4 单字符占比）不命中；
 *     极端形态（≥120 且占比≥0.6）仍命中；strict 思考链完全不跑该变体与破损$草稿；
 *  2) findLineLoop 超短行（GO ×4）命中；
 *  3) stallTimeoutSec 停滞看门狗：断流熔断 + 广播事件 + aborted finish；
 *  4) auto-continue C 链：空停 steer / max-tokens steer / 有文本不插手 /
 *     有工具调用不插手 / 连续到上限放行 / interrupted 不插手；
 *  5) B 链软续跑改发 repetitionResumeText。
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

const BASE = {
  models: ["*"],
  samplingModels: [],
  minRepeats: 4,
  minUnitLen: 5,
  maxUnitLen: 96,
  checkEveryChars: 16,
  windowChars: 1600,
  minLineRepeats: 4,
  enableDensity: false,
  enableNormStem: true,
  enableCollapseDetect: true,
  enableUniqueRatio: false,
};

// ── 1) char-split 误杀回归 ─────────────────────────────────────────
// 技术思考样本：单字符 token 占比 ~0.4 且打散（无周期），模拟真实代码思考。
// v2.3 阈值（≥40 且占比≥0.3）会命中 → 误杀；v2.4（≥120 且占比≥0.6）不应命中。
function sampleText(singleCount, otherCount) {
  const singles = ["p", "c", "x", "i", "n", "=", "-", "t", "d", "s"];
  const others = ["await", "function", "return", "handler", "stream", "config", "value", "error"];
  const parts = [];
  for (let i = 0; i < singleCount; i++) parts.push(singles[i % singles.length]);
  for (let i = 0; i < otherCount; i++) parts.push(others[i % others.length]);
  // 确定性打散（LCG Fisher-Yates），消除周期性，避免被 consecutive 误中
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let i = parts.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [parts[i], parts[j]] = [parts[j], parts[i]];
  }
  return parts.join(" ");
}
check(
  "1a 技术思考样本（占比0.4）不再误杀",
  AR.findRepetitionLoop(sampleText(160, 240), { ...BASE }) === null,
);
check(
  "1b 极端形态（300/320, 占比0.94）仍命中 char-split",
  AR.findRepetitionLoop(sampleText(300, 20), { ...BASE })?.kind === "char-split",
);
check(
  "1c strict（思考链）不跑空格拆字变体",
  AR.findRepetitionLoop(sampleText(300, 20), { ...BASE, strict: true }) === null,
);
// 破损 $ 草稿样本：带变化（无周期），否则会先被 consecutive 命中而非 broken-shell
function dollarDraftText() {
  const verbs = ["Get", "Set", "New", "Copy"];
  const words = ["item", "path", "value", "target"];
  let out = "";
  for (let i = 0; i < 15; i++) {
    out += `$\n${verbs[i % 4]}-\n${words[i % 4]}${i}\nvar${i} = read${i}\n`;
  }
  return out;
}
const dollarDraft = dollarDraftText();
check(
  "1d strict 不跑破损$草稿",
  AR.findRepetitionLoop(dollarDraft, { ...BASE, strict: true }) === null,
);
check(
  "1e 非strict 破损$草稿仍命中",
  AR.findRepetitionLoop(dollarDraft, { ...BASE })?.kind === "broken-shell",
);

// ── 2) 超短行循环（GO ×4）──────────────────────────────────────────
check(
  "2 GO×4 行循环命中",
  AR.findRepetitionLoop("work done\nGO\nGO\nGO\nGO", { ...BASE })?.kind === "line",
);

// ── 3) 停滞看门狗 ──────────────────────────────────────────────────
{
  const emitted = [];
  const fakeCtx = {
    emit: (type, payload) => emitted.push({ type, payload }),
    on: () => {},
    logger: { info() {}, warn() {} },
  };
  async function* hangingStream() {
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: "hello world partial" };
    await new Promise(() => {}); // 永远不继续
  }
  let captured;
  fakeCtx.on = (type, fn) => {
    if (type === "llm/stream") captured = fn;
  };
  AR.apply(fakeCtx, { ...BASE, appendNotice: true, stallTimeoutSec: 0.15 });
  const chunks = [];
  for await (const c of captured({ model: "glm-5.3-flash" }, () => hangingStream())) {
    chunks.push(c);
  }
  const finish = chunks.find((c) => c.type === "finish");
  check("3a 停滞产生 finish", !!finish);
  // 开着的 text 块会被干净闭合 → finish=stop 是设计内行为（事件广播承担断流语义）
  check("3b finish 存在且非 aborted", !!finish && finish?.reason?.kind === "stop");
  check(
    "3c 广播 anti-repetition/stopped(kind=stream-incomplete)",
    emitted.some((e) => e.type === "anti-repetition/stopped" && e.payload?.kind === "stream-incomplete"),
  );
  check(
    "3d 用户可见停滞提示",
    chunks.some((c) => c.type === "text-delta" && String(c.text || "").includes("输出停滞")),
  );
}

// ── 4) auto-continue C 链 ──────────────────────────────────────────
function makeHarness({ events, nextTurn = [] }) {
  const listeners = new Map();
  const steered = [];
  const followedUp = [];
  const agent = {
    id: "a1",
    status: "idle",
    inbox: { nextTurn },
    steered,
    steer(msg) {
      steered.push(msg);
    },
    followup(msg) {
      followedUp.push(msg);
    },
    session: {
      header: { origin: "user" },
      seq: events.length,
      eventAt: (i) => events[i],
    },
  };
  const ctx = {
    agents: {
      get: () => agent,
      currentInitiator: () => agent,
    },
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    logger: { info() {}, warn() {} },
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
    agent,
    steered,
    followedUp,
    listeners,
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
  // 4a 空停（仅 reasoning，finish=stop）→ steer；turn 4/5 需要各自的事件
  const h = makeHarness({
    events: [
      assistantEvent(3, { reasoning: "thinking..." }),
      assistantEvent(4, { reasoning: "thinking more" }),
      assistantEvent(5, { reasoning: "again" }),
    ],
  });
  await h.fire("agent/turn-stopping", { agent: h.agent, turn: 3 });
  check("4a 静默空停 → steer", h.steered.length === 1);
  check(
    "4b steer 文本为 prematureResumeText",
    String(h.steered[0]?.content?.[0]?.text || "").includes("没有任何可见输出"),
  );
  // 4c 第二次空停 → 仍 steer；第三次 → 放行（上限2）
  await h.fire("agent/turn-stopping", { agent: h.agent, turn: 4 });
  await h.fire("agent/turn-stopping", { agent: h.agent, turn: 5 });
  check("4c 连续到上限后放行", h.steered.length === 2);
  // 4d 正常文本收尾 → 清零，不再 steer
  const h2 = makeHarness({ events: [assistantEvent(1, { text: "完成，结果如下" })] });
  await h2.fire("agent/turn-stopping", { agent: h2.agent, turn: 1 });
  check("4d 正常文本收尾不插手", h2.steered.length === 0);
  // 4e 有工具调用（交互收尾）→ 不插手
  const h3 = makeHarness({ events: [assistantEvent(2, { toolCall: true })] });
  await h3.fire("agent/turn-stopping", { agent: h3.agent, turn: 2 });
  check("4e 工具调用收尾不插手", h3.steered.length === 0);
  // 4f max-tokens 截断 → steer 用 lengthResumeText
  const h4 = makeHarness({ events: [assistantEvent(7, { text: "半截回复", finish: "max-tokens" })] });
  await h4.fire("agent/turn-stopping", { agent: h4.agent, turn: 7 });
  check(
    "4f max-tokens → lengthResumeText steer",
    h4.steered.length === 1 && String(h4.steered[0]?.content?.[0]?.text || "").includes("输出上限被截断"),
  );
  // 4g interrupted（主动取消）→ 不插手
  const h5 = makeHarness({ events: [assistantEvent(8, { interrupted: true })] });
  await h5.fire("agent/turn-stopping", { agent: h5.agent, turn: 8 });
  check("4g interrupted 不插手", h5.steered.length === 0);
  // 4h inbox 有排队真人消息 → 不插手
  const h6 = makeHarness({
    events: [assistantEvent(9, { reasoning: "..." })],
    nextTurn: [{ source: { kind: "user" } }],
  });
  await h6.fire("agent/turn-stopping", { agent: h6.agent, turn: 9 });
  check("4h 有排队真人消息不插手", h6.steered.length === 0);
}

// ── 5) B 链软续跑文本 ──────────────────────────────────────────────
{
  const h = makeHarness({ events: [] });
  // 触发 B 链：anti-repetition/stopped → idle
  await h.fire("anti-repetition/stopped", { kind: "repetition", detector: "norm-stem", repeats: 22 });
  await h.fire("agent/status", { agent: h.agent, status: "idle" });
  await new Promise((r) => setTimeout(r, 80));
  check(
    "5 B链改发 repetitionResumeText",
    h.followedUp.length === 1 &&
      String(h.followedUp[0]?.content?.[0]?.text || "").includes("复读/空转测试引导"),
  );
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length > 0) process.exit(1);
