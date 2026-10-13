import type { Bottleneck } from '../schema/bottleneck.js';
import type { Candidate } from '../schema/candidate.js';
import type { Diagnosis } from '../schema/diagnosis.js';
import type { LoggerPort } from './logger.js';

/**
 * LLM 端口（硬约束 6：所有 LLM 调用必须经过这里）。
 *
 * 这是 core 唯一允许接触 LLM SDK 的出口。planner 通过它生成候选方案，
 * 其它模块（尤其 decision）**禁止**持有 LLM client。
 *
 * 刻意把 prompt 版本化：`promptVersion` 会写进 Candidate，
 * 历史候选要能解释「为什么这次 LLM 给的方案不一样」。
 */

/** LLM 生成候选的输入 */
export interface LlmPlanInput {
  diagnosis: Diagnosis;
  /** 需要 LLM 出方案的瓶颈 */
  bottlenecks: Bottleneck[];
  runId: string;
  project: string;
  route: string;
  /**
   * 规则库**已经给出**的候选。
   *
   * 必须在 prompt 里带上：否则 LLM 会把同一个改法换个说法再提一遍，
   * 然后在"同种改动"去重时被丢掉 —— 用户看到的是"花了钱但没产出"。
   */
  existingCandidates?: Candidate[];
}

/** 单次 LLM 调用的成本 */
export interface LlmCost {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** 美元成本 */
  usd: number;
}

/** LLM 调用结果 */
export interface LlmPlanOutput {
  candidates: Candidate[];
  cost: LlmCost;
  promptVersion: string;
}

/**
 * 交给诊断 agent 的证据。
 *
 * **是摘要，不是原始产物。** 一份 Lighthouse JSON 几 MB、HAR 十几 MB，
 * 原样塞进 prompt 会同时撑爆上下文与预算。抽取逻辑在 `core/diagnoser`，
 * 这里只声明契约。
 */
export interface DiagnoseEvidence {
  metrics: Array<{
    name: string;
    value: number;
    unit: string;
    rating: string;
    score: number | null;
  }>;
  deltas: Array<{ name: string; delta: number | null; scoreDelta: number | null }>;
  /** 来源名 → 该来源的要点（结构随来源而异，由 core 侧抽取） */
  sources: Record<string, unknown>;
}

/** 诊断 agent 的输入 */
export interface LlmDiagnoseInput {
  runId: string;
  project: string;
  route: string;
  device: string;
  evidence: DiagnoseEvidence;
  /**
   * 确定性规则已经给出的结论。
   *
   * **必须传**：LLM 的任务是「复核 + 补充」，不是从零猜。
   * 不给它规则结论，它会把同一条问题换个说法再说一遍（然后被去重丢掉），
   * 白花钱还看不出价值。
   */
  ruleFindings: Bottleneck[];
}

/** 诊断 agent 的一条结论：瓶颈本体 + 它在复核哪条规则结论（若有） */
export interface LlmFinding {
  /** 已经过 schema 校验、并且由 core/llm 盖好 id / runId / source 的瓶颈 */
  bottleneck: Bottleneck;
  /** 它声称在复核的那条规则结论 id；不是复核时为 null */
  refines: string | null;
}

/** 诊断 agent 的输出 */
export interface LlmDiagnoseOutput {
  findings: LlmFinding[];
  cost: LlmCost;
  promptVersion: string;
}

export interface LlmPort {
  /**
   * 基于诊断结果生成候选方案。
   *
   * 实现要点：
   * 1. prompt 版本化（`promptVersion` 写入每个候选）
   * 2. 输出必须经 CandidateSchema 校验，失败的候选丢弃并告警
   * 3. 成本记账，超 `maxCostUsd` 时停止并返回已生成的候选
   */
  plan(input: LlmPlanInput, logger: LoggerPort): Promise<LlmPlanOutput>;

  /**
   * 诊断 agent：读原始证据做归因复核与补充。
   *
   * 与 `plan` 的分工是这个项目的核心判断：
   * - **诊断**可以由 LLM 主导（"这里为什么慢"是开放问题，规则只能覆盖已知模式）
   * - **决策**永远不行（"改不改"必须可复现，见硬约束 7）
   */
  diagnose(input: LlmDiagnoseInput, logger: LoggerPort): Promise<LlmDiagnoseOutput>;
}

/**
 * 空实现：provider=none 时使用。
 *
 * 放在 shared 而不是 core/llm：它是端口的替身，
 * 单测与「未配置 LLM」的场景都需要它，但 core/llm 不应该被其它模块直接引用。
 */
export function createNullLlm(): LlmPort {
  const noCost: LlmCost = { inputTokens: 0, outputTokens: 0, totalTokens: 0, usd: 0 };

  return {
    async plan(_input: LlmPlanInput) {
      return { candidates: [], cost: noCost, promptVersion: 'none' };
    },
    async diagnose(_input: LlmDiagnoseInput) {
      return { findings: [], cost: noCost, promptVersion: 'none' };
    },
  };
}
