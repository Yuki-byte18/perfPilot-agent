import type { RunRecord, RunSummary } from '../types/run.js';
import type { Device } from '../types/common.js';
import type { Diagnosis } from '../schema/diagnosis.js';
import type { RawArtifact } from './collector.js';
import type { ReportOutput } from './reporter.js';

/** 一次 run 的落盘位置 */
export interface SavedRun {
  runId: string;
  /** run 目录的绝对路径 */
  dir: string;
  /** run.json 的绝对路径 */
  runFile: string;
}

/**
 * 运行记录存储端口。
 *
 * 本地实现是文件系统（`.perfpilot/runs/`），服务端实现可以是 Postgres。
 * core 只依赖这个接口，因此单测用内存实现即可，不碰磁盘。
 *
 * `prepare` 与 `save` 分开是必须的：采集阶段 adapter 需要把原始产物
 * （lighthouse 的 JSON、trace、HAR）写进 run 目录，而那时 RunRecord 还没成型。
 */
export interface RunStorePort {
  /** 创建 run 目录，返回其绝对路径。可重复调用（幂等） */
  prepare(runId: string): Promise<SavedRun>;
  save(run: RunRecord): Promise<SavedRun>;
  /** 原始产物落盘，供诊断下钻取证 */
  saveArtifacts(runId: string, artifacts: readonly RawArtifact[]): Promise<void>;
  /**
   * 诊断结论落盘（`diagnosis.json`），返回绝对路径。
   *
   * 与 run.json 分开存：同一个 run 可以用更新版本的规则集重跑诊断，
   * 覆盖 diagnosis.json 而不动 run.json —— 原始测量数据不该被诊断重跑改写。
   */
  saveDiagnosis(runId: string, diagnosis: Diagnosis): Promise<string>;
  /** 报告落盘，返回绝对路径 */
  saveReport(runId: string, output: ReportOutput): Promise<string>;
  /** 任意 JSON 产物落盘（candidates / decisions / verifications） */
  saveJson(runId: string, filename: string, data: unknown): Promise<string>;
  loadJson(runId: string, filename: string): Promise<unknown | null>;
  /** unified diff 落盘 */
  savePatch(runId: string, candidateId: string, patch: string): Promise<string>;
  loadDiagnosis(runId: string): Promise<Diagnosis | null>;
  load(runId: string): Promise<RunRecord | null>;
  /** 按时间倒序 */
  list(): Promise<RunSummary[]>;
  /** 取同一 project + route + device 的最近一次成功运行，用作默认基线 */
  latestFor(project: string, route: string, device: Device): Promise<RunRecord | null>;
}
