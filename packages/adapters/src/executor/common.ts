import {
  createUnifiedDiff,
  type Candidate,
  type ExecutionContext,
  type ExecutionResult,
  type Executor,
  type PlannedChange,
  type ToolRoute,
} from '@yuki-byte18/shared';

/**
 * 执行器的公共骨架。
 *
 * 四类执行器共享同一套流程：
 *
 * ```
 * 取出候选的改动 → 逐条应用到内存中的文件内容 → 汇总成一份 patch
 * ```
 *
 * **关键点是"内存中"**：执行器读原文件、算出改后内容、生成 diff，
 * 全程不写工作区（ADR 006）。这样：
 * - 补丁是唯一产物，`git apply` 是唯一的落地动作
 * - fixture 测试只需注入一个 `readFile`，不必建临时仓库
 */

/** 一次改动的结果：某个文件从 before 变成 after */
export interface FileEdit {
  file: string;
  before: string;
  after: string;
}

export type ChangeApplier = (
  change: PlannedChange,
  readFile: ExecutionContext['readFile'],
) => Promise<FileEdit | null | { error: string }>;

/** 判定一个返回值是错误描述还是编辑结果 */
export function isError(value: unknown): value is { error: string } {
  return typeof value === 'object' && value !== null && 'error' in value;
}

/**
 * 把若干 `FileEdit` 拼成一份 unified diff。
 *
 * 同一个文件被改多次时按顺序累积：先读原文，逐条应用，最后一次成 diff ——
 * 每改一次就产一个 hunk 会让补丁碎片化，`git apply` 也可能因为行号漂移失败。
 */
export function buildPatch(edits: readonly FileEdit[]): {
  patch: string;
  files: string[];
  additions: number;
  deletions: number;
} | null {
  const hunks: string[] = [];
  let additions = 0;
  let deletions = 0;

  for (const edit of edits) {
    const diff = createUnifiedDiff(edit.file, edit.before, edit.after);
    if (diff === null) continue;
    hunks.push(diff.patch);
    additions += diff.additions;
    deletions += diff.deletions;
  }

  if (hunks.length === 0) return null;

  return {
    patch: hunks.join(''),
    files: [...new Set(edits.map((e) => e.file))],
    additions,
    deletions,
  };
}

export interface ExecutorOptions {
  route: ToolRoute;
  /** 能处理哪些改动类型 */
  accepts: (change: PlannedChange) => boolean;
  /** 应用单条改动 */
  apply: ChangeApplier;
  /** 无法处理时的说明，进 ExecutionResult.summary */
  skipReason?: string;
  /**
   * 自定义目标文件解析（默认：精确匹配 + 同名换扩展名）。
   *
   * 存在的理由：候选里的路径是**推断**出来的，而某些产物的位置只有约定、
   * 没有定数（路由表就是典型）。由执行器（它才认识文件系统）拿一组约定名去
   * 核实，比让规划器猜一个具体路径可靠得多。
   *
   * 约定名也找不到时必须返回 null —— **绝不改一个碰巧存在的文件**。
   */
  resolveFile?: (
    change: PlannedChange,
    readFile: ExecutionContext['readFile'],
  ) => Promise<string | null>;
}

/** 同名文件的常见扩展名，按 TS / Vite 生态的实际习惯排序 */
const SIBLING_EXTENSIONS = ['.ts', '.js', '.mjs', '.mts', '.cjs', '.cts', '.tsx', '.jsx', '.json'];

/**
 * 解析改动的目标文件。
 *
 * 默认只做"精确匹配 + 同名换扩展名"；执行器可以用 `options.resolveFile`
 * 覆盖它（例如按约定名去找位置不固定的产物）。
 */
function resolveTarget(
  options: ExecutorOptions,
  change: PlannedChange,
  readFile: ExecutionContext['readFile'],
): Promise<string | null> {
  if (options.resolveFile !== undefined) return options.resolveFile(change, readFile);
  // dependency 类改动没有 file（它固定作用在 package.json 上）
  if (!('file' in change)) return Promise.resolve(null);

  return resolveExistingFile(change.file, readFile);
}

/**
 * 把候选里记的文件名校正成**磁盘上真的存在**的那一个。
 *
 * 候选里的文件名是**推断**出来的：诊断器的归因与方案库都写死 `vite.config.ts`，
 * 而真实项目可能叫 `vite.config.js` / `.mjs` / `.mts`。不校正的后果不是"报错"，
 * 而是整条优化静默退化成"无需改动" —— 用户看到"预期省 436KB"的候选
 * 一份补丁都没产出，且拿不到任何原因。这个坑在真实项目上踩到过一次。
 *
 * 只做「同名换扩展名」，**不猜目录**：猜目录会把改动落到用户没预期的文件上，
 * 那比不做更糟。
 */
export async function resolveExistingFile(
  file: string,
  readFile: ExecutionContext['readFile'],
): Promise<string | null> {
  if ((await readFile(file)) !== null) return file;

  const dot = file.lastIndexOf('.');
  const sep = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  if (dot <= sep + 1) return null; // 没有扩展名，不做猜测

  const stem = file.slice(0, dot);
  for (const ext of SIBLING_EXTENSIONS) {
    const candidate = `${stem}${ext}`;
    if (candidate === file) continue;
    if ((await readFile(candidate)) !== null) return candidate;
  }
  return null;
}

/**
 * 换掉改动里的目标文件名。
 *
 * 逐分支展开而不是 `{ ...change, file }`：后者作用在联合类型上时，
 * TS 推出来的对象类型与 `PlannedChange` 对不上（试过，报 TS2345）。
 * `dependency` 没有 `file`，原样返回。
 */
function withFile(change: PlannedChange, file: string): PlannedChange {
  switch (change.type) {
    case 'ast':
      return { ...change, file };
    case 'asset':
      return { ...change, file };
    case 'config':
      return { ...change, file };
    default:
      return change;
  }
}

/**
 * 构造一个执行器。
 *
 * 刻意把「能不能处理」与「怎么处理」拆开：`routeFor` 已经保证候选的改动类型一致，
 * 但单条改动仍可能因为语义原因无法处理（例如 ast 变换不在已知变换表里）。
 * 这时返回 null，由上层记为「需要人工」而不是产出一个半成品补丁。
 */
export function createExecutor(options: ExecutorOptions): Executor {
  return {
    route: options.route,
    canHandle: options.accepts,

    async execute(candidate: Candidate, ctx: ExecutionContext): Promise<ExecutionResult> {
      const edits: FileEdit[] = [];
      const skipped: string[] = [];

      for (const change of candidate.changes) {
        if (!options.accepts(change)) {
          skipped.push(`${change.type} 改动不在本执行器职责内`);
          continue;
        }

        /**
         * 校正目标文件名（见 `resolveExistingFile` 的说明）。
         *
         * `dependency` 类改动**没有** `file`（它固定作用在 `package.json` 上，
         * 由 dependency-editor 自己决定），因此先收窄再读文件。
         */
        const resolved = await resolveTarget(options, change, ctx.readFile);

        if ('file' in change && resolved === null) {
          skipped.push(`文件不存在：${change.file}`);
          continue;
        }

        const result = await options.apply(
          resolved === null ? change : withFile(change, resolved),
          ctx.readFile,
        );

        if (result === null) {
          skipped.push(describeSkip(change, options.skipReason));
          continue;
        }
        if (isError(result)) {
          skipped.push(result.error);
          continue;
        }

        // 同一文件的多次改动累积到同一条编辑上
        const existing = edits.find((e) => e.file === result.file);
        if (existing === undefined) {
          edits.push(result);
        } else {
          existing.after = result.after;
        }
      }

      const built = buildPatch(edits);

      if (built === null) {
        return {
          candidateId: candidate.id,
          route: options.route,
          patch: '',
          applied: false,
          files: [],
          summary: skipped.length > 0 ? `未能生成改动：${skipped.join('；')}` : '改动未产生任何差异',
        };
      }

      const summary = `改动 ${built.files.length} 个文件（+${built.additions} / -${built.deletions}）`;
      return {
        candidateId: candidate.id,
        route: options.route,
        patch: built.patch,
        // 文本执行器只产出 patch，工作区由流水线在验证前应用（ADR 006）
        applied: false,
        files: built.files,
        summary: skipped.length > 0 ? `${summary}；跳过：${skipped.join('；')}` : summary,
      };
    },
  };
}

function describeSkip(change: PlannedChange, fallback?: string): string {
  const target = 'file' in change ? change.file : change.type;
  return fallback !== undefined ? `${target}：${fallback}` : `${target}：无法自动改写，需人工处理`;
}
