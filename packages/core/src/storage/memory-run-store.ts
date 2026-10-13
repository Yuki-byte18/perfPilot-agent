import type {
  Device,
  Diagnosis,
  RawArtifact,
  ReportOutput,
  RunRecord,
  RunStorePort,
  RunSummary,
  SavedRun,
} from '@yuki-byte18/shared';
import { compareRunRecency } from './file-run-store.js';

export interface MemoryRunStore extends RunStorePort {
  /** 测试断言用：已保存的 run 记录 */
  readonly runs: Map<string, RunRecord>;
  /** 测试断言用：已落盘的报告 */
  readonly reports: Map<string, ReportOutput[]>;
  /** 测试断言用：已落盘的原始产物 */
  readonly artifacts: Map<string, RawArtifact[]>;
  /** 测试断言用：已保存的诊断 */
  readonly diagnoses: Map<string, Diagnosis>;
  readonly json: Map<string, Record<string, unknown>>;
  readonly patches: Map<string, Record<string, string>>;
}

/**
 * 内存存储，用于单测。
 *
 * 存在的意义不只是「快」：它让 pipeline 与 storage 的测试彻底脱离文件系统，
 * 于是 CI 里不会出现「本地过了、容器里因为权限/路径分隔符挂了」这类问题。
 * 也因此 core 的测试不需要先 build 任何东西。
 */
export function createMemoryRunStore(): MemoryRunStore {
  const runs = new Map<string, RunRecord>();
  const reports = new Map<string, ReportOutput[]>();
  const artifacts = new Map<string, RawArtifact[]>();
  const diagnoses = new Map<string, Diagnosis>();
  const json = new Map<string, Record<string, unknown>>();
  const patches = new Map<string, Record<string, string>>();

  const savedRun = (runId: string): SavedRun => ({
    runId,
    dir: `/memory/runs/${runId}`,
    runFile: `/memory/runs/${runId}/run.json`,
  });

  return {
    runs,
    reports,
    artifacts,
    diagnoses,
    json,
    patches,

    prepare: async (runId) => savedRun(runId),

    save: async (run) => {
      runs.set(run.id, run);
      return savedRun(run.id);
    },

    saveArtifacts: async (runId, incoming) => {
      const existing = artifacts.get(runId) ?? [];
      artifacts.set(runId, [...existing, ...incoming]);
    },

    saveDiagnosis: async (runId, diagnosis) => {
      diagnoses.set(runId, diagnosis);
      return `/memory/runs/${runId}/diagnosis.json`;
    },

    saveReport: async (runId, output) => {
      const existing = reports.get(runId) ?? [];
      reports.set(runId, [...existing, output]);
      return `/memory/runs/${runId}/${output.filename}`;
    },

    saveJson: async (runId, filename, data) => {
      const existing = json.get(runId) ?? {};
      existing[filename] = data;
      json.set(runId, existing);
      return `/memory/runs/${runId}/${filename}`;
    },

    loadJson: async (runId, filename) => json.get(runId)?.[filename] ?? null,

    savePatch: async (runId, candidateId, patch) => {
      const existing = patches.get(runId) ?? {};
      existing[candidateId] = patch;
      patches.set(runId, existing);
      return `/memory/runs/${runId}/patches/${candidateId}.patch`;
    },

    loadDiagnosis: async (runId) => diagnoses.get(runId) ?? null,

    load: async (runId) => runs.get(runId) ?? null,

    list: async (): Promise<RunSummary[]> =>
      [...runs.values()]
        .map((run) => ({
          id: run.id,
          project: run.project,
          route: run.route,
          device: run.device,
          status: run.status,
          startedAt: run.startedAt,
          metricCount: run.metrics.length,
        }))
        .sort(compareRunRecency),

    latestFor: async (project, route, device: Device) => {
      const matched = [...runs.values()]
        .filter((r) => r.project === project && r.route === route && r.device === device)
        .sort(compareRunRecency);
      return matched[0] ?? null;
    },
  };
}
