import {
  METRIC_SPECS,
  formatSignedScore,
  formatValue,
  type MetricDelta,
  type PerfPilotConfig,
  type RunRecord,
} from '@yuki-byte18/shared';

/**
 * CI 性能门禁（README §12、M7 验收 1）。
 *
 * ## 门禁判的是「这次改动让性能变差了吗」，不是「性能好不好」
 *
 * 这个区别决定了门禁能不能用。如果按绝对值判（LCP < 2.5s 才算过），
 * 一个本来就不达标的项目会**永远红着** —— 于是所有人学会忽略这个信号，
 * 门禁就白做了。按**回归**判则永远有明确含义：这次提交让哪一项变差了多少，
 * 超没超过允许的抖动范围。
 *
 * ## 为什么是纯函数
 *
 * 「同一 commit 跑两次结论一致」（验收 5）不是靠重跑验证的，是靠结构保证的：
 * 这个函数只看 `RunRecord` 与配置，不看时间、不看环境变量、不看随机数。
 * 要重跑复现，只需要把 `run.json` 喂进来。
 */

export interface CiGateResult {
  passed: boolean;
  /** 未通过的原因，逐条可读；通过时为空 */
  failures: string[];
  /** 逐项判定明细，进日志与 MR 评论 */
  checks: CiGateCheck[];
}

export interface CiGateCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface CiGateInput {
  run: RunRecord;
  config: PerfPilotConfig;
  /** 覆盖配置里的阈值（`--max-regression`），用于临时放宽/收紧 */
  maxRegression?: number;
}

/** 允许抖动的默认阈值。与决策层的 `max_regression` 同源，语义一致 */
function resolveMaxRegression(input: CiGateInput): number {
  return input.maxRegression ?? input.config.decision.thresholds.max_regression;
}

export function evaluateCiGate(input: CiGateInput): CiGateResult {
  const { run } = input;
  const maxRegression = resolveMaxRegression(input);
  const checks: CiGateCheck[] = [];

  // ── 1. 采集是否可用 ────────────────────────────────────────────
  /**
   * 零指标时**必须失败**，而不是"没有回归所以通过"。
   *
   * 这是 CI 门禁最危险的失效模式：Lighthouse 没装、预览环境没起来，
   * 采集全挂 → 没有指标 → 没有差值为负 → 显示绿灯。
   * 用户看到绿色，以为性能没问题，实际上什么都没测。
   */
  checks.push({
    name: 'collection',
    passed: run.metrics.length > 0,
    detail:
      run.metrics.length > 0
        ? `采集到 ${run.metrics.length} 项指标`
        : '本次没有采集到任何指标 —— 门禁无法判定，按不通过处理',
  });

  // ── 2. 采集完整性 ──────────────────────────────────────────────
  /**
   * 只把「探活通过、跑起来却失败了」当门禁失败。
   *
   * 第一版写的是"有任何 degraded 告警就失败"，结果**每个项目都会永久红灯**：
   * 没有 HAR、没有 trace、没有 web-vitals 上报的项目，每个可选来源都会记一条
   * `ADAPTER_UNAVAILABLE` —— 那是设计上的正常状态，不是故障。
   * 一个永远红的门禁等于没有门禁：大家学会忽略它。
   *
   * 这三个 code 的含义不同：来源本该可用，却在这一次运行里失败了。
   * 此时指标是不完整的，而且**不完整的方式不可预期** —— 那才是该拦的。
   * （可选来源缺失会不会导致"什么都没测到"，由上面那条 `collection` 兜住。）
   */
  const BROKEN_SOURCE_CODES = new Set(['COLLECT_FAILED', 'ADAPTER_FAILED', 'ADAPTER_OUTPUT_INVALID']);
  const broken = run.warnings.filter(
    (w) => w.severity === 'degraded' && BROKEN_SOURCE_CODES.has(w.code),
  );

  checks.push({
    name: 'collection-integrity',
    passed: broken.length === 0,
    detail:
      broken.length === 0
        ? '没有数据源在运行中失败'
        : `${broken.length} 个数据源运行中失败，指标不完整：${broken.map((w) => `${w.adapter ?? '—'}/${w.code}`).join('、')}`,
  });

  // ── 3. 回归 ────────────────────────────────────────────────────
  const comparable: MetricDelta[] = run.deltas.filter((d) => d.scoreDelta !== null);
  const regressions = comparable
    .filter((d) => (d.scoreDelta ?? 0) < 0)
    .sort((a, b) => (a.scoreDelta ?? 0) - (b.scoreDelta ?? 0));

  const worst = regressions[0];
  const worstAmount = worst === undefined ? 0 : Math.abs(worst.scoreDelta ?? 0);

  /**
   * 无基线时**不判回归**。
   *
   * 第一次运行、或者换了测量来源（`source` 变了 → `computeDelta` 会置空
   * `scoreDelta`）时，差值本身不存在。此时判"通过"是诚实的 ——
   * 没有可比的数据，就没有回归这回事。而"没有数据"这一情况已被上面两条拦住了。
   */
  checks.push({
    name: 'regression',
    passed: worstAmount <= maxRegression,
    detail:
      comparable.length === 0
        ? '无可用基线，本次不判定回归（本次结果将成为后续基线）'
        : worst === undefined
          ? `${comparable.length} 项指标均无回归`
          : `最大回归 ${worst.name} ${formatSignedScore(worst.scoreDelta)}（允许 ${maxRegression}）`,
  });

  // ── 4. 逐指标阈值（配置里显式给了 warning/error 的才判） ────────
  /**
   * 这一条是**可选的绝对阈值**，只有当用户在 `baseline.metrics` 里显式
   * 配了 `error` 边界时才生效。
   *
   * 默认不判绝对值（理由见文件头）：绝大多数项目的现状都不达标，
   * 那样的门禁只会被关掉。但有的团队确实想卡一个底线 —— 那就明说，
   * 而不是由工具替他们决定。
   */
  for (const metric of run.metrics) {
    const config_ = input.config.baseline.metrics[metric.name];
    if (config_ === undefined) continue;

    const spec = METRIC_SPECS[metric.name];
    const over = metric.value > config_.error;
    checks.push({
      name: `threshold:${metric.name}`,
      passed: !over,
      detail: over
        ? `${metric.name} ${formatValue(metric.value, spec.unit, spec.precision)} 超过 error 阈值 ${formatValue(config_.error, spec.unit, spec.precision)}`
        : `${metric.name} 在 error 阈值内`,
    });
  }

  // ── 5. 自动改动的验证结论 ──────────────────────────────────────
  /**
   * 回滚**不算门禁失败**（与 `fix` 的退出码约定一致）：
   * 一次回滚说明不合格的改动被拦下来了，那正是这个工具存在的意义。
   * 但如果回滚之后**工作区没恢复干净**（`reverted: false`），那是真问题 ——
   * 仓库可能处于中间状态，必须拦。
   */
  const failedRevert = run.stages.find((s) => s.name === 'verify');
  checks.push({
    name: 'rollback-integrity',
    passed: failedRevert === undefined || failedRevert.status !== 'failed',
    detail:
      failedRevert?.status === 'failed'
        ? `验证阶段失败：${failedRevert.note ?? '未知原因'}`
        : '验证阶段无异常',
  });

  const failures = checks.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`);
  return { passed: failures.length === 0, failures, checks };
}
