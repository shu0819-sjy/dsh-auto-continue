# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] — 2026-09-25

### Added — anti-repetition v2.4

- `stallTimeoutSec`（默认 120，0=关）：流式停滞看门狗，连续 N 秒无任何新 delta 即按断流熔断（`stream-incomplete`），上游挂死不再永远沉默；guardStream 收尾对上游 teardown 改为有界等待（1s），避免 `iter.return()` 挂死拖住整条流。
- char-split「同行空格拆字」变体收紧为极端形态（`charTokMinHits=120`、`charTokMinShare=0.6`），思考链（strict）不再运行该变体与破损 `$` 草稿检测——修复 v2.3 把正常技术思考误杀成 `char-split×63` 的真实事故。
- `findLineLoop` 最低行长 4 → 2，补上 `GO ×4` 类超短行循环漏检。
- notice 文案改为「通常将自动续跑」，不再引导用户手动回「继续」。

### Added — auto-continue v1.4

- C 链「空停/截断续跑」：监听 `agent/turn-stopping`，当本 turn 最后一条 assistant 消息为 `finish=max-tokens`（截断）或 `finish=stop` 且无可见文本、无工具调用（静默空停）时，用 `agent.steer` 在本轮内直接补一步续跑；连续 `maxPrematureSteers`（默认 2）次仍空停则放行关闭。`interrupted`（主动取消）、有工具调用（提问类交互收尾）、inbox 有排队真人消息时一律不插手。
- B 链软续跑改发 `repetitionResumeText`（引导换思路 + 附检测类型），不再无脑回「继续」喂同一失败模式。

### Tests

- `test/v24-smoke.mjs`：19 项冒烟（误杀回归、极端形态仍拦、strict 边界、GO×4、停滞看门狗、C 链全分支、B 链文本）。

## [0.1.1] — 2026-09-25

### Added

- `package.json` scripts: `check` / `lint` / `test:static` / `ci`
- ESLint flat config for `plugins/` + `test/` (Node ESM)
- CI: `npm ci` + eslint gate on Node 18/20/22 (keeps portable `ci-static` suite)
- Tag-driven GitHub Release workflow (`.github/workflows/release.yml`)

### Fixed

- Release line re-anchored after history rewrite: ship `v0.1.1` on current `master` tip (prior `v0.1.0` tag pointed at a non-ancestor commit)

## [0.1.0] — 2026-09-25

### Added

- Dual-chain architecture: hard failure whitelist resume (auto-continue ≤3) + soft circuit-break resume after `anti-repetition/stopped` (≤2)
- anti-repetition v2 streaming detectors with bus event for soft resume
- Parameterized test suite: 25 mock + 5 integration + 11 static (41 total)
- Cross-platform install scripts under `install/` with idempotent `cordis.patch.yml` mount
- Example snippets: `examples/cordis-patch.snippet.yml`, `examples/settings-retry.snippet.yml`
- Bilingual README (Chinese primary + English summary)
