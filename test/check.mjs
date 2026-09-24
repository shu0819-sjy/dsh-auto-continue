/**
 * auto-continue 套件静态自检（重启 DSH 前后都可跑，无需查日志）。
 * 覆盖：插件文件与语法、cordis.patch.yml 挂载、schema 默认值。
 * 运行（仓库根目录）：node test/check.mjs
 *
 * 默认检查已安装位置：DSH_HOME/profiles/web/plugins/...、cordis.patch.yml。
 * 可用 DSH_HOME / DSH_PLUGINS_DIR 覆盖；未设置时尝试本机常见安装路径。
 * 上游 provider 超时/重试为可选增强（见 examples/settings-retry.snippet.yml），不在本自检范围。
 */
import { statSync, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { requireDshNodeModules } from "./_dsh-env.mjs";

requireDshNodeModules();
register(new URL("./_dsh-resolve-hook.mjs", import.meta.url));

const results = [];
function check(name, cond, detail = "") {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  << " + detail}`);
}

/** 解析 DSH 数据目录：仅 DSH_HOME 或 APPDATA 通用布局（无本机绝对路径）。 */
function resolveDshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  if (process.env.APPDATA) {
    const fallback = join(process.env.APPDATA, "dsh-desktop", "data");
    if (existsSync(fallback)) return fallback;
  }
  console.error("需在装有 DSH 的机器上运行，可用 DSH_HOME 指定数据目录");
  process.exit(1);
}

const dshHome = resolveDshHome();
const pluginsDir = process.env.DSH_PLUGINS_DIR || join(dshHome, "profiles", "web", "plugins");

const FILES = {
  autoContinue: join(pluginsDir, "auto-continue.mjs"),
  antiRepetition: join(pluginsDir, "anti-repetition.mjs"),
  patch: join(dshHome, "profiles", "web", "cordis.patch.yml")
};

async function main() {
  // ① 文件存在
  for (const [key, path] of Object.entries(FILES)) {
    let ok = false;
    try { ok = statSync(path).isFile(); } catch {}
    check(`S1 文件存在: ${key}`, ok, path);
  }

  // ② 语法校验（node --check）
  for (const key of ["autoContinue", "antiRepetition"]) {
    const r = spawnSync(process.execPath, ["--check", FILES[key]], { encoding: "utf8" });
    check(`S2 语法有效: ${key}`, r.status === 0, r.stderr?.slice(0, 200));
  }

  // ③ 挂载点（cordis.patch.yml）
  try {
    const patch = readFileSync(FILES.patch, "utf8");
    check("S3 挂载 auto-continue", /id:\s*auto-continue/.test(patch) && /name:\s*\.\/plugins\/auto-continue\.mjs/.test(patch));
    check("S4 挂载 anti-repetition", /id:\s*anti-repetition/.test(patch) && /name:\s*\.\/plugins\/anti-repetition\.mjs/.test(patch));
    check("S5 软熔断参数在挂载中", /resumeAfterRepetitionStop:\s*true/.test(patch));
    check("S6 硬失败上限在挂载中", /maxAttempts:\s*\d+/.test(patch));
  } catch (e) {
    check("S3-S6 patch 读取", false, String(e));
  }

  // ④ schema 默认值（真实 import，验证模块解析链）
  try {
    const ac = await import(pathToFileURL(FILES.autoContinue).href);
    const cfg = ac.Config({});
    check(
      "S7 auto-continue schema",
      cfg.enabled === true && cfg.continueText === "继续" && cfg.maxAttempts === 3 &&
      cfg.maxRepetitionResumes === 2 && cfg.resumeAfterRepetitionStop === true &&
      Array.isArray(cfg.patterns) && cfg.patterns.length >= 12
    );
    const ar = await import(pathToFileURL(FILES.antiRepetition).href);
    const cfg2 = ar.Config({});
    check("S8 anti-repetition schema", cfg2.minRepeats === 3 && cfg2.appendNotice === true && cfg2.watchReasoning === true);
  } catch (e) {
    check("S7/S8 schema 导入", false, String(e));
  }

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n=== 自检 ${results.length - failed}/${results.length} 通过 ===`);
  console.log(failed === 0 ? "静态配置全部就绪；重启 DSH 后生效，出现失败/熔断时聊天里会出现来源 auto-continue 的「继续」。" : "存在未就绪项，先修复再重启。");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("自检崩溃:", e);
  process.exit(1);
});
