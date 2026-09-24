/**
 * CI-portable static suite — no DSH / no @deepseek-ai/* required.
 *
 * Validates repo plugins + examples + install scripts by syntax check and
 * source/text assertions. Does NOT import plugins (they depend on private
 * @deepseek-ai packages only available inside a DSH install).
 *
 * Run from repo root: node test/ci-static.mjs
 *
 * Skipped on CI (require local DSH):
 *   - test/test.mjs        Mock suite (resolve hook → DSH node_modules)
 *   - test/integration.mjs Real cordis Context (needs @deepseek-ai/cordis)
 *   - test/check.mjs       Installed-profile self-check (needs DSH_HOME plugins + patch)
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const results = [];

function check(name, cond, detail = "") {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  << " + detail}`);
}

function read(rel) {
  return readFileSync(join(root, rel), "utf8");
}

function fileExists(rel) {
  return existsSync(join(root, rel));
}

// ── 1. Required tree ──────────────────────────────────────────────
for (const rel of [
  "plugins/auto-continue.mjs",
  "plugins/anti-repetition.mjs",
  "examples/cordis-patch.snippet.yml",
  "examples/settings-retry.snippet.yml",
  "install/install.ps1",
  "install/install.sh",
  "LICENSE",
  "README.md",
  "CHANGELOG.md",
]) {
  check(`tree: ${rel}`, fileExists(rel), join(root, rel));
}

// ── 2. Plugin files are non-empty ESM (node --check runs in CI workflow) ─
for (const rel of ["plugins/auto-continue.mjs", "plugins/anti-repetition.mjs"]) {
  const src = read(rel);
  check(`plugin non-empty ESM: ${rel}`, src.length > 100 && src.includes("export "));
}

// ── 3. auto-continue source contracts ─────────────────────────────
{
  const src = read("plugins/auto-continue.mjs");
  check("ac: export name", /export const name = "auto-continue"/.test(src));
  check("ac: inject agents", /export const inject = \["agents"\]/.test(src));
  check("ac: Config export", /export const Config = z\.object\(/.test(src));
  check("ac: export function apply", /export function apply\s*\(\s*ctx/.test(src));
  check("ac: default continueText", /\.default\("继续"\)/.test(src));
  check("ac: default maxAttempts 3", /maxAttempts:.*\.default\(3\)/.test(src));
  check(
    "ac: default maxRepetitionResumes 2",
    /maxRepetitionResumes:.*\.default\(2\)/.test(src),
  );
  check(
    "ac: resumeAfterRepetitionStop true",
    /resumeAfterRepetitionStop:.*\.default\(true\)/.test(src),
  );
  check(
    "ac: backoffSeconds [5,15,30]",
    /backoffSeconds:.*\.default\(\[5,\s*15,\s*30\]\)/.test(src),
  );
  check("ac: includeSubagents false", /includeSubagents:.*\.default\(false\)/.test(src));
  check("ac: listens agent/error", /["']agent\/error["']/.test(src));
  check(
    "ac: listens anti-repetition/stopped",
    /["']anti-repetition\/stopped["']/.test(src),
  );
  check("ac: DEFAULT_PATTERNS has timeout", /"timed out"/.test(src) && /"timeout"/.test(src));
  check("ac: DEFAULT_PATTERNS has 5xx", /\\\\b\(\?:429\|500\|502\|503\|504\|529\)\\\\b/.test(src) || /429\|500\|502/.test(src));
}

// ── 4. anti-repetition source contracts ───────────────────────────
{
  const src = read("plugins/anti-repetition.mjs");
  check("ar: export name", /export const name = "anti-repetition"/.test(src));
  check("ar: Config export", /export const Config = z\.object\(/.test(src));
  check("ar: minRepeats default 3", /minRepeats:.*\.default\(3\)/.test(src));
  check("ar: appendNotice true", /appendNotice:.*\.default\(true\)/.test(src));
  check("ar: watchReasoning true", /watchReasoning:.*\.default\(true\)/.test(src));
  check(
    "ar: emits anti-repetition/stopped",
    /anti-repetition\/stopped/.test(src),
  );
  check("ar: enableDensity false", /enableDensity:.*\.default\(false\)/.test(src));
  check(
    "ar: enableUniqueRatio false",
    /enableUniqueRatio:.*\.default\(false\)/.test(src),
  );
  check(
    "ar: enableCollapseDetect true",
    /enableCollapseDetect:.*\.default\(true\)/.test(src),
  );
}

// ── 5. examples / install portability ─────────────────────────────
{
  const patch = read("examples/cordis-patch.snippet.yml");
  check("patch: id anti-repetition", /id:\s*anti-repetition/.test(patch));
  check("patch: id auto-continue", /id:\s*auto-continue/.test(patch));
  check(
    "patch: plugin paths",
    /name:\s*\.\/plugins\/anti-repetition\.mjs/.test(patch) &&
      /name:\s*\.\/plugins\/auto-continue\.mjs/.test(patch),
  );
  check("patch: resumeAfterRepetitionStop", /resumeAfterRepetitionStop:\s*true/.test(patch));
  check("patch: maxAttempts", /maxAttempts:\s*\d+/.test(patch));

  const ps1 = read("install/install.ps1");
  const sh = read("install/install.sh");
  check("install.ps1: copies plugins", /plugins/i.test(ps1) && /cordis\.patch\.yml/i.test(ps1));
  check("install.sh: copies plugins", /plugins/i.test(sh) && /cordis\.patch\.yml/i.test(sh));
}

// ── 6. LICENSE MIT ────────────────────────────────────────────────
{
  const lic = read("LICENSE");
  check("LICENSE mentions MIT", /MIT License/i.test(lic));
}

const failed = results.filter((r) => !r.ok).length;
const passed = results.length - failed;
console.log(`\n=== CI-static ${passed}/${results.length} passed ===`);
if (failed) {
  console.log("Failed:");
  for (const r of results.filter((x) => !x.ok)) {
    console.log(`  - ${r.name}${r.detail ? ": " + r.detail : ""}`);
  }
}
process.exit(failed ? 1 : 0);
