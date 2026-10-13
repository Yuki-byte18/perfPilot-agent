/**
 * Unified diff 生成。
 *
 * **为什么自己写。** 执行器需要"给定原文与改后文，产出可 `git apply` 的补丁"。
 * 可选方案有三个：引 `diff` 包、shell 出 `git diff --no-index`、自己算。
 * 选第三个的理由：
 *
 * - 引包只为一个 LCS 算法，而它在 100 行内能写对且能测透；
 * - shell 出 git 需要把内容落盘再比，等于执行器必须碰文件系统 ——
 *   而"执行器只产出 patch、不改工作区"（ADR 006）的前提是**它能纯计算**；
 * - 纯函数意味着四类执行器各自的 fixture 测试不需要真实磁盘。
 *
 * 这是 `core` 与 `adapters` 共用的纯工具，因此放在 shared。
 */

export interface UnifiedDiffOptions {
  /** 上下文行数，unified diff 默认 3 */
  context?: number;
  /** 原文的行尾标记，默认 '\n' */
  eol?: string;
}

export interface UnifiedDiffResult {
  /** 可直接 `git apply` 的补丁文本 */
  patch: string;
  additions: number;
  deletions: number;
}

/** 一行都没变时返回 null —— 调用侧据此跳过"生成了空补丁"这种无意义结果 */
export function createUnifiedDiff(
  filePath: string,
  before: string,
  after: string,
  options: UnifiedDiffOptions = {},
): UnifiedDiffResult | null {
  if (before === after) return null;

  const context = options.context ?? 3;
  const eol = options.eol ?? '\n';

  const beforeLines = splitText(before);
  const afterLines = splitText(after);

  const script = computeEditScript(beforeLines, afterLines);
  const hunks = buildHunks(script, beforeLines, afterLines, context);

  if (hunks.length === 0) return null;

  const header = [`--- a/${filePath}`, `+++ b/${filePath}`];
  const body = hunks.map((h) => renderHunk(h, eol));

  const additions = script.filter((op) => op.type === 'add').length;
  const deletions = script.filter((op) => op.type === 'delete').length;

  return {
    patch: `${[...header, ...body].join(eol)}${eol}`,
    additions,
    deletions,
  };
}

// ─────────────────────────────────────────────────────────────────────
// 行拆分与编辑脚本
// ─────────────────────────────────────────────────────────────────────

/**
 * 拆行结果。
 *
 * 刻意保留「末尾是否有换行」这一信息：`a\nb` 与 `a\nb\n` 是两个不同的文件，
 * 而 naive 的 split 会让两者都变成 `['a','b']`。
 * 末尾无换行时输出 `\ No newline at end of file` 标记 —— 与 git 一致。
 */
interface SplitResult {
  lines: string[];
  noTrailingNewline: boolean;
}



type OpType = 'keep' | 'add' | 'delete';

interface EditOp {
  type: OpType;
  beforeIndex: number;
  afterIndex: number;
}

/**
 * 比较用的行键。
 *
 * 末尾行的「有无换行」必须参与比较，否则 `"a\nb"` → `"a\nb\n"` 会被判成"没有变化"——
 * 行内容确实相同，但文件确实变了（POSIX 文本文件约定，且会影响到下游工具）。
 * 加一个不可打印后缀来区分，渲染时不影响输出。
 */
function lineKey(result: SplitResult, index: number): string {
  const text = result.lines[index] ?? '';
  const isLast = index === result.lines.length - 1;
  return isLast && result.noTrailingNewline ? `${text}\u0000NONL` : text;
}

/**
 * 最长公共子序列 → 编辑脚本。
 *
 * 用标准 DP。对配置文件、package.json、模板这类目标文件（几百到几千行）
 * 完全够用；真遇到超大文件再换 Myers 也不迟 —— 但那是优化，不是现在的问题。
 */
function computeEditScript(a: SplitResult, b: SplitResult): EditOp[] {
  const aLines = a.lines;
  const bLines = b.lines;
  const n = aLines.length;
  const m = bLines.length;

  // lcs[i][j] = aLines[i..] 与 bLines[j..] 的 LCS 长度
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));

  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i]![j] =
        lineKey(a, i) === lineKey(b, j)
          ? (lcs[i + 1]![j + 1] ?? 0) + 1
          : Math.max(lcs[i + 1]![j] ?? 0, lcs[i]![j + 1] ?? 0);
    }
  }

  const ops: EditOp[] = [];
  let i = 0;
  let j = 0;

  while (i < n && j < m) {
    if (lineKey(a, i) === lineKey(b, j)) {
      ops.push({ type: 'keep', beforeIndex: i, afterIndex: j });
      i += 1;
      j += 1;
    } else if ((lcs[i + 1]![j] ?? 0) >= (lcs[i]![j + 1] ?? 0)) {
      ops.push({ type: 'delete', beforeIndex: i, afterIndex: j });
      i += 1;
    } else {
      ops.push({ type: 'add', beforeIndex: i, afterIndex: j });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ type: 'delete', beforeIndex: i, afterIndex: j });
    i += 1;
  }
  while (j < m) {
    ops.push({ type: 'add', beforeIndex: i, afterIndex: j });
    j += 1;
  }

  return ops;
}

// ─────────────────────────────────────────────────────────────────────
// Hunk 组装
// ─────────────────────────────────────────────────────────────────────

interface HunkLine {
  type: ' ' | '+' | '-';
  text: string;
  /** 原文末尾无换行时需要输出 `\ No newline at end of file` */
  noNewline: boolean;
}

interface Hunk {
  beforeStart: number;
  beforeCount: number;
  afterStart: number;
  afterCount: number;
  lines: HunkLine[];
}

function buildHunks(
  ops: readonly EditOp[],
  before: SplitResult,
  after: SplitResult,
  context: number,
): Hunk[] {
  const changed: number[] = [];
  ops.forEach((op, index) => {
    if (op.type !== 'keep') changed.push(index);
  });
  if (changed.length === 0) return [];

  // 相邻变更（间隔 ≤ 2*context 个 keep）合并进同一个 hunk
  const ranges: Array<[number, number]> = [];
  let start = changed[0] as number;
  let end = start;

  for (const index of changed.slice(1)) {
    if (index - end <= context * 2) {
      end = index;
    } else {
      ranges.push([start, end]);
      start = index;
      end = index;
    }
  }
  ranges.push([start, end]);

  return ranges.map(([from, to]) => {
    const lo = Math.max(0, from - context);
    const hi = Math.min(ops.length - 1, to + context);
    const slice = ops.slice(lo, hi + 1);

    const lines: HunkLine[] = [];
    let beforeCount = 0;
    let afterCount = 0;

    for (const op of slice) {
      if (op.type === 'keep') {
        lines.push({ type: ' ', text: before.lines[op.beforeIndex] ?? '', noNewline: false });
        beforeCount += 1;
        afterCount += 1;
      } else if (op.type === 'delete') {
        const isLast = op.beforeIndex === before.lines.length - 1;
        lines.push({
          type: '-',
          text: before.lines[op.beforeIndex] ?? '',
          noNewline: isLast && before.noTrailingNewline,
        });
        beforeCount += 1;
      } else {
        const isLast = op.afterIndex === after.lines.length - 1;
        lines.push({
          type: '+',
          text: after.lines[op.afterIndex] ?? '',
          noNewline: isLast && after.noTrailingNewline,
        });
        afterCount += 1;
      }
    }

    return { ...hunkStart(slice, beforeCount, afterCount), lines, beforeCount, afterCount };
  });
}

/**
 * 计算 hunk 头里的起始行号。
 *
 * 规则只有一条，**与首行类型无关**：
 *
 * - 该侧**有**行（count > 0）→ 起始行 = 第一行的 1-based 行号
 * - 该侧**为空**（count = 0，纯插入/纯删除）→ 起始行 = 那个"插入点"的 0-based 位置，
 *   也就是唯一允许出现 `0` 的情形（`@@ -0,0 +1,3 @@`）
 *
 * 早先按「首行的类型」分情况（`add` 用 0-based、`delete` 用 0-based……），
 * 那是个误解：一首行是新增、而该侧后面还有上下文行时，该侧的起始行是那一行
 * 上下文，不是插入点。结果产出 `@@ -1,2 +0 @@` 这种头 —— git apply 容忍，
 * 但它不符合规范（`0` 只该与 count 0 一起出现），更严格的工具会直接拒绝。
 *
 * 这个 bug 一直没暴露，是因为旧变换都不删文件**开头**的行：直到路由分割需要
 * 删掉顶部那几行 import 时才浮出来。判据仍然交给测试里真实的 `git apply --check`。
 */
function hunkStart(
  slice: readonly EditOp[],
  beforeCount: number,
  afterCount: number,
): Pick<Hunk, 'beforeStart' | 'afterStart'> {
  const first = slice[0];
  if (first === undefined) return { beforeStart: 0, afterStart: 0 };

  const beforeStart = beforeCount === 0 ? first.beforeIndex : first.beforeIndex + 1;
  const afterStart = afterCount === 0 ? first.afterIndex : first.afterIndex + 1;

  return { beforeStart: Math.max(0, beforeStart), afterStart: Math.max(0, afterStart) };
}

function renderHunk(hunk: Hunk, eol: string): string {
  // git 在计数为 1 时省略 `,1`
  const range = (start: number, count: number): string => (count === 1 ? `${start}` : `${start},${count}`);
  const header = `@@ -${range(hunk.beforeStart, hunk.beforeCount)} +${range(hunk.afterStart, hunk.afterCount)} @@`;

  const body = hunk.lines.flatMap((line) => {
    const rendered = `${line.type}${line.text}`;
    return line.noNewline ? [rendered, '\\ No newline at end of file'] : [rendered];
  });

  return [header, ...body].join(eol);
}

/** 拆分文本，同时保留「末尾是否无换行」这一信息 */
function splitText(text: string): SplitResult {
  if (text === '') return { lines: [], noTrailingNewline: false };

  const noTrailingNewline = !text.endsWith('\n');
  const body = noTrailingNewline ? text : text.slice(0, -1);
  return { lines: body.split('\n'), noTrailingNewline };
}
