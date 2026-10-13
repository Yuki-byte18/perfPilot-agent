import type { Candidate, PlannedChange } from '../schema/candidate.js';
import type { ToolRoute } from '../types/decision.js';

/**
 * 执行器端口（README §5 core/executor）。
 *
 * executor 把决策层 `apply` / `confirm` 的候选变成 **patch**，
 * **不直接改工作区** —— 补丁是唯一可审计、可回滚、可人工确认的执行产物（ADR 006）。
 *
 * 四类执行器对应四种 `ToolRoute`：
 * - ast-rewriter：ts-morph 改写语法树
 * - asset-processor：sharp 处理二进制资产
 * - config-editor：结构化改写配置
 * - dependency-editor：package.json 依赖增删改
 */

/** 执行结果：标准 unified diff 文本 */
export interface ExecutionResult {
  candidateId: string;
  route: ToolRoute;
  /** unified diff 文本，可直接 `git apply`；二进制改动时为 `''` */
  patch: string;
  /**
   * **执行过程中是否已经改动了工作区**。
   *
   * 这个字段是必需的，因为「有没有 patch」推不出「有没有改工作区」：
   *
   * - 文本执行器（ast / config / dependency）：产出 patch，**不动工作区** → `false`
   * - asset 执行器且已写入：`patch === ''`，工作区**已改** → `true`
   * - asset 执行器但只做评估（`writeAssets: false`）：`patch === ''`，
   *   工作区**没动**，`files` 只是「会改哪些文件」 → `false`
   *
   * 少了它，后两种状态在上层看起来一模一样，流水线会把「只评估过」的候选
   * 当成「已经落地」拿去验证，然后拿着没变的指标去判断收益。
   */
  applied: boolean;
  /** 涉及的文件列表（相对项目根）。`applied: false` 时含义是「将会改动的文件」 */
  files: string[];
  /** 改动摘要，供报告展示 */
  summary: string;
}

/**
 * 执行上下文。
 *
 * `projectRoot` 是绝对路径，执行器据此定位源码。
 * `readFile` / `readBinary` / `writeFile` 刻意做成注入函数而不是直接用 fs：
 * 单测可以注入内存文件系统，无需真实磁盘 ——
 * 四类执行器的 fixture 测试因此不需要建临时仓库。
 */
export interface ExecutionContext {
  projectRoot: string;
  /** 读文本文件；不存在返回 null */
  readFile: (path: string) => Promise<string | null>;
  /**
   * 读二进制文件（图片等）。与 `readFile` 分开是必要的：
   * 图片用 utf8 读会损坏字节，而 asset-processor 必须拿到原始字节。
   */
  readBinary?: (path: string) => Promise<Uint8Array | null>;
  /** 写文件仅用于 asset-processor（图片转码），其它执行器只产出 patch */
  writeFile?: (path: string, content: Buffer | string) => Promise<void>;
}

/** 单个执行器接口 */
export interface Executor {
  readonly route: ToolRoute;
  /** 能否处理这个 PlannedChange */
  canHandle(change: PlannedChange): boolean;
  /** 把一个候选的所有改动合成一份 patch */
  execute(candidate: Candidate, ctx: ExecutionContext): Promise<ExecutionResult>;
}

/**
 * 执行器注册表。
 *
 * 定义在 shared 是为了让 core 能 type-only 引用它；
 * 具体实例由 cli / server 在组合根创建并注入。
 */
export interface ExecutorRegistry {
  /** 返回能处理该候选的执行器；无匹配时返回 null */
  forCandidate(candidate: Candidate): Executor | null;
  all(): Executor[];
}
