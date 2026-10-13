import type { AdapterId, Device } from '../types/common.js';
import type { MetricSample } from '../types/metric.js';
import type { LoggerPort } from './logger.js';

/**
 * adapter 的原始产物。**未做任何解释**，原样保留，
 * 供诊断阶段（M2）下钻取证，也供人工复核。
 *
 * `route` / `device` 属于产物的一部分：一个产物就是「对路由 R、在设备 D 上跑工具 X 的输出」。
 * 把它们放进信封而不是解析参数里，`toMetrics` 才能保持纯函数，
 * 同时让落盘的产物可以脱离运行上下文独立重放。
 */
export interface RawArtifact {
  adapter: AdapterId;
  /** 产物种类，如 `lighthouse-result` / `web-vitals` / `bundle-scan` */
  kind: string;
  payload: unknown;
  collectedAt: string;
  route: string;
  device: Device;
  /** 相对 run 目录的落盘路径；未落盘时为 null */
  file: string | null;
}

export interface CollectContext {
  url: string;
  /** 相对于 target.url 的路由，如 `/dashboard` */
  route: string;
  device: Device;
  /** 本次 run 的产物目录，adapter 可把原始文件写进去 */
  outputDir: string;
  timeoutMs: number;
  logger: LoggerPort;
}

/**
 * 外部工具的执行函数。**这是 adapter 层唯一允许接触外部世界的地方**。
 *
 * 拆出来的目的是让整个 `collect` 阶段可以被 fixture 替换：
 * 生产环境注入真实的 spawn 实现，测试注入读取录制文件的实现，
 * 于是 `toMetrics` 与其上层的全链路都能在零网络、零浏览器的条件下跑通。
 */
export type RawRunner = (ctx: CollectContext) => Promise<RawArtifact[]>;

/**
 * 采集端口。core 只认识这个接口，永远不 import 具体 adapter（硬约束 4）。
 */
export interface CollectorPort {
  readonly id: AdapterId;
  /** 依赖的外部工具是否可用（不抛异常，不可用返回 false） */
  isAvailable(): Promise<boolean>;
  /** 与外部世界交互，产出原始产物（含 IO，有副作用） */
  collect(ctx: CollectContext): Promise<RawArtifact[]>;
  /** 纯函数：原始产物 → 未打分样本。可被测、可重放、无 IO */
  toMetrics(artifacts: readonly RawArtifact[]): MetricSample[];
}

/**
 * adapter 注册表。定义在 shared 是为了让 core 能 type-only 引用它，
 * 具体实例由 cli / server 在组合根创建并注入。
 *
 * 刻意**不提供** `available()`：探活属于采集阶段，由 `core/collector` 统一做，
 * 这样「哪个来源没跑起来」才会变成报告里的一条告警。注册表只负责「有哪些」。
 */
export interface AdapterRegistry {
  /** 全部已装配的适配器 */
  all(): CollectorPort[];
  get(id: AdapterId): CollectorPort | null;
}
