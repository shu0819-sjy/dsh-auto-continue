/**
 * CI-portable behavior suite for auto-continue (no real DSH install).
 *
 * Stubs @deepseek-ai/schemastery + @deepseek-ai/dsh-llm via resolve hook,
 * then exercises the same failure→idle→continue paths as test/test.mjs.
 *
 * Run from repo root: node test/ci-mock.mjs
 */
import { register } from "node:module";

register(new URL("./_ci-mock-resolve-hook.mjs", import.meta.url));

const { apply, Config } = await import(new URL("../plugins/auto-continue.mjs", import.meta.url).href);

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  << " + detail}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Mock cordis-like host — mirrors test/test.mjs makeEnv */
function makeEnv({ backoff = [0.02, 0.02, 0.02], fiberState = 2, config = {} } = {}) {
  const handlers = new Map();
  const sent = [];
  const agents = new Map();
  const ref = { current: null };
  const ctx = {
    on(name, fn) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(fn);
    },
    logger: { info() {}, warn() {} },
    agents: {
      get: (id) => (agents.has(id) ? agents.get(id) : undefined),
      currentInitiator: () => ref.current,
    },
    fiber: { state: fiberState },
  };
  function makeAgent(id, { origin } = {}) {
    const agent = {
      id,
      status: "idle",
      session: { header: origin ? { origin } : {} },
      inbox: { nextTurn: [] },
      followup(msg) {
        sent.push({ agentId: id, msg });
      },
    };
    agents.set(id, agent);
    return agent;
  }
  apply(ctx, { ...Config(config), backoffSeconds: backoff });
  const emit = (name, payload) => {
    for (const fn of handlers.get(name) ?? []) fn(payload);
  };
  const fail = (agent, text = "Request timed out.") =>
    emit("agent/error", { agent, error: new Error(text) });
  const idle = (agent) => emit("agent/status", { agent, status: "idle" });
  const run = (agent) => emit("agent/status", { agent, status: "running" });
  const userMsg = (agent) =>
    emit("agent/inbox/inserted", { agent, message: { source: { kind: "user" } } });
  const softStop = (agent, info = { kind: "repetition", detector: "consecutive", repeats: 4 }) => {
    ref.current = agent;
    emit("anti-repetition/stopped", info);
  };
  return { sent, makeAgent, emit, fail, idle, run, userMsg, softStop, tick: () => sleep(120) };
}

const sendsFor = (env, id) => env.sent.filter((s) => s.agentId === id);

async function main() {
  // T0 schema defaults via stub Config
  {
    const cfg = Config({});
    check(
      "T0 schema defaults",
      cfg.continueText === "继续" &&
        cfg.maxAttempts === 3 &&
        cfg.maxRepetitionResumes === 2 &&
        cfg.resumeAfterRepetitionStop === true &&
        Array.isArray(cfg.patterns) &&
        cfg.patterns.length >= 12,
    );
  }

  // T1 timeout whitelist → one continue
  {
    const env = makeEnv();
    const a = env.makeAgent("s1");
    env.fail(a);
    env.idle(a);
    await env.tick();
    const s = sendsFor(env, "s1");
    check(
      "T1 timeout auto-continue once",
      s.length === 1 &&
        s[0].msg.source.kind === "auto-continue" &&
        s[0].msg.source.attempt === 1 &&
        s[0].msg.content[0].text === "继续" &&
        s[0].msg.source.path === "error",
      JSON.stringify(s),
    );
  }

  // T2 maxAttempts=3 then give up
  {
    const env = makeEnv();
    const a = env.makeAgent("s2");
    for (let i = 0; i < 4; i++) {
      env.fail(a);
      env.idle(a);
      await env.tick();
    }
    const s = sendsFor(env, "s2");
    check("T2 give up after 3 continues", s.length === 3 && s[2].msg.source.attempt === 3, `sent=${s.length}`);
  }

  // T4 non-whitelist error ignored
  {
    const env = makeEnv();
    const a = env.makeAgent("s4");
    env.fail(a, "Invalid API key: unauthorized 401");
    env.idle(a);
    await env.tick();
    check("T4 non-whitelist ignored", sendsFor(env, "s4").length === 0);
  }

  // T5 user interrupt cancels pending continue
  {
    const env = makeEnv();
    const a = env.makeAgent("s5");
    env.fail(a);
    env.idle(a);
    env.userMsg(a);
    await env.tick();
    check("T5 user interrupt wins", sendsFor(env, "s5").length === 0);
  }

  // T6 subagent skipped
  {
    const env = makeEnv();
    const a = env.makeAgent("sub1", { origin: "subagent" });
    env.fail(a);
    env.idle(a);
    await env.tick();
    check("T6 subagent skipped", sendsFor(env, "sub1").length === 0);
  }

  // T8 running clears armed failure
  {
    const env = makeEnv();
    const a = env.makeAgent("s8");
    env.fail(a);
    env.run(a);
    env.idle(a);
    await env.tick();
    check("T8 running clears arm", sendsFor(env, "s8").length === 0);
  }

  // T10 clean idle resets counter
  {
    const env = makeEnv();
    const a = env.makeAgent("s10");
    env.fail(a);
    env.idle(a);
    await env.tick();
    env.run(a);
    env.idle(a);
    env.fail(a);
    env.idle(a);
    await env.tick();
    const s = sendsFor(env, "s10");
    check(
      "T10 clean idle resets counter",
      s.length === 2 && s[1].msg.source.attempt === 1,
      JSON.stringify(s.map((x) => x.msg.source.attempt)),
    );
  }

  // T15 TimeoutError style
  {
    const env = makeEnv();
    const a = env.makeAgent("s15");
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    env.emit("agent/error", { agent: a, error: err });
    env.idle(a);
    await env.tick();
    check("T15 TimeoutError matches", sendsFor(env, "s15").length === 1);
  }

  // T16 soft fuse: 2 resumes then reset
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
      "T16 soft fuse cap + recount",
      s.length === 3 &&
        s[0].msg.source.path === "soft" &&
        s[0].msg.source.attempt === 1 &&
        s[1].msg.source.attempt === 2 &&
        s[2].msg.source.attempt === 1,
      JSON.stringify(s.map((x) => [x.msg.source.path, x.msg.source.attempt])),
    );
  }

  // T20 hard failure wins over soft when both armed
  {
    const env = makeEnv();
    const a = env.makeAgent("s20");
    env.fail(a);
    env.softStop(a);
    env.idle(a);
    await env.tick();
    const s = sendsFor(env, "s20");
    check(
      "T20 hard path preferred",
      s.length === 1 && s[0].msg.source.path === "error",
      JSON.stringify(s.map((x) => x.msg.source.path)),
    );
  }

  // T21 soft resume disabled
  {
    const env = makeEnv({ config: { resumeAfterRepetitionStop: false } });
    const a = env.makeAgent("s21");
    env.softStop(a);
    env.idle(a);
    await env.tick();
    check("T21 soft resume off", sendsFor(env, "s21").length === 0);
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n=== CI-mock ${results.length - failed}/${results.length} passed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
