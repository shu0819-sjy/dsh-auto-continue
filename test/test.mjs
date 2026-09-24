/**
 * auto-continue 插件单测（Mock 事件流，不启动 DSH）
 * 运行（仓库根目录）：node test/test.mjs
 *
 * 被测插件默认取仓库 ../plugins/；可用 DSH_PLUGINS_DIR 覆盖为已安装副本目录。
 * 插件依赖 @deepseek-ai/* 经 resolve hook 从 DSH node_modules 解析。
 */
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { requireDshNodeModules } from "./_dsh-env.mjs";

requireDshNodeModules();
register(new URL("./_dsh-resolve-hook.mjs", import.meta.url));

function resolvePluginUrl(filename) {
  if (process.env.DSH_PLUGINS_DIR) {
    return pathToFileURL(join(process.env.DSH_PLUGINS_DIR, filename)).href;
  }
  return new URL(`../plugins/${filename}`, import.meta.url).href;
}

const { apply, Config } = await import(resolvePluginUrl("auto-continue.mjs"));

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  << " + detail}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 构造一个 Mock 运行时 */
function makeEnv({ backoff = [0.02, 0.02, 0.02], fiberState = 2, config = {} } = {}) {
  const handlers = new Map();
  const sent = [];
  const agents = new Map();
  const ref = { current: null }; // currentInitiator 模拟
  const ctx = {
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(fn);
    },
    logger: {
      info() {},
      warn() {}
    },
    agents: {
      get: (id) => (agents.has(id) ? agents.get(id) : undefined),
      currentInitiator: () => ref.current
    },
    fiber: { state: fiberState }
  };
  function makeAgent(id, { origin } = {}) {
    const agent = {
      id,
      status: "idle",
      session: { header: origin ? { origin } : {} },
      inbox: { nextTurn: [] },
      followup(msg) {
        sent.push({ agentId: id, msg });
      }
    };
    agents.set(id, agent);
    return agent;
  }
  apply(ctx, { ...Config(config), backoffSeconds: backoff }); // 与生产一致：先过 schema 补默认值
  const emit = (name, payload) => {
    for (const fn of handlers.get(name) ?? []) fn(payload);
  };
  const fail = (agent, text = "Request timed out.") => emit("agent/error", { agent, error: new Error(text) });
  const idle = (agent) => emit("agent/status", { agent, status: "idle" });
  const run = (agent) => emit("agent/status", { agent, status: "running" });
  const userMsg = (agent) => emit("agent/inbox/inserted", { agent, message: { source: { kind: "user" } } });
  const softStop = (agent, info = { kind: "repetition", detector: "consecutive", repeats: 4 }) => {
    ref.current = agent;
    emit("anti-repetition/stopped", info);
  };
  return { ctx, agents, sent, makeAgent, emit, fail, idle, run, userMsg, softStop, tick: () => sleep(120) };
}

const sendsFor = (env, id) => env.sent.filter((s) => s.agentId === id);

async function main() {
  // T0 schema 默认值
  try {
    const cfg = Config({});
    check(
      "T0 schema 默认值",
      cfg.continueText === "继续" && cfg.maxAttempts === 3 && cfg.maxRepetitionResumes === 2 &&
      cfg.resumeAfterRepetitionStop === true && Array.isArray(cfg.patterns) && cfg.patterns.length >= 12
    );
  } catch (e) {
    check("T0 schema 默认值", false, String(e));
  }

  // T1 超时白名单 → 自动发一次「继续」
  {
    const env = makeEnv();
    const a = env.makeAgent("s1");
    env.fail(a);
    env.idle(a);
    await env.tick();
    const s = sendsFor(env, "s1");
    check("T1 超时错误自动续跑一次", s.length === 1 && s[0].msg.source.kind === "auto-continue" && s[0].msg.source.attempt === 1 && s[0].msg.content[0].text === "继续" && s[0].msg.source.path === "error", JSON.stringify(s));
  }

  // T2 连续 4 轮失败 → 只发 3 次，第 4 轮放弃
  {
    const env = makeEnv();
    const a = env.makeAgent("s2");
    for (let i = 0; i < 4; i++) {
      env.fail(a);
      env.idle(a);
      await env.tick();
    }
    const s = sendsFor(env, "s2");
    check("T2 连续失败 3 次到顶放弃", s.length === 3 && s[2].msg.source.attempt === 3, `实际发送 ${s.length} 次`);
  }

  // T3 放弃后新一轮失败从头计数
  {
    const env = makeEnv();
    const a = env.makeAgent("s3");
    for (let i = 0; i < 4; i++) {
      env.fail(a);
      env.idle(a);
      await env.tick();
    }
    env.fail(a, "fetch failed");
    env.idle(a);
    await env.tick();
    const s = sendsFor(env, "s3");
    check("T3 放弃后重新计数", s.length === 4 && s[3].msg.source.attempt === 1, JSON.stringify(s.map((x) => x.msg.source.attempt)));
  }

  // T4 非白名单错误不续跑
  {
    const env = makeEnv();
    const a = env.makeAgent("s4");
    env.fail(a, "Invalid API key: unauthorized 401");
    env.idle(a);
    await env.tick();
    check("T4 非白名单错误不动", sendsFor(env, "s4").length === 0);
  }

  // T5 真人插话撤销挂起的续跑
  {
    const env = makeEnv();
    const a = env.makeAgent("s5");
    env.fail(a);
    env.idle(a); // 定时器已挂起
    env.userMsg(a);
    await env.tick();
    check("T5 真人插话立即让位", sendsFor(env, "s5").length === 0);
  }

  // T6 子 agent 默认不碰（硬失败链）
  {
    const env = makeEnv();
    const a = env.makeAgent("sub1", { origin: "subagent" });
    env.fail(a);
    env.idle(a);
    await env.tick();
    check("T6 子 agent 跳过", sendsFor(env, "sub1").length === 0);
  }

  // T7 inbox 已有排队真人消息时不插手
  {
    const env = makeEnv();
    const a = env.makeAgent("s7");
    a.inbox.nextTurn.push({ source: { kind: "user" } });
    env.fail(a);
    env.idle(a);
    await env.tick();
    check("T7 inbox 被占用时不发", sendsFor(env, "s7").length === 0);
  }

  // T8 重新开跑（running）即撤防
  {
    const env = makeEnv();
    const a = env.makeAgent("s8");
    env.fail(a);
    env.run(a);
    env.idle(a);
    await env.tick();
    check("T8 running 撤防", sendsFor(env, "s8").length === 0);
  }

  // T9 无效正则容错
  {
    const env1 = makeEnv({ config: { patterns: ["([bad"] } });
    const a1 = env1.makeAgent("s9a");
    env1.fail(a1);
    env1.idle(a1);
    await env1.tick();
    check("T9a 全无效正则回退默认", sendsFor(env1, "s9a").length === 1);

    const env2 = makeEnv({ config: { patterns: ["([bad", "fetch failed"] } });
    const a2 = env2.makeAgent("s9b");
    env2.fail(a2, "Invalid API key");
    env2.idle(a2);
    await env2.tick();
    env2.fail(a2, "fetch failed");
    env2.idle(a2);
    await env2.tick();
    check("T9b 无效项跳过有效项保留", sendsFor(env2, "s9b").length === 1);
  }

  // T10 干净收尾后计数归零
  {
    const env = makeEnv();
    const a = env.makeAgent("s10");
    env.fail(a);
    env.idle(a);
    await env.tick();
    env.run(a);
    env.idle(a); // 干净收尾
    env.fail(a);
    env.idle(a);
    await env.tick();
    const s = sendsFor(env, "s10");
    check("T10 干净收尾重新计数", s.length === 2 && s[1].msg.source.attempt === 1, JSON.stringify(s.map((x) => x.msg.source.attempt)));
  }

  // T11 运行时关闭中不发送
  {
    const env = makeEnv({ fiberState: 1 });
    const a = env.makeAgent("s11");
    env.fail(a);
    env.idle(a);
    await env.tick();
    check("T11 关闭中不发送", sendsFor(env, "s11").length === 0);
  }

  // T12 agent 已销毁不发送
  {
    const env = makeEnv();
    const a = env.makeAgent("s12");
    env.fail(a);
    env.idle(a);
    env.agents.delete("s12"); // 模拟 disposed
    await env.tick();
    check("T12 已销毁不发送", sendsFor(env, "s12").length === 0);
  }

  // T13 重复调度不叠加（错误-空闲-错误-空闲 连击只发一条）
  {
    const env = makeEnv();
    const a = env.makeAgent("s13");
    env.fail(a);
    env.idle(a);
    env.fail(a);
    env.idle(a);
    await env.tick();
    const s = sendsFor(env, "s13");
    check("T13 定时器不叠加", s.length === 1 && s[0].msg.source.attempt === 1, `实际发送 ${s.length} 次`);
  }

  // T14 被拦下的调度不消耗次数
  {
    const env = makeEnv();
    const a = env.makeAgent("s14");
    env.fail(a);
    env.idle(a); // 调度挂起
    env.userMsg(a); // 撤销
    env.fail(a); // 再次失败
    env.idle(a);
    await env.tick();
    const s = sendsFor(env, "s14");
    check("T14 被拦调度不耗次数", s.length === 1 && s[0].msg.source.attempt === 1, JSON.stringify(s.map((x) => x.msg.source.attempt)));
  }

  // T15 undici 风格超时（TimeoutError / aborted due to timeout）命中白名单
  {
    const env = makeEnv();
    const a = env.makeAgent("s15");
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    env.emit("agent/error", { agent: a, error: err });
    env.idle(a);
    await env.tick();
    check("T15 TimeoutError 样式命中", sendsFor(env, "s15").length === 1);
  }

  // T16 软熔断：复读被掐自动续，2 次到顶放弃，新一轮重新计数
  {
    const env = makeEnv();
    const a = env.makeAgent("s16");
    for (let i = 0; i < 3; i++) {
      env.softStop(a);
      env.idle(a);
      await env.tick();
    }
    env.softStop(a);
    env.idle(a);
    await env.tick();
    const s = sendsFor(env, "s16");
    check(
      "T16 软熔断 2 次到顶 + 重新计数",
      s.length === 3 && s[0].msg.source.path === "soft" && s[0].msg.source.attempt === 1 &&
      s[1].msg.source.attempt === 2 && s[2].msg.source.attempt === 1 &&
      String(s[0].msg.source.reason).includes("anti-repetition"),
      JSON.stringify(s.map((x) => [x.msg.source.path, x.msg.source.attempt]))
    );
  }

  // T17 软熔断被真人插话撤销 + 计数重置
  {
    const env = makeEnv();
    const a = env.makeAgent("s17");
    env.softStop(a);
    env.idle(a);
    env.userMsg(a);
    await env.tick();
    env.softStop(a);
    env.idle(a);
    await env.tick();
    const s = sendsFor(env, "s17");
    check("T17 软熔断真人让位 + 重新计数", s.length === 1 && s[0].msg.source.attempt === 1, JSON.stringify(s.map((x) => x.msg.source.attempt)));
  }

  // T18 软熔断在子 agent 上不触发
  {
    const env = makeEnv();
    const a = env.makeAgent("sub18", { origin: "subagent" });
    env.softStop(a);
    env.idle(a);
    await env.tick();
    check("T18 子 agent 软熔断跳过", sendsFor(env, "sub18").length === 0);
  }

  // T19 ECONNABORTED 命中白名单
  {
    const env = makeEnv();
    const a = env.makeAgent("s19");
    env.fail(a, "fetch failed: ECONNABORTED");
    env.idle(a);
    await env.tick();
    check("T19 ECONNABORTED 命中", sendsFor(env, "s19").length === 1);
  }

  // T20 硬失败与软熔断同时武装 → 硬失败优先且只发一条
  {
    const env = makeEnv();
    const a = env.makeAgent("s20");
    env.fail(a);
    env.softStop(a);
    env.idle(a);
    await env.tick();
    const s = sendsFor(env, "s20");
    check("T20 硬失败优先单发", s.length === 1 && s[0].msg.source.path === "error", JSON.stringify(s.map((x) => x.msg.source.path)));
  }

  // T21 关闭软熔断续跑后不触发
  {
    const env = makeEnv({ config: { resumeAfterRepetitionStop: false } });
    const a = env.makeAgent("s21");
    env.softStop(a);
    env.idle(a);
    await env.tick();
    check("T21 软熔断开关关闭", sendsFor(env, "s21").length === 0);
  }

  // T22 用户删掉排队的 auto-continue 消息 → 视为否决，计数清零
  {
    const env = makeEnv();
    const a = env.makeAgent("s22");
    env.fail(a);
    env.idle(a);
    await env.tick();
    env.emit("agent/inbox/discarded", { agent: a, message: { source: { kind: "auto-continue" } } });
    env.fail(a);
    env.idle(a);
    await env.tick();
    const s = sendsFor(env, "s22");
    check("T22 删除排队消息视为否决", s.length === 2 && s[1].msg.source.attempt === 1, JSON.stringify(s.map((x) => x.msg.source.attempt)));
  }

  // T23 硬失败放弃时同时重置软链计数（防跨链泄漏）
  {
    const env = makeEnv();
    const a = env.makeAgent("s23");
    env.softStop(a);
    env.idle(a);
    await env.tick(); // 软链 attempt 1
    for (let i = 0; i < 4; i++) {
      env.fail(a);
      env.idle(a);
      await env.tick(); // 硬链 1/2/3 → 第 4 轮放弃并双清零
    }
    env.softStop(a);
    env.idle(a);
    await env.tick();
    const s = sendsFor(env, "s23");
    check(
      "T23 放弃点双清零",
      s.length === 5 && s[0].msg.source.path === "soft" && s[4].msg.source.path === "soft" && s[4].msg.source.attempt === 1,
      JSON.stringify(s.map((x) => [x.msg.source.path, x.msg.source.attempt]))
    );
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n=== ${results.length - failed}/${results.length} 通过 ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
