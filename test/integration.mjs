/**
 * auto-continue + anti-repetition 真实 cordis 运行时集成测试。
 * 用 DSH 同款 @deepseek-ai/cordis 内核（provide/plugin/waterfall/emit 全真），
 * 不 Mock 事件总线——验证：waterfall 拦截链、跨插件事件、inject 服务解析、Config 经运行时注入。
 * 运行（仓库根目录）：node test/integration.mjs
 *
 * 插件默认取仓库 ../plugins/；可用 DSH_PLUGINS_DIR 覆盖。
 * cordis 按候选探测：DSH_HOME 上级 node_modules → 本机常见安装路径 → 清晰中文报错。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { requireDshNodeModules } from "./_dsh-env.mjs";

const dshNm = requireDshNodeModules();
register(new URL("./_dsh-resolve-hook.mjs", import.meta.url));

function resolvePluginUrl(filename) {
  if (process.env.DSH_PLUGINS_DIR) {
    return pathToFileURL(join(process.env.DSH_PLUGINS_DIR, filename)).href;
  }
  return new URL(`../plugins/${filename}`, import.meta.url).href;
}

/** 探测 @deepseek-ai/cordis 入口；候选含发现/回退路径 */
function resolveCordisUrl() {
  const candidates = [
    join(dshNm, "@deepseek-ai", "cordis", "lib", "index.js")
  ];
  if (process.env.DSH_HOME) {
    candidates.push(
      join(process.env.DSH_HOME, "..", "node_modules", "@deepseek-ai", "cordis", "lib", "index.js"),
      join(process.env.DSH_HOME, "node_modules", "@deepseek-ai", "cordis", "lib", "index.js")
    );
  }
  // 发现/回退候选（本机常见 DSH 安装位置）
  candidates.push(
    join("D:", "DeepSeek-Harness", "node_modules", "@deepseek-ai", "cordis", "lib", "index.js")
  );

  for (const c of candidates) {
    if (existsSync(c)) return pathToFileURL(c).href;
  }
  console.error("需在装有 DSH 的机器上运行，可用 DSH_HOME 指定数据目录");
  process.exit(1);
}

const { Context } = await import(resolveCordisUrl());
const antiRep = await import(resolvePluginUrl("anti-repetition.mjs"));
const autoCont = await import(resolvePluginUrl("auto-continue.mjs"));

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  << " + detail}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ① 建真实 cordis 根上下文，提供 mock agents 服务（生产里由 dsh-agent 提供）
  const ctx = new Context();
  const agentsMap = new Map();
  const ref = { current: null };
  ctx.provide("agents", {
    get: (id) => agentsMap.get(id),
    currentInitiator: () => ref.current
  });

  // ② 以生产方式加载两个插件（partial config，Config 由运行时经 schema 解析）
  ctx.plugin(antiRep, { injectSamplingParams: false });
  ctx.plugin(autoCont, { backoffSeconds: [0.02, 0.02, 0.02] });
  await sleep(80); // 等 fiber 启动完成

  // ③ 假 agent + 假 LLM 流：80 个相同字符 → anti-repetition 必然熔断
  const sent = [];
  const agent = {
    id: "it1",
    status: "idle",
    session: { header: {} },
    inbox: { nextTurn: [] },
    followup(msg) { sent.push(msg); }
  };
  agentsMap.set("it1", agent);

  const raw = (async function* () {
    yield { type: "block-start", index: 0, blockType: "text" };
    yield { type: "text-delta", index: 0, text: "啊".repeat(80) };
    yield { type: "text-delta", index: 0, text: "这段不该出现" };
    yield { type: "finish", reason: { kind: "stop" } };
  })();

  // ④ 走真实 waterfall 链（与 dsh-llm 同款调用形态）
  ref.current = agent; // 生产中由 withInitiator 的 ALS 保证；mock 直接指定
  const guarded = ctx.waterfall({}, "llm/stream", { model: "glm-5.3-flash" }, () => raw);
  const chunks = [];
  for await (const c of guarded) chunks.push(c);

  const finishChunk = chunks.find((c) => c.type === "finish");
  const allText = chunks.filter((c) => c.type === "text-delta").map((c) => c.text).join("");
  check("I1 熔断收尾 finish:stop", finishChunk?.reason?.kind === "stop", JSON.stringify(finishChunk?.reason));
  check("I2 流被截断", !allText.includes("这段不该出现"), allText.slice(-40));
  check("I3 用户可见提示已追加", allText.includes("[anti-repetition:"));

  // ⑤ 软熔断链端到端：事件总线 → auto-continue → followup
  ctx.emit("agent/status", { agent, status: "idle" });
  await sleep(200);
  check(
    "I4 软熔断自动续跑（跨插件事件）",
    sent.length === 1 && sent[0].source.kind === "auto-continue" && sent[0].source.path === "soft" &&
    String(sent[0].source.reason).includes("anti-repetition"),
    JSON.stringify(sent)
  );

  // ⑥ 硬失败链端到端
  ctx.emit("agent/error", { agent, error: new Error("Request timed out.") });
  ctx.emit("agent/status", { agent, status: "idle" });
  await sleep(200);
  check(
    "I5 硬失败自动续跑",
    sent.length === 2 && sent[1].source.path === "error" && sent[1].source.attempt === 1,
    JSON.stringify(sent)
  );

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n=== 集成测试 ${results.length - failed}/${results.length} 通过 ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("集成测试崩溃:", e);
  process.exit(1);
});
