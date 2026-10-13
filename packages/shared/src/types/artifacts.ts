/**
 * 适配器产物的**数据契约**。
 *
 * 这些 payload 是 adapter 层与诊断层之间的接口：adapter 负责把外部工具的原始输出
 * 规范化成这里定义的形状，`core/diagnoser` 的规则只按这个形状读数据。
 *
 * 放在 shared 而不是各自的 adapter 里，是因为硬约束 4 禁止 core import 具体 adapter——
 * 规则需要类型，类型就必须来自 shared。
 *
 * ⚠️ HAR 与 trace 的 payload 是**规范化后的摘要**，不是原始文件：
 * HAR 里可能内嵌 base64 响应体，Chrome trace 动辄上百 MB。
 * 原样落盘会让 run 目录爆炸，也会让报告页面卡死。
 * 裁剪规则写在各自的 runner 里，并保证诊断需要的信息一个不少。
 */

// ─────────────────────────────────────────────────────────────────────
// HAR
// ─────────────────────────────────────────────────────────────────────

export interface HarHeader {
  name: string;
  value: string;
}

/** HAR entry 的规范化形态：只保留诊断用得上的字段 */
export interface HarEntry {
  url: string;
  /** Chrome 的 `_resourceType`，缺失时由 mimeType 推断 */
  resourceType: string;
  mimeType: string;
  status: number;
  /** 网络传输字节（压缩后 + 头开销）。缺失时为 null */
  transferSize: number | null;
  /** 资源解码后字节（未压缩）。缺失时为 null */
  resourceSize: number | null;
  /** 请求发出到响应结束的总耗时（ms） */
  timeMs: number;
  /** 相对页面导航开始的时间（ms），用于判断「发现得太晚」 */
  startMs: number;
  /** content-encoding，未压缩时为 null */
  contentEncoding: string | null;
  /** 响应 cache-control，缺失时为 null */
  cacheControl: string | null;
  /** 发起者类型：parser / script / img / link ... */
  initiatorType: string | null;
  /** 是否走 HTTP 缓存（304 或 from-cache） */
  fromCache: boolean;
  /** 是否属于主文档同源 */
  sameOriginAsDocument: boolean;
  /** 资源优先级（Chrome 的 `_priority`） */
  priority: string | null;
}

export interface HarPayload {
  /** 输入是 HAR 文件还是导出的 entries 数组 */
  source: 'har';
  pageUrl: string | null;
  /** 原始 entries 数量（裁剪前） */
  entryCount: number;
  entries: HarEntry[];
}

// ─────────────────────────────────────────────────────────────────────
// Chrome trace
// ─────────────────────────────────────────────────────────────────────

/** 长任务里耗时最高的那一帧，用于把「卡了 320ms」落到具体代码位置 */
export interface TraceFrame {
  functionName: string | null;
  /** 已解析的脚本 URL（可能带 http(s) 前缀或为构建产物相对路径） */
  url: string | null;
  /** 1-based 行号（Chrome trace 里是 0-based，转换在 runner 完成） */
  line: number | null;
  /** 0-based 列号 */
  column: number | null;
}

export interface TraceLongTask {
  /** 相对 trace 起点的时间（ms） */
  startMs: number;
  durationMs: number;
  /** 该任务内耗时最高的帧；没有可归因帧时为 null */
  topFrame: TraceFrame | null;
  /** 任务内各阶段的耗时汇总（ms） */
  scriptingMs: number;
  layoutMs: number;
  styleMs: number;
}

export interface TracePayload {
  source: 'trace';
  /** trace 覆盖的总时长（ms） */
  totalMs: number;
  /** 原始事件数量（裁剪前） */
  eventCount: number;
  /** 超过 50ms 的任务，按耗时降序 */
  longTasks: TraceLongTask[];
  /** 全量主线程耗时汇总（ms） */
  totals: { scriptingMs: number; layoutMs: number; styleMs: number };
}

// ─────────────────────────────────────────────────────────────────────
// 构建产物扫描
// ─────────────────────────────────────────────────────────────────────

export interface BundleFile {
  path: string;
  size: number;
  /**
   * 对应的**源文件**路径（相对项目根）；认不出来就是 null。
   *
   * 写成可选（而不是像 schema 那样 `.default(null)` 的必填）是**刻意的**：
   * 这份手写接口是给读取方用的，而产物可能是更早版本写下的（那时还没有这个字段）。
   * 消费侧统一用 `sourcePath ?? path`，两种情形都对。
   *
   * 注意：`schema/artifacts.ts` 里的 `BundleFileSchema` 是**权威** ——
   * 手写这份只是因为 `exactOptionalPropertyTypes` 下 `z.infer` 与手写接口
   * 不互相赋值（见 `types/bottleneck.ts` 顶部）。
   */
  sourcePath?: string | null;
}

export interface BundleModule {
  name: string;
  size: number;
}

/** package.json 快照，供「配置类」规则归因（如 sideEffects 关掉了 tree shaking） */
export interface PackageJsonSnapshot {
  name: string | null;
  /**
   * 原值只有三种可能：`false`、字符串 glob 数组、或未声明。
   *
   * 刻意**不用 `unknown`**：zod 的 `z.unknown()` 推断出来是可选字段，
   * 在本项目开启 `exactOptionalPropertyTypes` 时与「必填但值可为 null」不兼容。
   * 把真实取值域写出来，既避开这个坑，也顺手把规则层要处理的分支限定住了。
   */
  sideEffects: boolean | string[] | null;
  dependencies: Record<string, string> | null;
  devDependencies: Record<string, string> | null;
}

export interface BundleScanPayload {
  distDir: string;
  /** stats = 有模块图；scan = 仅目录遍历 */
  source: 'scan' | 'stats';
  files: BundleFile[];
  modules: BundleModule[];
  packageJson: PackageJsonSnapshot | null;
}
