# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] — 2026-09-30

### Added — auto-continue v1.8（live 同步 v1.6/v1.7/v1.8）

- **排队消息插队续跑 `priorityOverQueued`（默认开）**：inbox 有排队消息时不再否决续跑，改为把续跑消息 `inbox.prepend("next-turn")` 插到队首（优先于排队消息执行），再补 `wakeDriver` 唤醒（idle 即启动驱动；running/maintenance 下安全空转）；无排队消息维持 `followup` 原路径。
- **A/B 链有排队消息时跳过退避定时器、立即插队发送**：退避窗口内排队消息会把驱动重新拉起（`running` 处理器撤掉挂起定时器），定时器路径在该场景下必然丢失。
- **真人否决收窄**：排队消息不再触发 `inserted → resetAll`（插队机制接手）；显式否决保留两条路——删除排队中的 auto-continue 消息（`discarded → 全量清零`）与关闭 `priorityOverQueued`（恢复旧的「有排队即让位」行为，C 链同步回落）。
- **防叠加**：`next-turn` / `next-step` 里已有 auto-continue 消息时一律跳过，不双发。
- **v1.6（此前未入档）**：错误白名单补中转上游故障透传错误体 `upstream request failed` / `upstream service`。

## [0.3.0] — 2026-09-28

外部评审「取其精华去其糟粕」：采纳 #1/#3/#5/#6，丢弃 #2/#4/#7（理由见下）。

### Added — auto-continue v1.5

- **互斥槽 `resumeSent`（一次性让位）**：C 链空停/截断 steer 成功后，紧随该收尾的 idle 上 A/B 链让位一次并立即释放标记；失败/熔断标记保留，下一轮 idle 若仍失败自然重试——只堵「同一收尾周期 C 链与 A/B 链各发一条续跑」的窄窗口竞态，不吞并任何链的重试。C 链自身连续 steer（in-turn 补步不再触发 running）不受互斥影响。running / 干净 idle / 真人接管三处统一撤销。
- **idle 统计行**：干净收尾时若本周期有过续跑，打一行 `本周期续跑统计 agent=… 硬失败=N 软熔断=N 空停/截断=N 最后触发=…`，给 `minRepeats` / `stallTimeoutSec` 等阈值调参提供真实数据。

### Added — anti-repetition v2.5

- **fetch 惩罚注入热更新安全**：`installFetchSamplingGuard` 改为 `Symbol.for` 全局注册表 + 引用计数。`patchReload: live` 下热改配置会重建插件实例，旧实例 dispose 可能晚于新实例 apply；朴素「备份-还原」会把新 wrapper 一起冲掉导致惩罚静默失效。现在首个实例装 wrapper、末个实例卸载，wrapper 始终转发到最新注册的 patch，install/dispose 任意交错顺序下注入都存活、最终必然还原。
- **导出 `guardStream`**：可用合成流对全部 6 类检测器 + 停滞看门狗做回归测试。

### Tests

- `test/v25-hardening.mjs`：25 项（互斥槽让位/释放、统计行、fetch 注入 install/dispose 交错顺序、合成流 consecutive 熔断 / 上游截断 aborted / tool-call 半截块 aborted / strict 思考链不误杀）。
- `test/test.mjs` / `test/ci-mock.mjs`：重试循环补发 `running` 事件（模拟续跑轮真实启动），断言意图不变。

### Rejected（评审建议中不采纳的部分与理由）

- **#2 错误签名去重**：瞬态故障（超时/网关 5xx）的错误签名本来就是相同的——「同一签名只重试一次」会砍掉插件最核心的合法重试（真实案例：xai 瞬时 TIMEOUT 重试即恢复）；永久性故障现有设计已封顶（≤3 次 / 约 50s / fail loud warn），有界不空转。
- **#4 默认模型启动校验**：前提不成立——防复刷的保护范围是部署配置里有意收窄的（`models` 白名单），惩罚注入按模型通配是刻意设计（penalty 不适合所有模型）；插件无法可靠得知「默认模型」，改为 README 文档提醒「换默认模型需同步 models 白名单」。
- **#7 续跑/notice 文案收进 debug 开关**：可见性是有意设计（fail loud，用户依赖停因提示），且两段文案均可经配置自定义或清空；`repetitionResumeText` 承担引导模型换思路的功能，不能砍。

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
