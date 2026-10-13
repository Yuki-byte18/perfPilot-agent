import {
  computeDeltas,
  toPerfPilotError,
  type Candidate,
  type CheckKind,
  type CheckRunnerPort,
  type ErrorScanPort,
  type GitPort,
  type LoggerPort,
  type MemoryPort,
  type Metric,
  type MetricDelta,
  type PerfPilotConfig,
  type RunStorePort,
  type ToolRoute,
  type Verification,
  type VerificationCheck,
} from '@yuki-byte18/shared';
import { failureReasonOf, recordFailure, resolveTechStack } from '../memory/index.js';

/**
 * 验证器（README §2「验证」、§3 执行链路）。
 *
 * 这个模块是整个项目"敢开自动化"的最后一道闸：
 * **所有优化必须经过验证才能保留**（硬约束 8），**失败必须回滚**（硬约束 9）。
 *
 * 四项检查全过才保留：
 *   单测 + 类型检查 + lint + E2E  → 代码没坏
 *   重新采集 → 指标确实变好了，而不是估算出来的
 *   收益对比 → 好到了阈值
 *   错误扫描 → 没有引入新错误
 */

export type VerifiableCheckKind = Exclude<CheckKind, 'recollect' | 'error-scan' | 'bundle-size'>;

/**
 * 默认跑哪些检查。E2E 通常很慢，因此可按项目配置裁剪。
 *
 * `build` 排在最前是**正确性要求**，不是风格问题：下面第 2 步就要重采集，
 * 而采集读的是构建产物（`dist/`、部署地址）。改动写在源码 / 配置 / 依赖上，
 * 不先重建，重采集测到的还是改动前的产物 —— 收益恒为 0、候选必然回滚，
 * 而报告给出的理由是"收益不足"。这个坑在真实项目上必然踩到。
 *
 * 项目没有 `build` 脚本时它会记为 skipped（跳过 ≠ 失败），不会误伤。
 */
export const DEFAULT_CHECK_KINDS: readonly VerifiableCheckKind[] = [
  'build',
  'unit-test',
  'type-check',
  'lint',
  'e2e',
];

export interface VerifyInput {
  runId: string;
  /** 被验证的候选。验证结果要按候选留痕，失败记忆还需要它的瓶颈类型与改动指纹 */
  candidate: Candidate;
  route: ToolRoute;
  /** 改动前的指标（基线）：即本轮 collect 的结果 */
  baselineMetrics: readonly Metric[];
  /** 改动前的 git ref —— 回滚目标 */
  baseRef: string;
  /** 错误扫描的起始时刻（只算这之后新增的错误） */
  startedAtIso: string;
  /**
   * 重新采集指标。
   *
   * 由**流水线逐次传入**，而不是组合根在构造时注入：重采集需要知道
   * 「当前这条路由、这个设备、写进哪个目录」，这些是一次运行的知识。
   * 做成构造期闭包就得让组合根持有一个会变的"当前运行上下文" ——
   * 那正是 ADR 005 要避免的隐式全局状态。
   */
  recollect: () => Promise<Metric[]>;
}

export interface VerifierOptions {
  config: PerfPilotConfig;
  checkRunner: CheckRunnerPort;
  git: GitPort;
  errorScan: ErrorScanPort;
  store: RunStorePort;
  logger: LoggerPort;
  /** 失败记忆。不传时验证照常，只是不积累"这个改法失败过"的经验 */
  memory?: MemoryPort | null;
  /** 跑哪些检查 */
  checkKinds?: readonly VerifiableCheckKind[];
  projectRoot: string;
}

export interface VerifyOutcome {
  verification: Verification;
  /** 是否保留 */
  kept: boolean;
}

export class Verifier {
  private readonly options: VerifierOptions;

  constructor(options: VerifierOptions) {
    this.options = options;
  }

  async verify(input: VerifyInput): Promise<VerifyOutcome> {
    const { config, checkRunner, errorScan, store, logger } = this.options;
    const thresholds = config.decision.thresholds;
    const checkKinds = this.options.checkKinds ?? DEFAULT_CHECK_KINDS;
    const candidateId = input.candidate.id;

    logger.info('开始验证', { candidateId, route: input.route });

    // ── 1. 代码层检查 ──────────────────────────────────────────────
    const checks: VerificationCheck[] = [];
    for (const kind of checkKinds) {
      const started = performance.now();
      try {
        const result = await checkRunner.run(kind, this.options.projectRoot);
        const skipped = result.skipped ?? false;
        checks.push({
          kind,
          passed: result.passed,
          skipped,
          durationMs: result.durationMs,
          // 通过的检查不需要正文；但**跳过**的要留下「为什么跳过」——
          // 否则报告里「跳过的 E2E」和「通过的 E2E」长得一模一样
          output: result.passed && !skipped ? null : truncate(result.output),
        });
      } catch (err) {
        const error = toPerfPilotError(err);
        checks.push({
          kind,
          passed: false,
          skipped: false,
          durationMs: Math.round(performance.now() - started),
          output: `检查无法运行：${error.message}`,
        });
      }
    }

    // ── 2. 重新采集 ────────────────────────────────────────────────
    const recollectStarted = performance.now();
    let currentMetrics: Metric[] = [];
    let recollectError: string | null = null;

    try {
      currentMetrics = await input.recollect();
    } catch (err) {
      recollectError = toPerfPilotError(err).message;
      logger.error('重新采集失败', { candidateId, error: recollectError });
    }

    checks.push({
      kind: 'recollect',
      passed: recollectError === null && currentMetrics.length > 0,
      skipped: false,
      durationMs: Math.round(performance.now() - recollectStarted),
      output: recollectError ?? (currentMetrics.length === 0 ? '重采集未产出任何指标' : null),
    });

    // ── 3. 收益对比 ────────────────────────────────────────────────
    const deltas: MetricDelta[] = computeDeltas(
      currentMetrics,
      input.baselineMetrics,
      config.baseline.metrics,
    );
    const comparable = deltas.filter((d) => d.scoreDelta !== null);

    /**
     * 收益与回归的口径。
     *
     * `gain` 取可比指标分数变化之**和**：整体变好了多少。
     * `worstRegression` 取**单项最大倒退**：任何一项明显变差都要拦。
     *
     * 为什么不用同一个数：总和为正但某一项暴跌是完全可能的
     * （LCP 快了 800ms，CLS 从 0.05 涨到 0.4）。只看总和会放过后者，
     * 只看单项会错过"每项都小幅改善"的整体收益。两个都要看。
     */
    const gain = Math.round(comparable.reduce((sum, d) => sum + (d.scoreDelta ?? 0), 0) * 100) / 100;
    const worstRegression =
      Math.round(Math.max(0, ...comparable.map((d) => -(d.scoreDelta ?? 0))) * 100) / 100;
    const regressions = deltas.filter((d) => (d.scoreDelta ?? 0) < 0);

    // ── 4. 错误扫描 ────────────────────────────────────────────────
    const scanStarted = performance.now();
    let newErrors: Verification['newErrors'] = [];
    let scanError: string | null = null;

    try {
      const scanned = await errorScan.scan({
        project: config.project.name,
        sinceIso: input.startedAtIso,
      });
      newErrors = scanned.map((e) => ({ type: e.type, message: e.message, count: e.count }));
    } catch (err) {
      scanError = toPerfPilotError(err).message;
    }

    checks.push({
      kind: 'error-scan',
      passed: scanError === null,
      skipped: false,
      durationMs: Math.round(performance.now() - scanStarted),
      output: scanError,
    });

    // ── 5. 门禁 ────────────────────────────────────────────────────
    const newErrorCount = newErrors.reduce((sum, e) => sum + e.count, 0);

    /**
     * 失败的检查在这里统一汇总 —— 注意是**在全部检查跑完之后**。
     *
     * 早先这行写在「重新采集」之前，于是 `recollect` 与 `error-scan` 这两项
     * 的结果根本进不了门禁：错误扫描连不上（sentry 没配）时 `newErrors` 是空的，
     * 门禁会把「无法判断有没有引入新错误」当成「没有引入新错误」而放行。
     * 验证是自动化改代码的最后一道闸，**「不知道」必须按「不通过」处理**。
     */
    const failedChecks = checks.filter((c) => !c.passed).map((c) => c.kind);

    const gainOk = gain >= thresholds.min_gain;
    const regressionOk = worstRegression <= thresholds.max_regression;
    const errorsOk = newErrorCount <= thresholds.max_new_errors;

    const failedRules: string[] = [];
    if (failedChecks.length > 0) failedRules.push(`检查未通过：${failedChecks.join('、')}`);
    if (!gainOk) failedRules.push(`收益 ${gain} < min_gain ${thresholds.min_gain}`);
    if (!regressionOk) failedRules.push(`最大回归 ${worstRegression} > max_regression ${thresholds.max_regression}`);
    if (!errorsOk) failedRules.push(`新增错误 ${newErrorCount} > max_new_errors ${thresholds.max_new_errors}`);

    const passed = failedRules.length === 0;

    // ── 6. 保留或回滚 ──────────────────────────────────────────────
    let gitInfo: Verification['git'] = null;
    const id = `ver_${candidateId}`;

    if (passed) {
      const committed = await this.tryCommit(input, logger);
      gitInfo = { baseRef: input.baseRef, resultRef: committed, reverted: false };
      logger.info('验证通过，保留改动', { candidateId, gain });
    } else {
      const reverted = await this.tryRollback(input, logger);
      gitInfo = { baseRef: input.baseRef, resultRef: null, reverted };
      logger.warn('验证未通过，已回滚', { candidateId, failedRules, reverted });
    }

    const verification: Verification = {
      id,
      runId: input.runId,
      candidateId,
      status: passed ? 'kept' : 'rolled_back',
      route: input.route,
      checks,
      deltas,
      gain: buildGainRecord(deltas),
      regressions,
      newErrors,
      gate: { passed, gainOk, regressionOk, errorsOk, failedRules },
      patchRef: `patches/${candidateId}.patch`,
      git: gitInfo,
      decidedBy: 'auto',
      verifiedAt: new Date().toISOString(),
    };

    await store.saveJson(input.runId, `verifications/${candidateId}.json`, verification);

    /**
     * 记忆落库（M5 验收 6 + M6）。
     *
     * 写在**验证记录落盘之后**：先保证"这次验证发生了什么"被留存，
     * 再去积累经验。顺序反过来的话，记忆写失败会连带让这次验证没有留痕。
     *
     * 两类记忆各记一边：
     * - `failure_memory`：失败了才有，作用是"下次别再提这个改法"
     * - `candidate_library`：成功失败都记，带上**实际收益** ——
     *   它是后续标定 `expectedGain`（M4 遗留的保守估计）唯一的数据来源
     */
    if (this.options.memory != null) {
      await this.recordMemory(input, verification, passed, gain, logger);
    }

    return { verification, kept: passed };
  }

  /** 写失败记忆与方案库。两者都只在有 memory 时执行，且都不影响验证结论 */
  private async recordMemory(
    input: VerifyInput,
    verification: Verification,
    passed: boolean,
    gain: number,
    logger: LoggerPort,
  ): Promise<void> {
    const memory = this.options.memory;
    if (memory == null) return;

    const project = this.options.config.project.name;

    if (!passed) {
      await recordFailure({
        memory,
        candidate: input.candidate,
        project,
        failureReason: failureReasonOf(verification),
        logger,
      });
    }

    /**
     * 方案库：一个候选跨多个瓶颈时**逐个 kind 各记一条**。
     *
     * 与失败记忆同一套理由 —— 召回是按 kind 过滤的，只记主 kind
     * 会让另一个问题上的同类经验查不到。
     */
    try {
      for (const bottleneckKind of new Set(input.candidate.bottleneckKinds)) {
        await memory.saveCandidate({
          id: `lib_${input.candidate.id}_${bottleneckKind}`,
          bottleneckKind,
          candidate: input.candidate,
          actualGain: gain,
          /**
           * **原始**的逐指标变化量也要留下来。
           *
           * `actualGain` 是归一化分数（门禁判据），而 planner 的 `expectedGain`
           * 用的是原始单位（ms / byte）。只留前者的话，方案库永远没法用来
           * 校准后者 —— M4 记下的"planner 估得太保守"就永远只能靠拍脑袋改。
           */
          actualGainByMetric: onlyNumbers(verification.gain),
          succeeded: passed,
          project,
          techStack: await resolveTechStack(memory, project),
          createdAt: verification.verifiedAt,
        });
      }
    } catch (err) {
      logger.warn('写入方案库失败', {
        candidateId: input.candidate.id,
        error: toPerfPilotError(err).message,
      });
    }
  }

  private async tryCommit(input: VerifyInput, logger: LoggerPort): Promise<string | null> {
    try {
      return await this.options.git.commit(
        `perfpilot: 应用优化 ${input.candidate.id}`,
        'PerfPilot <perfpilot@local>',
      );
    } catch (err) {
      // 提交失败不影响"保留"这个结论：改动已经在工作区里，人仍然可以看到
      logger.warn('提交失败，改动保留在工作区', { error: toPerfPilotError(err).message });
      return null;
    }
  }

  private async tryRollback(input: VerifyInput, logger: LoggerPort): Promise<boolean> {
    try {
      await this.options.git.resetHard(input.baseRef);
      return true;
    } catch (err) {
      // 回滚失败是**最严重**的情况：工作区留在了一个中间状态
      logger.error('回滚失败，工作区可能处于中间状态', {
        baseRef: input.baseRef,
        error: toPerfPilotError(err).message,
      });
      return false;
    }
  }
}

/** 只把有实际变化的指标写进 gain，避免报告里全是 0 */
function buildGainRecord(deltas: readonly MetricDelta[]): Verification['gain'] {
  const record: Verification['gain'] = {};
  for (const delta of deltas) {
    const change = delta.delta;
    if (change === null || change === 0) continue;
    record[delta.name] = change;
  }
  return record;
}

/**
 * 把 `Verification.gain`（部分字段可缺）压成 `Record<string, number>`。
 *
 * `exactOptionalPropertyTypes` 下 `{ [K]?: number }` 与 `Record<string, number>`
 * 不互相赋值，而方案库要的是后者（它是个 JSON 列，缺的键就该不存在）。
 */
function onlyNumbers(record: Verification['gain']): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [name, value] of Object.entries(record)) {
    if (typeof value === 'number') result[name] = value;
  }
  return result;
}

function truncate(text: string, limit = 2_000): string {
  return text.length > limit ? `${text.slice(0, limit)}\n… (已截断)` : text;
}
