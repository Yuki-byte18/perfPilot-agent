import {
  toPerfPilotError,
  type BaselineRef,
  type Diagnosis,
  type LlmPort,
  type LoggerPort,
  type Metric,
  type MetricDelta,
  type PerfPilotConfig,
  type RawArtifact,
  type SourceMapPort,
} from '@yuki-byte18/shared';
import { buildEvidence, mergeFindings, type MergeOutcome } from './agent.js';
import { mergeDetections } from './merge.js';
import { BUILTIN_RULES, RULE_SET_VERSION } from './rules/index.js';
import type { Detection, DiagnosticRule, RuleContext } from './types.js';

export interface DiagnoseInput {
  diagnosisId: string;
  runId: string;
  project: string;
  route: string;
  device: Diagnosis['device'];
  metrics: readonly Metric[];
  deltas: readonly MetricDelta[];
  artifacts: readonly RawArtifact[];
  baseline: BaselineRef | null;
  createdAt: string;
}

export interface DiagnoserOptions {
  config: PerfPilotConfig;
  /** 规则集；不传用内置的 */
  rules?: readonly DiagnosticRule[];
  /** Source Map 解析；不传则规则降级为「只能归因到产物」 */
  sourceMap?: SourceMapPort | null;
  /**
   * LLM 端口（诊断 agent）。
   *
   * 不传、或 `config.llm.provider === 'none'`、或 `config.llm.diagnose === false`
   * 时，诊断完全由确定性规则完成 —— 这是默认行为。
   */
  llm?: LlmPort | null;
  logger: LoggerPort;
}

export interface DiagnoseOutcome {
  diagnosis: Diagnosis;
  /** 每条规则的命中条数，用于观测「某条规则是不是哑了」 */
  ruleHits: Array<{ ruleId: string; detections: number }>;
  /** 诊断 agent 的成本（美元）；未启用时为 0 */
  llmCostUsd: number;
  /**
   * 诊断 agent 的采纳情况。
   *
   * **必须外传**：LLM 说了但没被采纳的结论，是最容易被误解的部分 ——
   * 用户会问"我花钱让它看，它说的怎么没进报告"。把丢弃原因留下来才有解释力。
   */
  llm: {
    enabled: boolean;
    adopted: number;
    refined: string[];
    dropped: MergeOutcome['dropped'];
  };
}

/**
 * 规则引擎。
 *
 * 设计上是**纯计算 + 逐条隔离**：
 * 1. **纯计算**：输入是已经采集好的指标与产物，没有 IO（唯一的例外是经
 *    `SourceMapPort` 读 .map 文件，那是受控的）。因此同一份 run 重跑诊断
 *    必然得到同样的结论 —— 这是「诊断可复现」的前提，也是快照测试能成立的前提。
 * 2. **逐条隔离**：一条规则抛异常只让这条规则失效，其余照常。
 *    规则是增长最快的部分，一条新规则写崩了不该让整个诊断输出为空。
 */
export class Diagnoser {
  private readonly options: DiagnoserOptions;
  private readonly rules: readonly DiagnosticRule[];

  constructor(options: DiagnoserOptions) {
    this.options = options;
    this.rules = options.rules ?? BUILTIN_RULES;
  }

  async diagnose(input: DiagnoseInput): Promise<DiagnoseOutcome> {
    const { logger, config } = this.options;

    const ctx: RuleContext = {
      metrics: input.metrics,
      deltas: input.deltas,
      artifacts: input.artifacts,
      baseline: input.baseline,
      config,
      sourceMap: this.options.sourceMap ?? null,
      thresholds: config.baseline.metrics,
    };

    const ruleHits: DiagnoseOutcome['ruleHits'] = [];
    const byKind = new Map<string, { kind: DiagnosticRule['kind']; detections: Detection[] }>();

    for (const rule of this.rules) {
      let detections: Detection[] = [];
      try {
        detections = await rule.detect(ctx);
      } catch (err) {
        const error = toPerfPilotError(err);
        // 单条规则失败不影响其余规则：规则集是增长最快的部分
        logger.error('诊断规则执行失败', { ruleId: rule.id, code: error.code, error: error.message });
        ruleHits.push({ ruleId: rule.id, detections: 0 });
        continue;
      }

      ruleHits.push({ ruleId: rule.id, detections: detections.length });
      if (detections.length === 0) continue;

      const bucket = byKind.get(rule.kind) ?? { kind: rule.kind, detections: [] };
      bucket.detections.push(...detections);
      byKind.set(rule.kind, bucket);
    }

    const ruleBottlenecks = [...byKind.values()]
      .flatMap(({ kind, detections }) => mergeDetections(input.runId, kind, detections))
      .sort(
        (a, b) =>
          b.severity - a.severity ||
          b.confidence - a.confidence ||
          a.title.localeCompare(b.title),
      );

    logger.debug('确定性规则完成', {
      rules: this.rules.length,
      bottlenecks: ruleBottlenecks.length,
      hitRules: ruleHits.filter((h) => h.detections > 0).length,
    });

    // ── 诊断 agent：复核 + 补充 ────────────────────────────────────
    const agent = await this.runAgent(input, ruleBottlenecks, logger);
    const bottlenecks = agent.bottlenecks;

    logger.debug('诊断完成', {
      ruleBottlenecks: ruleBottlenecks.length,
      final: bottlenecks.length,
      llmAdopted: agent.llm.adopted,
      llmCostUsd: agent.llmCostUsd,
    });

    const regressions = input.deltas.filter((d) => (d.scoreDelta ?? 0) < 0);

    return {
      diagnosis: {
        id: input.diagnosisId,
        runId: input.runId,
        project: input.project,
        route: input.route,
        device: input.device,
        baselineRef: input.baseline?.ref ?? null,
        metrics: [...input.metrics],
        baselineMetrics: input.baseline?.metrics ?? [],
        deltas: [...input.deltas],
        regressions,
        bottlenecks,
        summary: summarize(bottlenecks, regressions, input.baseline !== null),
        ruleSetVersion: RULE_SET_VERSION,
        createdAt: input.createdAt,
      },
      ruleHits,
      llmCostUsd: agent.llmCostUsd,
      llm: agent.llm,
    };
  }

  /**
   * 跑诊断 agent 并合并结论。
   *
   * **一条指标都没有时不调用**：没有任何数据可看，叫 LLM 只会得到一个
   * 编出来的结论（它很擅长在空白上生成合理的话）。那种"看起来像诊断"的输出
   * 比没有诊断更糟。
   *
   * 失败一律降级为"只用规则结论"：诊断 agent 是增强，不是依赖。
   */
  private async runAgent(
    input: DiagnoseInput,
    ruleBottlenecks: Diagnosis['bottlenecks'],
    logger: LoggerPort,
  ): Promise<{
    bottlenecks: Diagnosis['bottlenecks'];
    llmCostUsd: number;
    llm: DiagnoseOutcome['llm'];
  }> {
    const { config, llm } = this.options;
    const disabled = {
      bottlenecks: ruleBottlenecks,
      llmCostUsd: 0,
      llm: { enabled: false, adopted: 0, refined: [], dropped: [] },
    };

    const enabled =
      llm !== undefined &&
      llm !== null &&
      config.llm !== null &&
      config.llm.provider !== 'none' &&
      config.llm.diagnose;

    if (!enabled || llm === null || llm === undefined) return disabled;
    if (input.metrics.length === 0) {
      logger.warn('没有任何指标，跳过诊断 agent：没有数据时它只能编');
      return disabled;
    }

    try {
      const evidence = buildEvidence({
        metrics: input.metrics,
        deltas: input.deltas,
        artifacts: input.artifacts,
      });

      const output = await llm.diagnose(
        {
          runId: input.runId,
          project: input.project,
          route: input.route,
          device: input.device,
          evidence,
          ruleFindings: ruleBottlenecks,
        },
        logger,
      );

      const merged = mergeFindings(ruleBottlenecks, output.findings);

      logger.info('诊断 agent 完成', {
        promptVersion: output.promptVersion,
        findings: output.findings.length,
        adopted: merged.adopted,
        refined: merged.refined.length,
        dropped: merged.dropped.length,
        costUsd: output.cost.usd,
      });

      return {
        bottlenecks: merged.bottlenecks,
        llmCostUsd: output.cost.usd,
        llm: {
          enabled: true,
          adopted: merged.adopted,
          refined: merged.refined,
          dropped: merged.dropped,
        },
      };
    } catch (err) {
      const error = toPerfPilotError(err);
      logger.warn('诊断 agent 失败，降级为仅确定性规则', { error: error.message });
      return disabled;
    }
  }
}

/**
 * 首屏摘要。
 *
 * 刻意把「回归」与「瓶颈」分开说：回归是「这次比上次差了」，
 * 瓶颈是「这里本来就有问题」。两者常常同时出现但不是一回事 ——
 * 一次没有任何回归的提交，仍然可能留下 8 个瓶颈。
 */
export function summarize(
  bottlenecks: Diagnosis['bottlenecks'],
  regressions: readonly MetricDelta[],
  hasBaseline: boolean,
): string {
  if (bottlenecks.length === 0) {
    return hasBaseline
      ? `未发现瓶颈，且 ${regressions.length === 0 ? '无指标回归' : `有 ${regressions.length} 项指标回归`}。`
      : '未发现瓶颈。';
  }

  const top = bottlenecks.slice(0, 3).map((b) => b.kind).join('、');
  const severe = bottlenecks.filter((b) => b.severity >= 60).length;

  const parts = [`发现 ${bottlenecks.length} 个瓶颈`];
  if (severe > 0) parts.push(`其中 ${severe} 个严重度 ≥ 60`);
  parts.push(`首要问题：${top}`);

  if (hasBaseline) {
    parts.push(regressions.length === 0 ? '无指标回归' : `${regressions.length} 项指标回归`);
  } else {
    parts.push('无基线，未做回归判定');
  }

  return `${parts.join('；')}。`;
}

export { mergeDetections } from './merge.js';
export * from './types.js';
export * from './artifacts.js';
export { buildEvidence, mergeFindings, findingKey, MAX_NEW_FINDINGS } from './agent.js';
export { BUILTIN_RULES, RULE_SET_VERSION } from './rules/index.js';
