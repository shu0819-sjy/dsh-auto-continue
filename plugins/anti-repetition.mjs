/**
 * 各模型长输出短句复读循环与流式停滞防护。
 *
 * 两层：
 * 1) 可选：给匹配模型的请求体注入 frequency/presence penalty（fetch 兜底，
 *    主路径已走 settings.yaml → Model.samplingParams）
 * 2) 流式检测连续短句 / 同行 / 归一化短词干 / 早期崩溃(一字一行、破损$草稿) /
 *    （可选）密度循环；关闭未闭合 block 后以 finish:stop 收尾。
 *
 * v2：熔断发生时向总线广播 `anti-repetition/stopped` 事件
 * （payload: { model, kind: "repetition"|"stream-incomplete", detector?, repeats? }），
 * 供 auto-continue 等插件做「熔断后自动续跑」；广播失败不影响熔断本身。
 *
 * v2.4 变更（2026-09-25，由一次真实误杀驱动）：
 * - char-split 的「同行空格拆字」变体收紧为极端形态（默认 ≥120 个单字符 token 且占比 ≥0.6），
 *   且思考链（strict）彻底不跑该变体、不跑破损 $ 草稿 —— 正常技术思考里单字符变量太多，
 *   v2.3 曾把正在干活的轮次误杀成 char-split×63。
 * - 新增 stallTimeoutSec 流式停滞看门狗：连续 N 秒无任何新 delta → 断流熔断
 *   （kind=stream-incomplete），kldai 这类无超时上游挂死不再永远沉默。
 * - findLineLoop 最低行长 4 → 2，补上 GO ×4 这类超短行循环漏检。
 * - notice 文案改为「通常将自动续跑」，不再引导用户手动回「继续」。
 *
 * v2.5 变更（2026-09-28，采纳外部评审 #5/#6）：
 * - fetch 惩罚注入改为 globalThis 注册表 + 引用计数：patchReload: live 热改配置会重建
 *   插件实例，旧实例 dispose 可能晚于新实例 apply，朴素「备份-还原」会把新 wrapper 一起
 *   冲掉导致惩罚静默失效。现在首个实例装 wrapper、末个实例卸载，wrapper 始终转发到最新
 *   注册的 patch，install/dispose 任意交错顺序下注入都存活。
 * - guardStream 导出：可用合成流对全部检测器 + 停滞看门狗做回归测试。
 */
import z from "@deepseek-ai/schemastery";

export const name = "anti-repetition";

export const Config = z.object({
  /** 流式复读检测作用的模型 id 通配（`*`）；空数组 = 匹配全部 */
  models: z.array(z.string()).default(["*"]),
  /**
   * 仅对这些模型注入 frequency/presence penalty（fetch 兜底）。
   * 与流式检测分离：惩罚不适合 Claude/部分 GPT，默认只打 glm flash。
   */
  samplingModels: z.array(z.string()).default(["*glm-5.3-flash*", "*glm*flash*"]),
  /** 连续重复次数阈值（含当前这一段） */
  minRepeats: z.number().step(1).min(2).default(3),
  /** 重复单元最短字符数 */
  minUnitLen: z.number().step(1).min(2).default(5),
  /** 重复单元最长字符数 */
  maxUnitLen: z.number().step(1).min(4).default(96),
  /** 每累计多少新字符再检测一次 */
  checkEveryChars: z.number().step(1).min(4).default(12),
  /** 检测窗口（只看末尾这么多字符） */
  windowChars: z.number().step(1).min(64).default(1600),
  /** 同一行连续重复阈值 */
  minLineRepeats: z.number().step(1).min(2).default(3),
  /**
   * 密度检测（窗口内同短句出现次数）。默认关闭：技术长文会反复出现
   * captureScreenshot 等词，末尾切片易误命中词中碎片（如 reScreenshot）。
   */
  enableDensity: z.boolean().default(false),
  minDensityHits: z.number().step(1).min(3).default(8),
  /** 密度候选最短长度（多词短语），避免词中切片 */
  densityMinLen: z.number().step(1).min(8).default(20),
  /**
   * 归一化短词干刷屏：剥标点/破折号/括号旁白后，同一短词占比过高则停。
   * 专打 Emit/GO/Now/(Write it!) 这类变奏复读。
   */
  enableNormStem: z.boolean().default(true),
  minStemHits: z.number().step(1).min(4).default(12),
  minStemShare: z.number().min(0.1).max(1).default(0.35),
  minStemLen: z.number().step(1).min(2).default(3),
  maxStemLen: z.number().step(1).min(4).default(24),
  /**
   * 早期崩溃检测：一字一行拆字、破损 PowerShell `$` 草稿。
   * 专打进入 Emit 循环前的「命令写烂」阶段。
   */
  enableCollapseDetect: z.boolean().default(true),
  minSingleCharLines: z.number().step(1).min(10).default(40),
  minSingleCharShare: z.number().min(0.1).max(1).default(0.3),
  minBrokenShellHits: z.number().step(1).min(3).default(8),
  /**
   * 同行空格拆字变体（E r r o r …）阈值：只认极端形态，避免把正常代码思考里
   * 的单字符变量/符号误判成崩溃（v2.3 曾以 ≥40 个 + 0.3 占比误杀真实轮次）。
   */
  charTokMinHits: z.number().step(1).min(10).default(120),
  charTokMinShare: z.number().min(0.1).max(1).default(0.6),
  /** 流式停滞看门狗：连续 N 秒无任何新 delta 视为断流熔断；0 = 关闭（v2.4） */
  stallTimeoutSec: z.number().min(0).default(120),
  /** 首个 token 前的沉默上限；超时抛请求级错误交给 A 链 */
  preTokenStallSec: z.number().min(0).default(240),
  /** 低多样性检测；默认关闭，易误伤正常长思考 */
  enableUniqueRatio: z.boolean().default(false),
  minUniqueRatio: z.number().min(0).max(1).default(0.12),
  uniqueMinChars: z.number().step(1).min(40).default(200),
  /** 命中后是否追加一行可见提示（含思考链被掐的情况） */
  appendNotice: z.boolean().default(true),
  noticeText: z
    .string()
    .default(
      "\n\n[anti-repetition: 检测到复读循环，已自动停止，通常将自动续跑。若未续跑请回「继续」。]",
    ),
  /** 是否也监控思考链；思考链跑连续/同行/归一化词干/崩溃检测，不跑密度 */
  watchReasoning: z.boolean().default(true),
  /** fetch 兜底注入（主路径是 settings samplingParams） */
  injectSamplingParams: z.boolean().default(true),
  frequencyPenalty: z.number().default(0.55),
  presencePenalty: z.number().default(0.4),
});

function wildcardToRegExp(pattern) {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  return new RegExp(`^${escaped.replaceAll("*", ".*")}$`, "i");
}

function modelMatched(modelId, patterns) {
  if (!patterns.length) return true;
  return patterns.some((re) => re.test(modelId));
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    count++;
    from = at + needle.length;
  }
  return count;
}

function findConsecutiveUnit(tail, { minRepeats, minUnitLen, maxUnitLen }) {
  const maxLen = Math.min(maxUnitLen, Math.floor(tail.length / minRepeats));
  for (let unitLen = minUnitLen; unitLen <= maxLen; unitLen++) {
    const unit = tail.slice(-unitLen);
    if (!unit.trim()) continue;
    let repeats = 1;
    let pos = tail.length - unitLen;
    while (pos >= unitLen) {
      const prev = tail.slice(pos - unitLen, pos);
      if (prev !== unit) break;
      repeats++;
      pos -= unitLen;
    }
    if (repeats >= minRepeats) return { kind: "consecutive", unit, repeats };
  }
  return null;
}

function findLineLoop(tail, minLineRepeats) {
  const lines = tail.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < minLineRepeats) return null;
  const last = lines[lines.length - 1];
  if (last.length < 2) return null;
  let repeats = 1;
  for (let i = lines.length - 2; i >= 0; i--) {
    if (lines[i] !== last) break;
    repeats++;
  }
  if (repeats >= minLineRepeats) return { kind: "line", unit: last, repeats };
  return null;
}

function findDensityLoop(tail, { minUnitLen, maxUnitLen, minDensityHits, densityMinLen = 20 }) {
  // 只接受「词/句边界起笔」的候选，禁止 reScreenshot 这类词中切片
  const minLen = Math.max(minUnitLen, densityMinLen);
  const candidates = new Set();
  const maxLen = Math.min(maxUnitLen, Math.floor(tail.length / minDensityHits));
  for (let unitLen = minLen; unitLen <= maxLen; unitLen++) {
    const start = tail.length - unitLen;
    if (start > 0 && !/[\s\n"'`([{，。！？、；：]/.test(tail[start - 1])) continue;
    const unit = tail.slice(start).trim();
    if (unit.length < minLen) continue;
    if (!/\s/.test(unit)) continue; // 必须是多词短语
    if (/^[\s.。…·\-_=]+$/.test(unit)) continue;
    candidates.add(unit);
  }
  for (const unit of candidates) {
    const hits = countOccurrences(tail, unit);
    if (hits >= minDensityHits) return { kind: "density", unit, repeats: hits };
  }
  return null;
}

/** 剥括号旁白 / 破折号 / 标点，只留词干序列，专打变奏刷屏 */
function normalizeStems(text) {
  return String(text)
    .replace(/\([^)]{0,80}\)/g, " ")
    .replace(/\[[^\]]{0,80}\]/g, " ")
    .replace(/[—–―_|/\\]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 归一化后同一短词干占比过高 → 变奏复读（Emit GO Emit Now Emit …）。
 * 思考链也启用：strict 模式同样会跑这一条。
 */
function findNormalizedStemLoop(
  tail,
  { minStemHits = 12, minStemShare = 0.35, minStemLen = 3, maxStemLen = 24 } = {},
) {
  const tokens = normalizeStems(tail)
    .split(" ")
    .filter((t) => t.length >= minStemLen && t.length <= maxStemLen);
  if (tokens.length < minStemHits) return null;

  const freq = new Map();
  for (const t of tokens) freq.set(t, (freq.get(t) || 0) + 1);

  let best = null;
  for (const [stem, hits] of freq) {
    if (hits < minStemHits) continue;
    const share = hits / tokens.length;
    if (share < minStemShare) continue;
    if (!best || hits > best.repeats) {
      best = { kind: "norm-stem", unit: stem, repeats: hits, share };
    }
  }
  return best;
}

function findLowUniqueRatio(tail, { uniqueMinChars, minUniqueRatio }) {
  if (tail.length < uniqueMinChars) return null;
  const n = 4;
  const grams = new Set();
  for (let i = 0; i <= tail.length - n; i++) grams.add(tail.slice(i, i + n));
  const ratio = grams.size / Math.max(1, tail.length - n + 1);
  if (ratio < minUniqueRatio) {
    return {
      kind: "unique-ratio",
      unit: `unique4gram=${ratio.toFixed(3)}`,
      repeats: Math.round((1 - ratio) * 100),
    };
  }
  return null;
}

/**
 * 一字一行（或空白拆成单字符 token）——命令写烂的典型前兆。
 * 同时覆盖「换行拆字」和「同行空格拆字」。
 */
function findCharSplitCollapse(
  tail,
  {
    minSingleCharLines = 40,
    minSingleCharShare = 0.3,
    charTokMinHits = 120,
    charTokMinShare = 0.6,
    strict = false,
  } = {},
) {
  const rawLines = tail.split(/\r?\n/);
  const lines = rawLines.map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length >= minSingleCharLines) {
    const singleLines = lines.filter((l) => Array.from(l).length === 1);
    const share = singleLines.length / lines.length;
    if (singleLines.length >= minSingleCharLines && share >= minSingleCharShare) {
      return {
        kind: "char-split",
        unit: `singleCharLines=${singleLines.length}`,
        repeats: singleLines.length,
        share,
      };
    }
  }

  // 同行空格拆字（E r r o r A c t i o n …）：只认极端形态——海量单字符 token 且占比极高。
  // 思考链（strict）不跑这条：正常技术思考里单字符变量/符号很多，v2.3 曾误杀真实轮次。
  if (strict) return null;
  const spaceTokens = tail
    .replace(/\r?\n/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (spaceTokens.length >= charTokMinHits) {
    const singleTok = spaceTokens.filter((t) => Array.from(t).length === 1);
    const share = singleTok.length / spaceTokens.length;
    if (singleTok.length >= charTokMinHits && share >= charTokMinShare) {
      return {
        kind: "char-split",
        unit: `singleCharTokens=${singleTok.length}`,
        repeats: singleTok.length,
        share,
      };
    }
  }
  return null;
}

/**
 * 破损 PowerShell `$` 草稿：`$` 独占一行、`$` 后换行再接标识符、cmdlet 动词被拆行。
 */
function findBrokenShellDraft(tail, { minBrokenShellHits = 8 } = {}) {
  const dollarAlone = (tail.match(/^\s*\$\s*$/gm) || []).length;
  const dollarBreak = (tail.match(/\$\s*\r?\n\s*[A-Za-z_]/g) || []).length;
  const splitCmdlet =
    (tail.match(/^\s*(Get|Set|New|Write|Select|Test|Move|Copy|Out|Add|Remove)-\s*$/gim) || [])
      .length;
  // 标识符被拆成「首字母一行 + 其余」的常见残骸：单独一行的 p/c/old/new 紧挨 =
  const assignShatter = (tail.match(/^\s*[A-Za-z_]\s*$\r?\n\s*=/gm) || []).length;

  const hits = dollarAlone + dollarBreak * 2 + splitCmdlet + assignShatter;
  if (hits < minBrokenShellHits) return null;
  return {
    kind: "broken-shell",
    unit: `dollarAlone=${dollarAlone};dollarBreak=${dollarBreak};cmdlet=${splitCmdlet};assign=${assignShatter}`,
    repeats: hits,
  };
}

/**
 * 多策略复读/崩溃检测：连续 / 同行 / 归一化词干 / 早期崩溃 / 密度 / 低多样性。
 * @returns {{ kind: string, unit: string, repeats: number } | null}
 */
export function findRepetitionLoop(text, {
  minRepeats = 3,
  minUnitLen = 5,
  maxUnitLen = 96,
  windowChars = 1600,
  minLineRepeats = 3,
  enableDensity = false,
  minDensityHits = 8,
  densityMinLen = 20,
  enableNormStem = true,
  minStemHits = 12,
  minStemShare = 0.35,
  minStemLen = 3,
  maxStemLen = 24,
  enableCollapseDetect = true,
  minSingleCharLines = 40,
  minSingleCharShare = 0.3,
  minBrokenShellHits = 8,
  charTokMinHits = 120,
  charTokMinShare = 0.6,
  enableUniqueRatio = false,
  minUniqueRatio = 0.12,
  uniqueMinChars = 200,
  strict = false,
} = {}) {
  if (typeof text !== "string" || text.length < minUnitLen * Math.min(minRepeats, 3)) return null;
  const tail = text.length > windowChars ? text.slice(-windowChars) : text;

  const hit =
    findConsecutiveUnit(tail, { minRepeats, minUnitLen, maxUnitLen }) ||
    findLineLoop(tail, minLineRepeats) ||
    (enableNormStem
      ? findNormalizedStemLoop(tail, { minStemHits, minStemShare, minStemLen, maxStemLen })
      : null) ||
    (enableCollapseDetect
      ? findCharSplitCollapse(tail, {
          minSingleCharLines,
          minSingleCharShare,
          charTokMinHits,
          charTokMinShare,
          strict,
        }) ||
        // 破损 $ 草稿只在正文跑：思考链里的 shell 片段示例容易误伤（v2.4）
        (strict ? null : findBrokenShellDraft(tail, { minBrokenShellHits }))
      : null);
  if (hit) return hit;
  // 思考链：连续/同行/归一化词干/崩溃检测即可，密度易误伤技术长推理
  if (strict) return null;
  if (enableDensity) {
    const density = findDensityLoop(tail, {
      minUnitLen,
      maxUnitLen,
      minDensityHits,
      densityMinLen,
    });
    if (density) return density;
  }
  if (enableUniqueRatio) {
    return findLowUniqueRatio(tail, { uniqueMinChars, minUniqueRatio });
  }
  return null;
}

function createDetector(config, { strict = false } = {}) {
  let text = "";
  let sinceCheck = 0;
  return {
    push(delta) {
      if (!delta) return null;
      text += delta;
      sinceCheck += delta.length;
      if (sinceCheck < config.checkEveryChars) return null;
      sinceCheck = 0;
      return findRepetitionLoop(text, { ...config, strict });
    },
    snapshot() {
      return text;
    },
  };
}

/**
 * 流式守卫生成器（v2.5 导出：供测试用合成流回归全部检测器与停滞看门狗）。
 * @param {AsyncIterable<object>} source 上游 chunk 流
 * @param {object} config Config 形状的检测配置
 * @param {(info: {kind: string, detector?: string, repeats?: number, stallSeconds?: number}) => void} [onStopped]
 */
export async function* guardStream(source, config, onStopped) {
  const textDetector = createDetector(config, { strict: false });
  // 思考链只用连续/同行：技术长文反复提同一个 API 名不是复读
  const reasoningDetector = createDetector(config, { strict: true });
  const open = new Map(); // index -> { blockType, text }
  const iter = source[Symbol.asyncIterator]();
  let finished = false;
  let stoppedForLoop = false;
  let sawContent = false;
  let maxIndex = -1;

  const formatNotice = (hit) => {
    if (hit?.kind === "stall") {
      return `\n\n[anti-repetition: 输出停滞超过 ${hit.repeats}s 无新内容，已自动停止，通常将自动续跑。]`;
    }
    const base = config.noticeText || "";
    if (!hit?.kind) return base;
    const detail = ` kind=${hit.kind}×${hit.repeats}`;
    if (base.includes("已自动停止")) {
      return base.replace("已自动停止", `已自动停止${detail}`);
    }
    return `${base}${detail}`;
  };

  const closeOpenBlocks = function* () {
    for (const [index, state] of [...open.entries()]) {
      if (state.blockType === "text") {
        yield { type: "block-end", index, block: { type: "text", text: state.text } };
        open.delete(index);
        continue;
      }
      if (state.blockType === "reasoning") {
        yield {
          type: "block-end",
          index,
          block: { type: "reasoning", text: state.text },
        };
        open.delete(index);
      }
      // tool-call 等半截块无法安全闭合，留给 finish 分支改走 aborted
    }
  };

  /** 保证用户侧一定能看到停因：优先写进已有 text 块，否则新开一个 */
  const emitVisibleNotice = function* (hit) {
    if (!config.appendNotice) return;
    const notice = formatNotice(hit);
    for (const [index, state] of open.entries()) {
      if (state.blockType === "text") {
        state.text += notice;
        yield { type: "text-delta", index, text: notice };
        return;
      }
    }
    const index = maxIndex + 1;
    maxIndex = index;
    open.set(index, { blockType: "text", text: notice.trimStart() });
    yield { type: "block-start", index, blockType: "text" };
    yield { type: "text-delta", index, text: notice.trimStart() };
  };

  const finishAfterLoop = function* (hit) {
    yield* emitVisibleNotice(hit);
    yield* closeOpenBlocks();
    if (open.size > 0) {
      yield {
        type: "finish",
        reason: {
          kind: "aborted",
          failure: {
            message: "anti-repetition stopped a repetition loop with open non-text blocks",
            code: "REPETITION_LOOP",
          },
        },
      };
    } else {
      yield { type: "finish", reason: { kind: "stop" } };
    }
  };

  try {
    while (true) {
      const activeStallSec = sawContent
        ? Number(config.stallTimeoutSec)
        : Number(config.preTokenStallSec ?? 240);
      const stallMs = activeStallSec > 0 ? activeStallSec * 1000 : 0;
      let iterResult;
      if (stallMs > 0) {
        // 停滞看门狗：iter.next() 与定时器赛跑，超时按断流熔断（v2.4）
        let stallTimer = null;
        const stallPromise = new Promise((resolve) => {
          stallTimer = setTimeout(() => resolve({ stalled: true }), stallMs);
        });
        let raced;
        try {
          raced = await Promise.race([
            iter.next().then((v) => ({ stalled: false, result: v })),
            stallPromise,
          ]);
        } finally {
          clearTimeout(stallTimer);
        }
        if (raced.stalled) {
          if (!sawContent) {
            const message = `upstream request timed out before first token after ${activeStallSec}s`;
            onStopped?.({
              kind: "upstream-silent",
              hadOutput: false,
              stallSeconds: activeStallSec,
              error: message,
            });
            yield {
              type: "finish",
              reason: {
                kind: "error",
                failure: { message, code: "EMPTY_RESPONSE" },
              },
            };
            finished = true;
            return;
          }
          const hit = {
            kind: "stall",
            unit: `no-delta ${activeStallSec}s`,
            repeats: activeStallSec,
          };
          onStopped?.({ kind: "stream-incomplete", stallSeconds: activeStallSec });
          yield* finishAfterLoop(hit);
          finished = true;
          return;
        }
        iterResult = raced.result;
      } else {
        iterResult = await iter.next();
      }
      if (iterResult.done) break;
      const chunk = iterResult.value;

      switch (chunk.type) {
        case "block-start":
          if (typeof chunk.index === "number" && chunk.index > maxIndex) maxIndex = chunk.index;
          open.set(chunk.index, { blockType: chunk.blockType, text: "" });
          break;
        case "text-delta": {
          const state = open.get(chunk.index);
          if (state) state.text += chunk.text;
          if (chunk.text) sawContent = true;
          const hit = textDetector.push(chunk.text);
          yield chunk;
          if (hit) {
            stoppedForLoop = true;
            onStopped?.({ kind: "repetition", detector: hit.kind, repeats: hit.repeats });
            yield* finishAfterLoop(hit);
            finished = true;
            return;
          }
          continue;
        }
        case "reasoning-delta": {
          const state = open.get(chunk.index);
          if (state) state.text += chunk.text;
          if (chunk.text) sawContent = true;
          yield chunk;
          if (!config.watchReasoning) continue;
          const hit = reasoningDetector.push(chunk.text);
          if (hit) {
            stoppedForLoop = true;
            onStopped?.({ kind: "repetition", detector: hit.kind, repeats: hit.repeats });
            yield* finishAfterLoop(hit);
            finished = true;
            return;
          }
          continue;
        }
        case "block-end":
          open.delete(chunk.index);
          break;
        case "finish":
          finished = true;
          break;
      }

      yield chunk;
      if (finished) return;
    }

    if (!finished) {
      onStopped?.({ kind: stoppedForLoop ? "repetition" : "stream-incomplete" });
      yield* closeOpenBlocks();
      yield {
        type: "finish",
        reason: {
          kind: "aborted",
          failure: {
            message: stoppedForLoop
              ? "anti-repetition stopped a repetition loop"
              : "upstream stream ended without finish",
            code: stoppedForLoop ? "REPETITION_LOOP" : "STREAM_INCOMPLETE",
          },
        },
      };
    }
  } finally {
    try {
      // 有界等待上游收尾：真实断流场景 iter.return() 可能永远不落定（socket 挂死），
      // 不能让它拖住本生成器收尾；cancel 的副作用仍会发出（v2.4）
      const returned = iter.return?.(undefined);
      if (returned && typeof returned.then === "function") {
        await Promise.race([
          returned.catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 1000)),
        ]);
      }
    } catch {
      /* upstream teardown */
    }
  }
}

/**
 * 生成请求体惩罚注入 patch：返回（可能被替换的）init，供 wrapper 调用。
 */
function makeSamplingPatch(config, patterns) {
  return (input, init) => {
    try {
      const method = String(init.method || "GET").toUpperCase();
      const url = typeof input === "string" ? input : input?.url || "";
      const path = String(url).split("?")[0];
      if (
        method === "POST" &&
        /\/chat\/completions\/?$/.test(path) &&
        typeof init.body === "string" &&
        init.body.length > 0
      ) {
        let bodyText = init.body;
        if (bodyText.charCodeAt(0) === 0xfeff) bodyText = bodyText.slice(1);
        if (bodyText.startsWith("{")) {
          const payload = JSON.parse(bodyText);
          const model = String(payload.model || "");
          if (modelMatched(model, patterns)) {
            let changed = false;
            if (payload.frequency_penalty === undefined) {
              payload.frequency_penalty = config.frequencyPenalty;
              changed = true;
            }
            if (payload.presence_penalty === undefined) {
              payload.presence_penalty = config.presencePenalty;
              changed = true;
            }
            if (changed) init = { ...init, body: JSON.stringify(payload) };
          }
        }
      }
    } catch {
      /* 解析失败则原样放行 */
    }
    return init;
  };
}

/**
 * fetch 惩罚注入（v2.5：全局单例 wrapper + 引用计数，热更新安全）。
 *
 * patchReload: live 下热改配置会重建插件实例，install/dispose 顺序不保证
 * （旧实例 dispose 可能晚于新实例 apply）。朴素「备份-还原」在该顺序下会把
 * 新实例的 wrapper 一起还原掉，惩罚静默失效。改为 Symbol.for 注册表：
 * - ref 0→1 时备份 original 并安装 wrapper；
 * - wrapper 调用时转发到「最新注册」的 patch（reg.patch）；
 * - ref→0 且 fetch 仍是自家 wrapper 时才还原（别人动过就不碰）。
 * 任意 install/dispose 交错顺序下注入都存活、最终必然还原。
 */
const FETCH_GUARD_KEY = Symbol.for("anti-repetition.samplingGuard");

function installFetchSamplingGuard(config, patterns) {
  if (!config.injectSamplingParams) return () => {};
  if (typeof globalThis.fetch !== "function") return () => {};

  const reg = (globalThis[FETCH_GUARD_KEY] ??= {
    original: null,
    wrapper: null,
    ref: 0,
    patch: null,
  });
  if (reg.ref === 0) {
    reg.original = globalThis.fetch;
    reg.wrapper = async (input, init = {}) => {
      const patch = reg.patch;
      if (patch) {
        try {
          init = patch(input, init) ?? init;
        } catch {
          /* patch 失败原样放行 */
        }
      }
      const original = reg.original;
      return original
        ? original(input, init)
        : globalThis.fetch(input, init);
    };
    globalThis.fetch = reg.wrapper;
  }
  reg.ref += 1;
  const myPatch = makeSamplingPatch(config, patterns);
  reg.patch = myPatch; // 最新注册生效
  return () => {
    if (reg.patch === myPatch) reg.patch = null;
    reg.ref = Math.max(0, reg.ref - 1);
    if (reg.ref === 0 && globalThis.fetch === reg.wrapper) {
      globalThis.fetch = reg.original;
      reg.original = null;
      reg.wrapper = null;
      reg.patch = null;
      delete globalThis[FETCH_GUARD_KEY];
    }
  };
}

export function apply(ctx, config) {
  const streamPatterns = (config.models ?? []).map(wildcardToRegExp);
  const samplingPatterns = (config.samplingModels ?? []).map(wildcardToRegExp);
  const restoreFetch = installFetchSamplingGuard(config, samplingPatterns);

  ctx.on("dispose", () => {
    restoreFetch();
  });

  ctx.on("llm/stream", (options, next) => {
    const upstream = next();
    if (!modelMatched(String(options.model || ""), streamPatterns)) return upstream;
    // v2：熔断/断流时广播事件，auto-continue 等监听方据此自动续跑
    //（agent 由监听方经 ctx.agents.currentInitiator() 解析——事件在该 agent 的 turn 内同步发出）
    return guardStream(upstream, config, (info) => {
      try {
        ctx.emit?.("anti-repetition/stopped", { model: String(options.model || ""), ...info });
      } catch {
        /* 广播失败不影响熔断本身 */
      }
    });
  });

  ctx.logger?.info?.(
    `anti-repetition v2.6: stream=${JSON.stringify(config.models)} sampling=${JSON.stringify(config.samplingModels)} minRepeats=${config.minRepeats} watchReasoning=${config.watchReasoning} stallTimeoutSec=${config.stallTimeoutSec} preTokenStallSec=${config.preTokenStallSec}`,
  );
}
