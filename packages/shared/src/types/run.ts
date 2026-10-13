import type { AdapterId, Device } from './common.js';
import type { Metric, MetricDelta } from './metric.js';

/**
 * 线性流水线的八段。M1 落地 collect / compare / report，
 * 其余段落以 `skipped` 状态显式出现在 RunRecord.stages 中 —— 进度可见，且不假装已完成。
 */
export const STAGE_NAMES = [
  'collect',
  'compare',
  'diagnose',
  'plan',
  'decide',
  'execute',
  'verify',
  'report',
] as const;

export type StageName = (typeof STAGE_NAMES)[number];

export type StageStatus = 'ok' | 'skipped' | 'failed';

export interface StageRecord {
  name: StageName;
  status: StageStatus;
  durationMs: number;
  /** 跳过或失败的原因；成功时为 null */
  note: string | null;
}

export type RunStatus = 'success' | 'partial' | 'failed';

/** 基线来源：某个 git ref，或某次历史 run */
export interface BaselineRef {
  /** `last-run` | runId | 文件路径 */
  ref: string;
  /** 命中的 runId；无历史时为 null */
  runId: string | null;
  metrics: Metric[];
}

/**
 * 告警严重度。
 *
 * `degraded` = 有数据没采到（适配器不可用 / 崩溃 / 输出不可解析）→ 运行不完整，
 *              不能作为后续运行的基线。
 * `info`     = 数据齐全，只是需要说明来源（例如某个指标由次选来源提供）→
 *              不影响运行完整性，也**不应该**阻止它成为基线。
 *
 * 区分这两者不是修辞：如果不分，一个没有 bundle-analyzer 的项目会因为
 * 「IMAGE_SIZE 由 Lighthouse 提供」这条纯说明性告警，永远拿不到基线。
 */
export const WARNING_SEVERITIES = ['info', 'degraded'] as const;
export type WarningSeverity = (typeof WARNING_SEVERITIES)[number];

export interface RunWarning {
  /** 归因到具体 adapter；与 adapter 无关时为 null */
  adapter: AdapterId | null;
  code: string;
  severity: WarningSeverity;
  message: string;
}

export interface ArtifactRef {
  adapter: AdapterId;
  kind: string;
  /** 相对于 run 目录的路径 */
  file: string;
}

export const SCHEMA_VERSION = 1;

/**
 * 一次完整运行的落盘记录，也是报告渲染的唯一输入。
 *
 * ⚠️ **这是手写类型，与 `schema/run.ts` 的 `RunRecordSchema` 是两份定义。**
 * 本项目多数对象的类型是 `z.infer` 推出来的（那是更好的做法：schema 加字段
 * 时类型自动跟上）；这里没有，于是加字段必须**两处都改** ——
 * `source`（Bottleneck）那次没事，因为它是推出来的；
 * `llmCostUsd` 这次就漏了一次，靠 tsc 才发现在。
 * 把这份也改成 `z.infer` 是应该做的事（会牵动 StageRecord / RunWarning 等
 * 一票手写类型，属于独立的清理）。
 */
export interface RunRecord {
  schemaVersion: number;
  id: string;
  project: string;
  route: string;
  device: Device;
  url: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  perfpilotVersion: string;
  stages: StageRecord[];
  metrics: Metric[];
  baseline: BaselineRef | null;
  deltas: MetricDelta[];
  warnings: RunWarning[];
  artifacts: ArtifactRef[];
  /** 本轮 LLM 花费（美元）：诊断 agent + 方案生成之和；未接 LLM 时为 0 */
  llmCostUsd: number;
}

export interface RunSummary {
  id: string;
  project: string;
  route: string;
  device: Device;
  status: RunStatus;
  startedAt: string;
  metricCount: number;
}
