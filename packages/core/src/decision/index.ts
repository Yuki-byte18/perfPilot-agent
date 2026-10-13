import {
  toPerfPilotError,
  type Candidate,
  type Decision,
  type DecisionThresholdSnapshot,
  type LoggerPort,
  type PerfPilotConfig,
  type UtilityBreakdown,
  type Verdict,
} from '@yuki-byte18/shared';
import { checkAllowlist, grade, thresholdsFromConfig } from './grading.js';
import { routeFor } from './routing.js';
import { computeUtility } from './utility.js';

export { checkAllowlist, grade, thresholdsFromConfig } from './grading.js';

export interface DecideInput {
  runId: string;
  candidates: readonly Candidate[];
  createdAt: string;
}

export interface DecisionEngineOptions {
  config: PerfPilotConfig;
  logger: LoggerPort;
}

export interface DecideOutcome {
  decisions: Decision[];
  /** 按裁决分组的计数，供报告首屏直接渲染 */
  counts: Record<Verdict, number>;
  thresholds: DecisionThresholdSnapshot;
}

/**
 * Jev 决策层（README §9）—— 全项目**唯一的决策入口**（硬约束 7）。
 *
 * 三条不可动摇的性质：
 *
 * 1. **纯函数**。没有 IO、没有时间戳以外的外部输入、没有随机数。
 *    同一份候选与配置永远得到同一份裁决 —— 这是 M4 验收标准 1，
 *    也是「历史决策可复现」的全部依据。
 * 2. **不含 LLM**。planner 可以问 LLM 要方案，决策层只能算数。
 *    由 ESLint 规则禁止本目录 import `core/llm`，另有依赖图断言测试兜底。
 * 3. **每个候选恰好一条决策**。包括被拒绝的 —— 「为什么没做」和
 *    「做了什么」一样重要，只记录执行过的候选会让报告失去解释力。
 */
export class DecisionEngine {
  private readonly options: DecisionEngineOptions;

  constructor(options: DecisionEngineOptions) {
    this.options = options;
  }

  decide(input: DecideInput): DecideOutcome {
    const { config, logger } = this.options;

    const thresholds = thresholdsFromConfig(config);
    const decisions: Decision[] = [];

    for (const candidate of input.candidates) {
      try {
        decisions.push(this.decideOne(input, candidate, thresholds));
      } catch (err) {
        const error = toPerfPilotError(err);
        // 单个候选算不出决策不该让整轮失败，降级为 reject 并留下理由
        logger.error('候选决策失败', { candidateId: candidate.id, error: error.message });
        decisions.push({
          id: `dec_${candidate.id}`,
          runId: input.runId,
          candidateId: candidate.id,
          verdict: 'reject',
          route: 'manual',
          score: 0,
          utility: { expectedGain: 0, confidence: 0, cost: 0, risk: 0 },
          riskLevel: 'high',
          reasons: [`决策计算失败：${error.message}`],
          thresholds,
          decidedAt: input.createdAt,
        });
      }
    }

    // 按 utility 降序：报告与 MR 评论先看到最值得做的
    decisions.sort((a, b) => b.score - a.score || a.candidateId.localeCompare(b.candidateId));

    const counts = countVerdicts(decisions);

    logger.debug('决策完成', {
      candidates: input.candidates.length,
      apply: counts.apply,
      confirm: counts.confirm,
      suggest: counts.suggest,
      reject: counts.reject,
    });

    return { decisions, counts, thresholds };
  }

  private decideOne(
    input: DecideInput,
    candidate: Candidate,
    thresholds: DecisionThresholdSnapshot,
  ): Decision {
    const { config } = this.options;

    const utility = computeUtility({
      candidate,
      metricWeights: config.decision.weights.metrics,
      riskAversion: config.decision.weights.risk_aversion,
      thresholds: config.baseline.metrics,
    });

    const allowlist = checkAllowlist(candidate, config.optimization);
    const graded = grade({
      utility: utility.score,
      klass: candidate.class,
      thresholds,
      maxClass: allowlist.maxClass,
      bottleneckKinds: candidate.bottleneckKinds,
    });

    const routed = routeFor(candidate);

    /**
     * `decision.jev: false` —— 不启用效用模型。
     *
     * 这是一个**保守开关**，给「还不敢让工具自动判分」的团队用：
     * 全部候选一律降为 C 类只出建议，不做任何自动裁决。
     *
     * 之所以要有这个语义而不是让开关空着：配置里写着一个不生效的字段，
     * 等于给使用者一个假的保险栓 —— 他以为关掉了，其实什么都没变。
     */
    if (!config.decision.jev) {
      return {
        id: `dec_${candidate.id}`,
        runId: input.runId,
        candidateId: candidate.id,
        verdict: 'suggest',
        route: 'manual',
        score: 0,
        utility: { expectedGain: 0, confidence: 0, cost: 0, risk: 0 },
        riskLevel: riskLevelOf(utility.breakdown.risk, candidate),
        reasons: ['decision.jev=false：未启用效用模型，候选一律只出建议'],
        thresholds,
        decidedAt: input.createdAt,
      };
    }

    /**
     * 路由是 `manual` 的候选**不能**被判 `apply`。
     *
     * `manual` 的含义是"没有执行器能完整处理它"：C 类、不可逆、改动跨多类
     * 执行器、或者压根没有改动项。这种候选若还挂着 `apply`，报告就会写出
     * 自相矛盾的两行 —— 上面 `apply 1`，下面"产出 0 份 patch"，
     * 而真正的原因（"没有执行器能处理改动类型 asset/ast"）藏在执行阶段的备注里。
     * 实测踩到过：LLM 给出的候选把 `asset` 与 `ast` 混在同一个 `changes` 里。
     *
     * 降级成 `suggest` 而不是 `confirm`：`confirm` 的语义是"补丁已生成、
     * 等人工确认"，而 `manual` 连补丁都产不出来。
     */
    const verdict =
      routed.route === 'manual' && graded.verdict === 'apply' ? 'suggest' : graded.verdict;

    return {
      id: `dec_${candidate.id}`,
      runId: input.runId,
      candidateId: candidate.id,
      verdict,
      route: verdict === 'reject' ? 'manual' : routed.route,
      score: utility.score,
      utility: utility.breakdown as UtilityBreakdown,
      riskLevel: riskLevelOf(utility.breakdown.risk, candidate),
      reasons: [
        ...graded.reasons,
        ...(verdict === graded.verdict
          ? []
          : [`没有执行器能完整处理这个候选（${routed.reason}），因此不自动执行`]),
        allowlist.reason,
        routed.reason,
      ],
      thresholds,
      decidedAt: input.createdAt,
    };
  }
}

/**
 * risk 分数 → low/medium/high。
 *
 * 分档对齐分级的基础风险刻度（A=2 / B=6 / C=12，再乘改动面系数）：
 * 单文件 A 类约 2.3、B 类约 6.9、C 类约 13.8。
 */
export function riskLevelOf(risk: number, candidate: Pick<Candidate, 'reversible'>): Decision['riskLevel'] {
  if (!candidate.reversible) return 'high';
  if (risk >= 15) return 'high';
  if (risk >= 6) return 'medium';
  return 'low';
}

function countVerdicts(decisions: readonly Decision[]): Record<Verdict, number> {
  const counts: Record<Verdict, number> = { apply: 0, confirm: 0, suggest: 0, reject: 0 };
  for (const decision of decisions) counts[decision.verdict] += 1;
  return counts;
}

export * from './utility.js';
export * from './routing.js';

