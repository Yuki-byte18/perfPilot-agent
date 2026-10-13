import type { BottleneckKind } from '../types/bottleneck.js';
import type { Candidate } from '../schema/candidate.js';

/**
 * 记忆端口（README §10）。
 *
 * 四类记忆，同一套接口，SQLite（本地）/ Postgres（服务）两种实现。
 * core/memory 只依赖这个接口，不直接 import 数据库驱动。
 */

/** 历史诊断记录 */
export interface DiagnosisHistoryEntry {
  id: string;
  runId: string;
  project: string;
  route: string;
  bottleneckKinds: BottleneckKind[];
  createdAt: string;
}

/** 方案库条目：已验证收益的候选 */
export interface CandidateLibraryEntry {
  id: string;
  bottleneckKind: BottleneckKind;
  candidate: Candidate;
  /** 实际收益（归一化分数之和）；未验证时为 null */
  actualGain: number | null;
  /**
   * 实际的**逐指标原始变化量**（LCP -1500（ms）、IMAGE_SIZE -82000（byte）…）。
   *
   * 与 `actualGain` 的区别很重要：后者是归一化分数（给门禁用），
   * 而 planner 的 `expectedGain` 用的是**原始单位** —— 要反哺标定，
   * 就必须留住原始量，否则两者根本不是一个刻度。
   *
   * 旧数据没有这个字段（可选）。
   */
  actualGainByMetric?: Record<string, number>;
  /** true=成功保留，false=回滚 */
  succeeded: boolean;
  project: string;
  techStack: string;
  createdAt: string;
}

/** 项目画像 */
export interface ProjectProfile {
  project: string;
  techStack: string;
  buildTool: string;
  framework: string;
  baselineMetrics: Record<string, number>;
  updatedAt: string;
}

/** 失败记忆：哪些修复在什么上下文下失败过 */
export interface FailureMemoryEntry {
  id: string;
  candidateFingerprint: string;
  bottleneckKind: BottleneckKind;
  failureReason: string;
  project: string;
  techStack: string;
  failedAt: string;
}

/** 召回结果 */
export interface RecallResult {
  /** 按项目召回的历史方案 */
  byProject: CandidateLibraryEntry[];
  /** 按问题类型（BottleneckKind）召回的历史方案 */
  byKind: CandidateLibraryEntry[];
  /** 按技术栈召回的历史方案 */
  byTechStack: CandidateLibraryEntry[];
  /** 匹配到的失败记忆 */
  failures: FailureMemoryEntry[];
}

export interface MemoryPort {
  // ── 历史诊断 ──────────────────────────────────────────────────
  saveDiagnosis(entry: DiagnosisHistoryEntry): Promise<void>;
  listDiagnoses(project: string, route: string, limit: number): Promise<DiagnosisHistoryEntry[]>;

  // ── 方案库 ────────────────────────────────────────────────────
  saveCandidate(entry: CandidateLibraryEntry): Promise<void>;
  /** 召回：按优先级 项目 > 问题类型 > 技术栈 */
  recallCandidates(input: {
    project: string;
    bottleneckKinds: BottleneckKind[];
    techStack: string;
    limit: number;
  }): Promise<RecallResult>;

  // ── 项目画像 ──────────────────────────────────────────────────
  saveProfile(profile: ProjectProfile): Promise<void>;
  getProfile(project: string): Promise<ProjectProfile | null>;

  // ── 失败记忆 ──────────────────────────────────────────────────
  saveFailure(entry: FailureMemoryEntry): Promise<void>;
  /** 检查某个候选指纹是否在失败记忆里 */
  hasFailedFailure(fingerprint: string, project: string): Promise<boolean>;
  listFailures(project: string, limit: number): Promise<FailureMemoryEntry[]>;
  /**
   * 忘记失败记忆。
   *
   * ## 为什么必须有这条出口
   *
   * 失败记忆是**一票否决**：命中就不再提案。它的判据是「瓶颈类型 + 改动类型」的指纹，
   * 不含文件路径 —— 也就是说，一次误判会让**这一类改动**在**这个项目上**永久消失。
   *
   * 什么情况会误判？测试环境当时坏了、预览环境没起来、门禁阈值被临时调紧过……
   * 这些都不是"这个改法不行"，而是"那次运行不行"。没有撤销入口的话，
   * 用户唯一的办法是删库 —— 而删库会连带着丢掉所有别的好记忆。
   *
   * 两种粒度：`fingerprint` 精确忘掉一条；`all: true` 清空该项目的全部失败记忆。
   */
  forgetFailures(input: {
    project: string;
    /** 只忘掉这个指纹；不传则按 `all` 决定 */
    fingerprint?: string;
    /** true = 清空该项目的全部失败记忆 */
    all?: boolean;
  }): Promise<number>;
}

/**
 * 纯内存实现。
 *
 * 放在 shared 是因为它是端口的替身 —— 单测与本地开发都需要，
 * 而 core 不允许 import 具体实现（硬约束 4）。
 */
export function createInMemoryMemory(): MemoryPort {
  const diagnoses: DiagnosisHistoryEntry[] = [];
  const candidates: CandidateLibraryEntry[] = [];
  const profiles = new Map<string, ProjectProfile>();
  const failures: FailureMemoryEntry[] = [];

  return {
    async saveDiagnosis(entry) {
      diagnoses.push(entry);
    },
    async listDiagnoses(project, route, limit) {
      return diagnoses
        .filter((d) => d.project === project && d.route === route)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(0, limit);
    },

    async saveCandidate(entry) {
      candidates.push(entry);
    },
    async recallCandidates({ project, bottleneckKinds, techStack, limit }) {
      const kinds = new Set(bottleneckKinds);
      const byProject = candidates
        .filter((c) => c.project === project && kinds.has(c.bottleneckKind))
        .slice(0, limit);
      const byKind = candidates
        .filter((c) => kinds.has(c.bottleneckKind))
        .slice(0, limit);
      const byTechStack = candidates
        .filter((c) => c.techStack === techStack && kinds.has(c.bottleneckKind))
        .slice(0, limit);
      const matchedFailures = failures.filter((f) => kinds.has(f.bottleneckKind));
      return { byProject, byKind, byTechStack, failures: matchedFailures };
    },

    async saveProfile(profile) {
      profiles.set(profile.project, profile);
    },
    async getProfile(project) {
      return profiles.get(project) ?? null;
    },

    async saveFailure(entry) {
      failures.push(entry);
    },
    async hasFailedFailure(fingerprint, project) {
      return failures.some((f) => f.candidateFingerprint === fingerprint && f.project === project);
    },
    async listFailures(project, limit) {
      return failures
        .filter((f) => f.project === project)
        .sort((a, b) => b.failedAt.localeCompare(a.failedAt))
        .slice(0, limit);
    },

    async forgetFailures({ project, fingerprint, all }) {
      const doomed = failures.filter(
        (f) =>
          f.project === project &&
          (all === true || (fingerprint !== undefined && f.candidateFingerprint === fingerprint)),
      );

      for (const entry of doomed) {
        const index = failures.indexOf(entry);
        if (index >= 0) failures.splice(index, 1);
      }

      return doomed.length;
    },
  };
}

/**
 * 根据召回结果调整置信度（README §10）。
 *
 * confidence' = clamp(confidence + α × successRate − β × failureRate, 0, 1)
 *
 * 成功过的方案更自信，失败过的方案更保守。
 * 这是 planner 消费记忆的唯一入口，保证调整逻辑确定、可测。
 */
export function adjustConfidenceByRecall(
  baseConfidence: number,
  recall: RecallResult,
): number {
  const all = [...recall.byProject, ...recall.byKind, ...recall.byTechStack];
  if (all.length === 0 && recall.failures.length === 0) return baseConfidence;

  const successes = all.filter((c) => c.succeeded && c.actualGain !== null).length;
  const totalAttempts = all.length + recall.failures.length;
  if (totalAttempts === 0) return baseConfidence;

  const successRate = successes / totalAttempts;
  const failureRate = recall.failures.length / totalAttempts;

  const ALPHA = 0.15; // 成功加权系数
  const BETA = 0.25; // 失败惩罚系数（大于 α：失败的惩罚重于成功的奖励）

  const adjusted = baseConfidence + ALPHA * successRate - BETA * failureRate;
  return Math.max(0, Math.min(1, adjusted));
}
