import {
  CandidateListSchema,
  CollectError,
  DecisionListSchema,
  SCHEMA_VERSION,
  computeDeltas,
  createRunId,
  parseExternal,
  sortMetrics,
  sourceChanges,
  toPerfPilotError,
  type BaselineRef,
  type AdapterId,
  type CollectorPort,
  type Device,
  type Candidate,
  type Decision,
  type Diagnosis,
  type ExecutionResult,
  type GitPort,
  type LoggerPort,
  type MemoryPort,
  type Metric,
  type OptimizationClass,
  type PerfPilotConfig,
  type ReporterPort,
  type RunRecord,
  type RunStorePort,
  type RunWarning,
  type SavedRun,
  type StageName,
  type StageRecord,
  type Verification,
} from '@yuki-byte18/shared';
import { assertCollectionUsable, collect } from '../collector/index.js';
import type { Diagnoser } from '../diagnoser/index.js';
import type { Planner } from '../planner/index.js';
import type { DecisionEngine } from '../decision/index.js';
import type { ExecutorOrchestrator } from '../executor/index.js';
import type { Verifier } from '../verifier/index.js';
import { inferProjectProfile, detectBaselineDrift, describeDrift } from '../memory/profile.js';
import { REPORT_FORMAT_FILENAME } from '../reporter/index.js';

/** M1–M5 已实现的阶段。其余阶段显式标记为 skipped，而不是从列表里消失 */
export const IMPLEMENTED_STAGES: readonly StageName[] = [
  'collect',
  'compare',
  'diagnose',
  'plan',
  'decide',
  'execute',
  'verify',
  'report',
];

/**
 * 八个阶段一个不少。执行到哪一段、为什么没跑，都写进 `stages` 的备注里，
 * 报告因此自带进度说明。
 */
const ALL_STAGES: readonly StageName[] = [
  'collect',
  'compare',
  'diagnose',
  'plan',
  'decide',
  'execute',
  'verify',
  'report',
];

export interface PipelineDeps {
  config: PerfPilotConfig;
  collectors: readonly CollectorPort[];
  reporters: readonly ReporterPort[];
  store: RunStorePort;
  logger: LoggerPort;
  version: string;
  /**
   * 诊断器。不传时 diagnose 阶段标记为 skipped，报告只出指标部分 ——
   * 这让「只想采集一次数据」的场景仍然可用，也让 M1 的测试无需改动。
   */
  diagnoser?: Diagnoser | null;
  /**
   * 方案生成器。不传时 plan 阶段标记为 skipped。
   * 它依赖 LLM 端口（可降级为纯规则库）与记忆端口（可为 null）。
   */
  planner?: Planner | null;
  /** 决策层。不传时 decide 阶段标记为 skipped */
  decider?: DecisionEngine | null;
  /** 执行编排。不传时 execute 阶段标记为 skipped（只出 patch 也不做） */
  executor?: ExecutorOrchestrator | null;
  /**
   * 验证器。不传时 verify 阶段标记为 skipped ——
   * 于是补丁会被产出但**不会**被应用，因为"改了却不验证"违反硬约束 8。
   */
  verifier?: Verifier | null;
  /**
   * 记忆层。不传时画像与诊断历史不写库。
   *
   * 与 verifier 的 `memory` 分开注入：验证器负责"这次改动成没成"（失败记忆 +
   * 方案库），流水线负责"这个项目是什么、诊断出了什么"（画像 + 诊断历史）。
   * 两边都能独立缺省，因此测试里可以只给一边。
   */
  memory?: MemoryPort | null;
  /**
   * 技术栈覆盖。不传时从采集产物推断（`inferProjectProfile`）。
   * 推断不出来的项目会以 `unknown` 参与召回，那条路径自然召不回东西。
   */
  techStack?: string;
  /**
   * git 端口。回滚要靠它，因此没注入时**不允许应用任何改动**：
   * 硬约束 9 要求失败必须回滚，做不到回滚就不该开始改。
   */
  git?: GitPort | null;
  /**
   * 重新采集实现。
   *
   * 由组合根提供，因为「重采集往哪个目录写产物」是文件系统的知识，
   * 而 core 不碰 fs（硬约束 5）。流水线只负责把当前路由 / 设备 / runId 传进去。
   * 不传时 verify 阶段标记为 skipped —— 拿不到"改动后"的指标就没法验证，
   * 也就不该应用改动。
   */
  recollect?: (input: {
    runId: string;
    route: string;
    device: Device;
  }) => Promise<Metric[]>;
  /** 允许在工作区不干净时执行改动。默认 false，见 executeAndVerify 的说明 */
  allowDirtyWorktree?: boolean;
  /** 已实现的阶段，默认全部八段 */
  implementedStages?: readonly StageName[];
  clock?: () => Date;
  /** 分布式追踪 / CI 关联用；不传则自动生成 */
  runId?: string;
  /** 诊断记录 id；不传则基于 runId 生成 */
  diagnosisId?: string;
}

export interface RunInput {
  route: string;
  device?: Device;
  /** 覆盖配置里的 baseline.ref */
  baselineRef?: string;
  /** 只产出补丁、不应用任何改动（`run --dry-run`） */
  dryRun?: boolean;
}

/**
 * `fix` 的输入：**不再重新采集，直接消费上一轮 run 的候选与决策**。
 *
 * 这是一条与 `run` 不同的工作流：已经诊断过、也看过报告了，
 * 现在只想把 A 类改动落地。重新跑一遍采集既慢又会让基线漂移，
 * 而候选和决策都已经落盘了。
 */
export interface FixInput {
  runId: string;
  /** 只处理这些裁决，默认 apply + confirm */
  verdicts?: readonly Decision['verdict'][];
  /** 只处理这一个候选 */
  candidateId?: string;
  /** 只处理这一级（A / B / C） */
  onlyClass?: OptimizationClass;
  /** 只产出补丁、不应用任何改动 */
  dryRun?: boolean;
}

export interface FixOutcome {
  executions: ExecutionResult[];
  skippedExecutions: Array<{ candidateId: string; reason: string }>;
  verifications: Verification[];
  stages: StageRecord[];
  warnings: RunWarning[];
  /** 被过滤条件排除掉的候选数 */
  filteredOut: number;
}

/**
 * 改动守卫的结果。
 *
 * 判别联合而不是 `{ ok, baseRef, reason }`：拿到 `ok: true` 时 `baseRef`
 * 一定存在，回滚路径上不需要再写一次兜底判断。
 */
type MutationGuard = { ok: true; baseRef: string } | { ok: false; reason: string };

function countVerdict(decisions: readonly Decision[], verdict: Decision['verdict']): number {
  return decisions.filter((d) => d.verdict === verdict).length;
}

/**
 * 把「未产出改动」的原因写进阶段备注。
 *
 * 只报数量（"1 条无改动"）等于什么都没说：候选的 `expectedGain` 明写着
 * "预期省 436KB"，却一份补丁都没产出，而原因只活在内存里 ——
 * 用户只能靠猜。真实案例：候选要改 `vite.config.ts`，项目里只有 `vite.config.js`。
 */
function describeSkipped(skipped: readonly { reason: string }[]): string {
  if (skipped.length === 0) return '';
  return `：${skipped.map((s) => s.reason).join('；')}`;
}

export interface RunOutcome {
  run: RunRecord;
  /** 诊断结论；diagnose 阶段未执行时为 null */
  diagnosis: Diagnosis | null;
  /** 方案候选；plan 阶段未执行时为空数组 */
  candidates: Candidate[];
  /** 本轮 LLM 调用成本（美元） */
  llmCostUsd: number;
  /** 决策结论；decide 阶段未执行时为空数组 */
  decisions: Decision[];
  /** 执行结果（产出的 patch）；execute 阶段未执行时为空数组 */
  executions: ExecutionResult[];
  /** 未产出改动的候选及原因 */
  skippedExecutions: Array<{ candidateId: string; reason: string }>;
  /** 验证结论（保留 / 回滚）；verify 阶段未执行时为空数组 */
  verifications: Verification[];
  saved: SavedRun;
  /** 各格式报告的落盘绝对路径 */
  reportPaths: string[];
}

/**
 * 线性八段流水线。
 *
 * **没有 DAG、没有拓扑调度、没有任务队列**（ADR 002 / 005）。
 * 八个阶段的依赖关系是固定的，运行时不解析、不分派；
 * 唯一的并发发生在 `collect` 内部（多 adapter 同时采集），
 * 由 `Promise.allSettled` 承担，不需要调度器。
 *
 * 未实现的阶段以 `skipped` 状态出现在 `stages` 里并写明里程碑，
 * 这样报告本身就是进度表 —— 不需要额外维护一份「做到哪了」的文档。
 */
export class Pipeline {
  private readonly deps: PipelineDeps;
  private readonly now: () => Date;

  constructor(deps: PipelineDeps) {
    this.deps = deps;
    this.now = deps.clock ?? (() => new Date());
  }

  async run(input: RunInput): Promise<RunOutcome> {
    const { config, collectors, reporters, store, logger, version } = this.deps;
    const device: Device = input.device ?? 'mobile';
    const route = input.route;
    const implemented = new Set(this.deps.implementedStages ?? IMPLEMENTED_STAGES);

    const startedAt = this.now();
    const runId = this.deps.runId ?? createRunId(startedAt);
    const scoped = logger.child({ runId, route, device });

    // 先建目录：采集阶段 adapter 需要往里写原始产物
    const prepared = await store.prepare(runId);
    scoped.info('run 开始', { project: config.project.name, url: config.target.url });

    const stages: StageRecord[] = [];
    const warnings: RunWarning[] = [];

    // ── collect ────────────────────────────────────────────────────
    if (!implemented.has('collect')) {
      throw new CollectError('collect 阶段未实现，流水线无法继续', { stage: 'collect' });
    }

    const collectStarted = performance.now();
    scoped.info('开始采集', { adapters: collectors.map((c) => c.id) });

    const collected = await collect({
      collectors,
      logger: scoped,
      thresholds: config.baseline.metrics,
      outputDir: prepared.dir,
      url: config.target.url,
      route,
      device,
      timeoutMs: config.collect.timeoutMs,
      // 多轮采集：>1 时逐指标取中位数降噪。性能指标天然有抖动，
      // 而门禁判的就是差值 —— 单轮的抖动会被读成"回归"
      runs: config.collect.runs,
      now: this.now,
    });

    assertCollectionUsable(collected);

    warnings.push(...collected.warnings);
    stages.push({
      name: 'collect',
      status: 'ok',
      durationMs: Math.round(performance.now() - collectStarted),
      note: `${collected.succeeded.length} 个来源成功 / ${collected.failed.length} 个失败，产出 ${collected.metrics.length} 项指标${
        config.collect.runs > 1 ? `（${collected.completedRuns}/${config.collect.runs} 轮，取中位数）` : ''
      }`,
    });

    await store.saveArtifacts(runId, collected.artifacts);

    /**
     * 项目画像（M6）。
     *
     * 在 `compare` 之前写，因为**它的产物之一 `techStack` 要喂给 planner**：
     * 三条召回路径里的「按技术栈召回」此前恒为 `unknown`（永远召不回东西）。
     *
     * 写失败只是一条 warning：画像缺失会让召回变差，不该让整轮运行失败。
     */
    const profile = inferProjectProfile({
      project: config.project.name,
      artifacts: collected.artifacts,
      metrics: collected.metrics,
      ...(this.deps.techStack !== undefined ? { techStack: this.deps.techStack } : {}),
      now: this.now,
    });

    if (profile !== null && this.deps.memory != null) {
      try {
        /**
         * 漂移检测要在**写新画像之前**读旧画像。
         *
         * 顺序反了的话，读到的是刚写进去的本次数据，差值恒为 0 ——
         * 一个永远不报警的检测，比没有检测更糟（它会让人以为"没有漂移"）。
         */
        const previous = await this.deps.memory.getProfile(config.project.name);
        const drifts = detectBaselineDrift(previous, collected.metrics);

        if (drifts.length > 0) {
          // info 级：这是"你可能想知道"，不是判决。门禁判的是本次改动的收益
          warnings.push({
            adapter: null,
            code: 'BASELINE_DRIFT',
            severity: 'info',
            message: describeDrift(drifts),
          });
        }

        await this.deps.memory.saveProfile(profile);
      } catch (err) {
        scoped.warn('写入项目画像失败', { error: toPerfPilotError(err).message });
      }
    }

    // ── compare ────────────────────────────────────────────────────
    const compareStarted = performance.now();
    const baseline = await this.resolveBaseline(input.baselineRef, route, device);
    const currentMetrics = sortMetrics(collected.metrics);
    const deltas = computeDeltas(currentMetrics, baseline?.metrics ?? [], config.baseline.metrics);

    // 来源变了就不给差值（computeDelta 已置空），但必须显式说出来 ——
    // 否则用户只会看到一片「—」，不知道自己被换了测量工具。
    for (const change of sourceChanges(currentMetrics, baseline?.metrics ?? [])) {
      warnings.push({
        adapter: change.to,
        code: 'METRIC_SOURCE_CHANGED',
        severity: 'info',
        message: `${change.name} 的测量来源由 ${change.from} 变为 ${change.to}，本次不计算该指标的差值`,
      });
    }

    stages.push({
      name: 'compare',
      status: 'ok',
      durationMs: Math.round(performance.now() - compareStarted),
      note:
        baseline === null
          ? '无可用基线，本次将成为后续运行的基线'
          : `对比基线 ${baseline.ref}${baseline.runId ? ` (${baseline.runId})` : ''}`,
    });

    // ── diagnose ───────────────────────────────────────────────────
    let diagnosis: Diagnosis | null = null;

    /**
     * 诊断 agent 的成本。
     *
     * 与方案生成的成本**分开累计、最后相加**：报告里要能说清"这轮花的钱是
     * 看问题花的，还是给方案花的" —— 两者对用户的价值判断完全不同。
     */
    let diagnoseLlmCostUsd = 0;

    if (this.deps.diagnoser != null && implemented.has('diagnose')) {
      const diagnoseStarted = performance.now();
      try {
        const outcome = await this.deps.diagnoser.diagnose({
          diagnosisId: this.deps.diagnosisId ?? `diag_${runId}`,
          runId,
          project: config.project.name,
          route,
          device,
          metrics: currentMetrics,
          deltas,
          artifacts: collected.artifacts,
          baseline,
          createdAt: this.now().toISOString(),
        });
        diagnosis = outcome.diagnosis;
        diagnoseLlmCostUsd = outcome.llmCostUsd;
        await store.saveDiagnosis(runId, diagnosis);

        // 诊断历史（M6）：跨 run 的「这个问题出现过几次」靠它
        if (this.deps.memory != null) {
          try {
            await this.deps.memory.saveDiagnosis({
              id: diagnosis.id,
              runId,
              project: config.project.name,
              route,
              bottleneckKinds: [...new Set(diagnosis.bottlenecks.map((b) => b.kind))],
              createdAt: diagnosis.createdAt,
            });
          } catch (err) {
            scoped.warn('写入诊断历史失败', { error: toPerfPilotError(err).message });
          }
        }

        stages.push({
          name: 'diagnose',
          status: 'ok',
          durationMs: Math.round(performance.now() - diagnoseStarted),
          note:
            `${outcome.ruleHits.filter((h) => h.detections > 0).length}/${outcome.ruleHits.length} 条规则命中` +
            // 诊断 agent 的产出必须出现在阶段备注里：花了钱就得看得见它做了什么，
            // 包括"它说了但没被采纳"的数量
            (outcome.llm.enabled
              ? `，诊断 agent 采纳 ${outcome.llm.adopted} 条（复核 ${outcome.llm.refined.length} 条、丢弃 ${outcome.llm.dropped.length} 条）`
              : '（诊断 agent 未启用）') +
            `，产出 ${diagnosis.bottlenecks.length} 个瓶颈`,
        });
      } catch (err) {
        const error = toPerfPilotError(err);
        // 诊断失败不应该让整轮运行失败：指标与产物已经落盘，报告仍可产出
        warnings.push({
          adapter: null,
          code: error.code,
          severity: 'degraded',
          message: `诊断阶段失败：${error.message}`,
        });
        stages.push({
          name: 'diagnose',
          status: 'failed',
          durationMs: Math.round(performance.now() - diagnoseStarted),
          note: `${error.code}: ${error.message}`,
        });
        scoped.error('诊断阶段失败', { code: error.code, error: error.message });
      }
    } else {
      stages.push({
        name: 'diagnose',
        status: 'skipped',
        durationMs: 0,
        note:
          this.deps.diagnoser == null
            ? '未注入诊断器'
            : '本次运行未启用诊断阶段',
      });
    }

    // ── plan ───────────────────────────────────────────────────────
    let candidates: Candidate[] = [];
    // 本轮 LLM 总花费 = 诊断 agent + 方案生成（两处共享同一份预算）
    let llmCostUsd = diagnoseLlmCostUsd;

    if (this.deps.planner != null && implemented.has('plan') && diagnosis !== null) {
      const planStarted = performance.now();
      try {
        const outcome = await this.deps.planner.plan({
          planId: `plan_${runId}`,
          runId,
          project: config.project.name,
          route,
          diagnosis,
          createdAt: this.now().toISOString(),
          // 画像推断出的技术栈优先于规划器构造时的默认值：
          // 「按技术栈召回」要有意义，就必须是**这个项目**的技术栈
          ...(profile !== null ? { techStack: profile.techStack } : {}),
        });
        candidates = outcome.candidates;
        llmCostUsd = diagnoseLlmCostUsd + outcome.llmCostUsd;
        await store.saveJson(runId, 'candidates.json', candidates);

        // 没有候选不代表出错，但代表「这次诊断出的瓶颈没有已知修法」，
        // 必须写进运行记录 —— 否则用户只会看到一份没有建议的报告。
        if (candidates.length === 0 && diagnosis.bottlenecks.length > 0) {
          warnings.push({
            adapter: null,
            code: 'NO_CANDIDATE',
            severity: 'degraded',
            message: `诊断出 ${diagnosis.bottlenecks.length} 个瓶颈，但没有任何规划规则能给出方案`,
          });
        }

        stages.push({
          name: 'plan',
          status: 'ok',
          durationMs: Math.round(performance.now() - planStarted),
          note: `产出 ${candidates.length} 个候选（${candidates.filter((c) => c.origin === 'rule').length} 条来自规则库，${candidates.filter((c) => c.origin === 'llm').length} 条来自 LLM）`,
        });
      } catch (err) {
        const error = toPerfPilotError(err);
        warnings.push({
          adapter: null,
          code: error.code,
          severity: 'degraded',
          message: `方案生成失败：${error.message}`,
        });
        stages.push({
          name: 'plan',
          status: 'failed',
          durationMs: Math.round(performance.now() - planStarted),
          note: `${error.code}: ${error.message}`,
        });
        scoped.error('方案生成失败', { code: error.code, error: error.message });
      }
    } else {
      stages.push({
        name: 'plan',
        status: 'skipped',
        durationMs: 0,
        note:
          this.deps.planner == null
            ? '未注入方案生成器'
            : diagnosis === null
              ? '诊断未产出结论，无可规划的对象'
              : '本次运行未启用方案生成阶段',
      });
    }

    // ── decide ─────────────────────────────────────────────────────
    let decisions: Decision[] = [];

    if (this.deps.decider != null && implemented.has('decide') && candidates.length > 0) {
      const decideStarted = performance.now();
      try {
        const outcome = this.deps.decider.decide({
          runId,
          candidates,
          createdAt: this.now().toISOString(),
        });
        decisions = outcome.decisions;
        await store.saveJson(runId, 'decisions.json', decisions);

        stages.push({
          name: 'decide',
          status: 'ok',
          durationMs: Math.round(performance.now() - decideStarted),
          note: `裁决 ${decisions.length} 个候选：apply ${outcome.counts.apply} / confirm ${outcome.counts.confirm} / suggest ${outcome.counts.suggest} / reject ${outcome.counts.reject}`,
        });
      } catch (err) {
        const error = toPerfPilotError(err);
        warnings.push({
          adapter: null,
          code: error.code,
          severity: 'degraded',
          message: `决策阶段失败：${error.message}`,
        });
        stages.push({
          name: 'decide',
          status: 'failed',
          durationMs: Math.round(performance.now() - decideStarted),
          note: `${error.code}: ${error.message}`,
        });
        scoped.error('决策阶段失败', { code: error.code, error: error.message });
      }
    } else {
      stages.push({
        name: 'decide',
        status: 'skipped',
        durationMs: 0,
        note:
          this.deps.decider == null
            ? '未注入决策层'
            : candidates.length === 0
              ? '没有候选可裁决'
              : '本次运行未启用决策阶段',
      });
    }

    // ── execute ────────────────────────────────────────────────────
    let executions: ExecutionResult[] = [];
    let skippedExecutions: Array<{ candidateId: string; reason: string }> = [];

    /**
     * 改动守卫**必须在 execute 之前**取。
     *
     * asset 执行器在 `writeAssets: true` 时会直接写盘（二进制没有文本补丁，
     * ADR 006 的已知例外）。等 execute 跑完再检查 `isClean()`，看到的会是
     * "被自己弄脏"的工作区 → 拒绝应用任何补丁 → 而二进制改动已经落在盘上，
     * 既没验证也没回滚。这是本文件里真实发生过一次的顺序错误：
     * 注释写对了，调用点却放在 execute 之后。
     *
     * 但**只在真的会落盘时才取**，判据见 `resolveGuard`：dry-run 不写盘、
     * 没有执行阶段不写盘、只有 confirm 裁决也不写盘（confirm 的语义就是
     * "产出补丁等人确认"）。这些情况下工作区脏不脏都与本次运行无关，
     * 照样发 WORKTREE_DIRTY 只会把人指向一个不存在的原因 ——
     * 真实症状就是"一条 apply 候选都没有，却警告补丁会因工作区脏而丢失"。
     */
    const executor = this.deps.executor;
    const willExecute =
      executor != null &&
      implemented.has('execute') &&
      decisions.some((d) => d.verdict === 'apply' || d.verdict === 'confirm');
    /** 只有 `apply` 裁决的补丁会被真正写进工作区 */
    const hasApply = decisions.some((d) => d.verdict === 'apply');

    const guard = await this.resolveGuard({
      scoped,
      warnings,
      willExecute,
      hasApply,
      dryRun: input.dryRun === true,
    });

    // `executor != null` 不能省：TS 不会通过 `willExecute` 这个别名收窄属性访问
    if (willExecute && executor != null) {
      const executeStarted = performance.now();
      try {
        const outcome = await executor.execute({
          runId,
          candidates,
          decisions,
          // 守卫不通过时**只评估不落盘**：执行器不该在"决定不动"之后动代码
          allowWrite: guard.ok,
        });
        executions = outcome.results;
        skippedExecutions = outcome.skipped;

        stages.push({
          name: 'execute',
          status: 'ok',
          durationMs: Math.round(performance.now() - executeStarted),
          note:
            `产出 ${executions.length} 份 patch` +
            `（apply ${countVerdict(decisions, 'apply')} / confirm ${countVerdict(decisions, 'confirm')}）` +
            `，${skippedExecutions.length} 条无改动` +
            describeSkipped(skippedExecutions) +
            // 说明为什么二进制资产没写盘：否则读者会以为"评估结果"就是最终结果
            (guard.ok
              ? ''
              : `；未写入工作区（${guard.reason}）` +
                (executions.length > 0 ? '；补丁已落盘，可手动应用' : '')),
        });
      } catch (err) {
        const error = toPerfPilotError(err);
        warnings.push({
          adapter: null,
          code: error.code,
          severity: 'degraded',
          message: `执行阶段失败：${error.message}`,
        });
        stages.push({
          name: 'execute',
          status: 'failed',
          durationMs: Math.round(performance.now() - executeStarted),
          note: `${error.code}: ${error.message}`,
        });
        scoped.error('执行阶段失败', { code: error.code, error: error.message });
      }
    } else {
      stages.push({
        name: 'execute',
        status: 'skipped',
        durationMs: 0,
        note:
          this.deps.executor == null
            ? '未注入执行编排'
            : decisions.length === 0
              ? '没有候选可执行'
              : '没有 apply / confirm 裁决的候选',
      });
    }

    // ── verify ─────────────────────────────────────────────────────
    let verifications: Verification[] = [];

    if (input.dryRun === true) {
      // 与 fix() 同一个承诺：补丁落盘，但一个字节都不动工作区，因此无可验证
      stages.push({
        name: 'verify',
        status: 'skipped',
        durationMs: 0,
        note: 'dry-run：只产出补丁，不应用、不验证',
      });
    } else {
      verifications = await this.verifyExecutions({
        runId,
        candidates,
        decisions,
        executions,
        warnings,
        stages,
        guard,
        baseMetrics: currentMetrics,
        startedAtIso: startedAt.toISOString(),
        route,
        device,
        scoped,
        implemented,
      });
    }

    /**
     * 汇总文件。
     *
     * executor 与 verifier 各自按候选落盘（`executions/<id>.json`），     * 那对"查某一个候选"是好的，但**没法一次读回全部** —— 读取方得先知道
     * 有哪些候选。报告服务与 Web 页需要的是整份，因此这里再写两份数组。
     *
     * 代价是同一份数据存了两遍。保留两份的理由：按候选的那份是**审计留痕**
     * （谁在什么时候被验证成什么样，追加式的、不该被重写），
     * 汇总那份是**视图**（给人看的、可以重新生成）。
     */
    if (executions.length > 0) await store.saveJson(runId, 'executions.json', executions);
    if (verifications.length > 0) await store.saveJson(runId, 'verifications.json', verifications);

    /**
     * 补齐 `stages` 里缺的阶段。
     *
     * 走到这里说明这个阶段**本次运行没被启用**（`implementedStages` 里没有它，
     * 例如 `diagnose` 命令）。八段一个都不能从列表里消失 ——
     * 报告里少一行，读者会以为那段"没发生过"，而不是"这次不跑"。
     */
    for (const name of ALL_STAGES) {
      if (implemented.has(name) || stages.some((s) => s.name === name)) continue;
      stages.push({
        name,
        status: 'skipped',
        durationMs: 0,
        note: '本次运行未启用该阶段',
      });
    }

    const finishedAt = this.now();
    const status = this.deriveStatus(collected.failed, warnings, collected.metrics.length);

    const run: RunRecord = {
      schemaVersion: SCHEMA_VERSION,
      id: runId,
      project: config.project.name,
      route,
      device,
      url: config.target.url,
      status,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      perfpilotVersion: version,
      stages,
      metrics: currentMetrics,
      baseline,
      deltas,
      warnings,
      artifacts: collected.artifacts.map((a) => ({
        adapter: a.adapter,
        kind: a.kind,
        file: a.file ?? 'artifacts/',
      })),
      // 诊断 agent + 方案生成的总花费：报告页与 MR 评论都要显示它
      llmCostUsd,
    };

    // ── report ─────────────────────────────────────────────────────
    const reportStarted = performance.now();
    const reportPaths: string[] = [];

    for (const reporter of reporters) {
      try {
        const output = reporter.render({
          run,
          diagnosis,
          candidates,
          decisions,
          executions,
          verifications,
        });
        reportPaths.push(await store.saveReport(runId, output));
      } catch (err) {
        const error = toPerfPilotError(err, 'REPORT_FAILED');
        warnings.push({
          adapter: null,
          code: error.code,
          severity: 'degraded',
          message: `${reporter.format} 报告渲染失败：${error.message}`,
        });
        scoped.error('报告渲染失败', { format: reporter.format, error: error.message });
      }
    }

    stages.push({
      name: 'report',
      status: reportPaths.length > 0 ? 'ok' : 'failed',
      durationMs: Math.round(performance.now() - reportStarted),
      note: `产出 ${reportPaths.length} 份报告：${reporters.map((r) => REPORT_FORMAT_FILENAME[r.format]).join(', ')}`,
    });

    const saved = await store.save({ ...run, stages, warnings });
    scoped.info('run 完成', {
      status,
      metrics: run.metrics.length,
      bottlenecks: diagnosis?.bottlenecks.length ?? 0,
      candidates: candidates.length,
      decisions: decisions.length,
      executions: executions.length,
      verifications: verifications.length,
      warnings: warnings.length,
    });

    return {
      run: { ...run, stages, warnings },
      diagnosis,
      candidates,
      llmCostUsd,
      decisions,
      executions,
      skippedExecutions,
      verifications,
      saved,
      reportPaths,
    };
  }

  /**
   * 取「能不能安全地改工作区」这个守卫。
   *
   * 判据只有一条：**这次运行到底会不会写工作区**。四种情况都不会写，
   * 因此都不该去查工作区脏不脏 —— 查了就会发一条 WORKTREE_DIRTY，
   * 而那条告警会说"本次不自动应用补丁"，读者自然以为是工作区把它挡住了：
   *
   * - `dry-run`：承诺就是只产出补丁
   * - 没有执行阶段：`diagnose` 这类只读运行
   * - 没有 apply 裁决：`confirm` 的语义是"产出补丁等人工确认"
   * - 一条候选都没有
   *
   * 真实踩过的坑：一轮运行只剩一个 B 类 `confirm` 候选，报告却写着
   * "工作区有未提交改动，因此本次不自动应用补丁" —— 用户于是去提交代码，
   * 然后再跑一轮，依然什么都不应用，因为挡住它的根本不是工作区。
   */
  private async resolveGuard(input: {
    scoped: LoggerPort;
    warnings: RunWarning[];
    willExecute: boolean;
    hasApply: boolean;
    dryRun: boolean;
  }): Promise<MutationGuard> {
    if (input.dryRun) return { ok: false, reason: 'dry-run 只产出补丁' };
    if (!input.willExecute) return { ok: false, reason: '本次运行不写入工作区' };
    if (!input.hasApply) {
      return { ok: false, reason: '没有 apply 裁决的候选（confirm 的补丁只产出、不自动应用）' };
    }
    return this.prepareMutation({ scoped: input.scoped, warnings: input.warnings });
  }

  /**
   * 改动开始前的守卫：确定「回滚目标」并确认工作区可以安全改动。
   *
   * 必须在 execute 之前调用 —— 见 run() 里的说明。
   * 三种情况判定为不可改动，因为硬约束 9（失败必须回滚）无法保证：
   * 没注入 verifier、没注入 git、工作区不干净
   * （`reset --hard` 会连带毁掉用户未提交的改动）。
   */
  private async prepareMutation(input: {
    scoped: LoggerPort;
    warnings: RunWarning[];
  }): Promise<MutationGuard> {
    const { verifier, git, recollect } = this.deps;
    const { warnings } = input;

    if (verifier == null) return { ok: false, reason: '未注入验证器' };
    if (git == null) {
      return { ok: false, reason: '未注入 git 端口，无法保证失败可回滚' };
    }
    if (recollect == null) {
      return { ok: false, reason: '未注入重采集实现，拿不到改动后的指标' };
    }

    try {
      if (!this.deps.allowDirtyWorktree && !(await git.isClean())) {
        warnings.push({
          adapter: null,
          code: 'WORKTREE_DIRTY',
          severity: 'degraded',
          message:
            '工作区有未提交改动：回滚会连带丢弃这些改动，因此本次不自动应用补丁',
        });
        return { ok: false, reason: '工作区不干净，拒绝自动应用改动' };
      }
      return { ok: true, baseRef: await git.currentRef() };
    } catch (err) {
      const error = toPerfPilotError(err);
      warnings.push({
        adapter: null,
        code: error.code,
        severity: 'degraded',
        message: `无法确认工作区状态，本次不自动应用补丁：${error.message}`,
      });
      return { ok: false, reason: '无法确认工作区状态' };
    }
  }

  /**
   * `perfpilot fix`：对上一轮 run 的候选执行「产出补丁 → 应用 → 验证 → 保留/回滚」。
   *
   * 复用的是 `run()` 里同一对私有方法（`prepareMutation` / `verifyExecutions`），
   * 而不是在 CLI 里再写一遍这个循环 —— 保留与回滚的判据只能有一份实现，
   * 两份实现迟早会在某次改动后给出不同的结论。
   *
   * 与 `run()` 的唯一区别是**不重新采集**：候选、决策、基线指标全部来自
   * 已经落盘的那一轮 run。因此在验证阶段重采集时，比较的仍然是那一轮的基线。
   */
  async fix(input: FixInput): Promise<FixOutcome> {
    const { store, logger } = this.deps;
    const stages: StageRecord[] = [];
    const warnings: RunWarning[] = [];
    const scoped = logger.child({ runId: input.runId, stage: 'fix' });

    const run = await store.load(input.runId);
    if (run === null) {
      throw new CollectError(`找不到 run ${input.runId}`, {
        code: 'CONFIG_INVALID',
        stage: 'collect',
        details: { runId: input.runId },
      });
    }

    // 从磁盘读回来的东西同样是**外部输入**（用户可以手改 JSON），一律过 schema
    const candidates = await this.loadArray(input.runId, 'candidates.json', (raw) =>
      parseExternal(CandidateListSchema, raw, { what: 'candidates.json' }),
    );
    const decisions = await this.loadArray(input.runId, 'decisions.json', (raw) =>
      parseExternal(DecisionListSchema, raw, { what: 'decisions.json' }),
    );

    const verdicts = input.verdicts ?? ['apply', 'confirm'];
    const selected = decisions.filter((decision) => {
      if (!verdicts.includes(decision.verdict)) return false;
      if (input.candidateId !== undefined && decision.candidateId !== input.candidateId) return false;
      if (input.onlyClass !== undefined) {
        const candidate = candidates.find((c) => c.id === decision.candidateId);
        if (candidate?.class !== input.onlyClass) return false;
      }
      return true;
    });

    const selectedIds = new Set(selected.map((d) => d.candidateId));
    const selectedCandidates = candidates.filter((c) => selectedIds.has(c.id));

    if (this.deps.executor == null) {
      stages.push({ name: 'execute', status: 'skipped', durationMs: 0, note: '未注入执行编排' });
      stages.push({ name: 'verify', status: 'skipped', durationMs: 0, note: '没有可执行的对象' });
      return {
        executions: [],
        skippedExecutions: [],
        verifications: [],
        stages,
        warnings,
        filteredOut: candidates.length,
      };
    }

    /**
     * `fix` 的守卫也要在 execute **之前**取，理由与 `run` 完全相同：
     * 工作区不干净时，资产执行器写下的文件既没人验、也没人回滚。
     *
     * 与 `run` 一样只在真的会落盘时才取（判据见 `resolveGuard`）。
     */
    const guard = await this.resolveGuard({
      scoped,
      warnings,
      willExecute: true,
      hasApply: selected.some((d) => d.verdict === 'apply'),
      dryRun: input.dryRun === true,
    });

    const executeStarted = performance.now();
    const outcome = await this.deps.executor.execute({
      runId: input.runId,
      candidates: selectedCandidates,
      decisions: selected,
      allowWrite: input.dryRun !== true && guard.ok,
    });
    stages.push({
      name: 'execute',
      status: 'ok',
      durationMs: Math.round(performance.now() - executeStarted),
      note:
        `产出 ${outcome.results.length} 份 patch，${outcome.skipped.length} 条无改动` +
        describeSkipped(outcome.skipped) +
        (guard.ok
          ? ''
          : `；未写入工作区（${guard.reason}）` +
            (outcome.results.length > 0 ? '；补丁已落盘，可手动应用' : '')),
    });

    // `--dry-run` 到此为止：补丁已经落盘，但一个字节都不动工作区
    const verifications = input.dryRun === true
      ? (stages.push({
          name: 'verify',
          status: 'skipped',
          durationMs: 0,
          note: 'dry-run：只产出补丁，不应用、不验证',
        }),
        [])
      : await this.verifyExecutions({
          runId: input.runId,
          candidates: selectedCandidates,
          decisions: selected,
          executions: outcome.results,
          warnings,
          stages,
          guard,
          baseMetrics: run.metrics,
          startedAtIso: run.startedAt,
          route: run.route,
          device: run.device,
          scoped,
          implemented: new Set(this.deps.implementedStages ?? IMPLEMENTED_STAGES),
        });

    // 汇总文件：`fix` 也会改这两个视图，报告服务读的就是它们
    if (outcome.results.length > 0) {
      await this.deps.store.saveJson(input.runId, 'executions.json', outcome.results);
    }
    if (verifications.length > 0) {
      await this.deps.store.saveJson(input.runId, 'verifications.json', verifications);
    }

    return {
      executions: outcome.results,
      skippedExecutions: outcome.skipped,
      verifications,
      stages,
      warnings,
      filteredOut: decisions.length - selected.length,
    };
  }
  /**
   * 读一个 JSON 数组并过 schema。读不到就返回空数组（"没跑过那一段"是合法状态）。
   *
   * 校验函数由调用方传入（一个闭包），而不是把 zod 的 schema 类型写进签名里：
   * `zod` 不是 core 的依赖，硬约束 3 不允许 core 认识这个库 ——
   * 连类型都不该提到它。
   */
  private async loadArray<T>(
    runId: string,
    filename: string,
    parse: (raw: unknown) => T[],
  ): Promise<T[]> {
    const raw = await this.deps.store.loadJson(runId, filename);
    if (raw === null) return [];
    return parse(raw);
  }

  /**
   * 验证阶段：**逐个候选**应用补丁 → 跑检查与重采集 → 按门禁保留或回滚。
   *
   * 为什么「应用补丁」放在 verify 而不是 execute 里：
   * executor 只产出 patch、不碰工作区（ADR 006），所以补丁的应用必须紧挨着
   * 它的验证。否则先应用 N 份补丁再统一验证，重采集得到的是 N 个改动**叠加**后的
   * 结果，收益无法归因到任何一个候选 —— 门禁通过时你不知道该保留谁，
   * 不通过时也不知道该回滚谁。
   *
   * 因此这里是**串行**的：一个候选走完 apply → verify → keep/rollback，
   * 再处理下一个。保留成功则回滚目标前移到新 commit；回滚后工作区回到
   * 上一个已知状态，下一个候选的补丁仍能干净地应用。
   */
  private async verifyExecutions(input: {
    runId: string;
    candidates: readonly Candidate[];
    decisions: readonly Decision[];
    executions: readonly ExecutionResult[];
    warnings: RunWarning[];
    stages: StageRecord[];
    guard: MutationGuard;
    baseMetrics: readonly Metric[];
    startedAtIso: string;
    route: string;
    device: Device;
    scoped: LoggerPort;
    implemented: Set<StageName>;
  }): Promise<Verification[]> {
    const { verifier, git, recollect } = this.deps;
    const { warnings, stages, scoped, guard } = input;
    const verifications: Verification[] = [];

    const skip = (note: string): Verification[] => {
      stages.push({ name: 'verify', status: 'skipped', durationMs: 0, note });
      return verifications;
    };

    if (!input.implemented.has('verify')) return skip('验证阶段未启用');
    // 守卫已经把原因写进 warning（或说明了缺哪个端口），这里只补一句阶段备注
    if (!guard.ok || git == null || verifier == null || recollect == null) {
      return skip(`${guard.ok ? '缺少端口' : guard.reason}，因此不应用任何补丁`);
    }

    const started = performance.now();

    // 只应用 apply 裁决的补丁：confirm 是"产出补丁等人工确认"，不该自动落地
    const applicable = input.executions.filter(
      (result) =>
        input.decisions.find((d) => d.candidateId === result.candidateId)?.verdict === 'apply',
    );
    const pendingConfirm = input.executions.length - applicable.length;

    if (applicable.length === 0) {
      return skip(
        input.executions.length === 0
          ? '没有产出补丁的候选'
          : `${input.executions.length} 份补丁均为待人工确认（B 类），不自动应用`,
      );
    }

    let baseRef = guard.baseRef;
    const byId = new Map(input.candidates.map((c) => [c.id, c]));
    let applied = 0;
    let kept = 0;
    let rolledBack = 0;
    let unverifiable = 0;

    for (const result of applicable) {
      const candidate = byId.get(result.candidateId);
      const decision = input.decisions.find((d) => d.candidateId === result.candidateId);

      if (candidate === undefined || decision === undefined) {
        warnings.push({
          adapter: null,
          code: 'CANDIDATE_MISSING',
          severity: 'degraded',
          message: `候选 ${result.candidateId} 的补丁无法验证：找不到候选或决策记录`,
        });
        continue;
      }

      if (result.patch !== '') {
        const ok = await git.applyPatch(result.patch);
        if (!ok) {
          warnings.push({
            adapter: null,
            code: 'PATCH_CONFLICT',
            severity: 'degraded',
            message: `候选「${candidate.title}」的补丁无法应用（可能与已保留的改动冲突），已跳过验证`,
          });
          continue;
        }
      } else if (!result.applied) {
        /**
         * 没有补丁、也没改动工作区 —— 这是「只做了评估」的资产候选
         * （`writeAssets: false`）。拿没变的环境去验证，只会得到"收益为 0"，
         * 然后回滚一个从未发生过的改动。如实说明它没被验证。
         */
        unverifiable += 1;
        warnings.push({
          adapter: null,
          code: 'EXECUTION_NOT_APPLIED',
          severity: 'degraded',
          message: `候选「${candidate.title}」只做了评估、未写入工作区，无法验证：${result.summary.split('\n')[0] ?? ''}`,
        });
        continue;
      }
      applied += 1;

      const outcome = await verifier.verify({
        runId: input.runId,
        candidate,
        route: decision.route,
        baselineMetrics: input.baseMetrics,
        baseRef,
        startedAtIso: input.startedAtIso,
        recollect: () =>
          recollect({ runId: input.runId, route: input.route, device: input.device }),
      });

      verifications.push(outcome.verification);

      if (outcome.kept) {
        kept += 1;
        // 回滚目标前移：下一个候选失败时只该回滚它自己，不能抹掉刚保留的改动
        baseRef = outcome.verification.git?.resultRef ?? baseRef;
      } else {
        rolledBack += 1;
      }
    }

    const notes = [`应用 ${applied} 个候选：保留 ${kept}、回滚 ${rolledBack}`];
    if (unverifiable > 0) notes.push(`${unverifiable} 个未写入工作区、未验证`);
    if (pendingConfirm > 0) notes.push(`${pendingConfirm} 份补丁待人工确认`);

    stages.push({
      name: 'verify',
      status: 'ok',
      durationMs: Math.round(performance.now() - started),
      note: notes.join('；'),
    });

    scoped.info('验证阶段完成', { applied, kept, rolledBack, unverifiable, pendingConfirm });
    return verifications;
  }

  /**
   * 解析基线。
   *
   * 优先级：显式参数 > 配置 ref > 最近一次同路由同设备的运行。
   *
   * ## 为什么 `partial` 也能当基线
   *
   * 第一版只接受 `status === 'success'`，理由是"拿降级采集的结果做基准，
   * 会让下一次的改善变成测量误差"。这个顾虑是对的，但用错了手段：
   * `partial` 只说明**有来源没参与**（比如项目没有 HAR、没有 trace、
   * 没有 web-vitals 上报文件），并不说明拿到的数字不可信。
   *
   * 代价是灾难性的：绝大多数真实项目都有可选来源缺失，于是**永远拿不到基线**，
   * 而"这次改动让性能变差了吗"正是这个工具的全部意义。
   * 这个 bug 是在 M7 接 CI 门禁时才暴露的 —— 单测里每个来源都齐全，看不出问题。
   *
   * 真正需要防的"跨口径比较"由 `isComparable` 兜住：测量来源变了就置空
   * `scoreDelta`（见 utils/metric.ts）。粒度从"整次运行"收到"单个指标"之后，
   * 既不会误比，也不必因为一个可选来源缺席就放弃全部基线。
   *
   * 只有 `failed`（一个指标都没采到）不能当基线 —— 那种运行里没有任何可比的东西。
   */
  private async resolveBaseline(
    override: string | undefined,
    route: string,
    device: Device,
  ): Promise<BaselineRef | null> {
    const ref = override ?? this.deps.config.baseline.ref ?? 'last-run';

    if (ref === 'last-run' || ref === '') {
      const latest = await this.deps.store.latestFor(this.deps.config.project.name, route, device);
      if (latest === null || latest.status === 'failed') return null;
      return { ref: 'last-run', runId: latest.id, metrics: latest.metrics };
    }

    const explicit = await this.deps.store.load(ref);
    if (explicit === null || explicit.status === 'failed') return null;
    return { ref, runId: explicit.id, metrics: explicit.metrics };
  }

  /**
   * 运行状态。
   *
   * 只把 `degraded` 级别的告警算作降级：`info` 告警（例如某指标由次选来源提供）
   * 说明数据是齐全的，只是来源需要交代。如果连它一起算作「不完整」，
   * 一个没有 bundle-analyzer 的项目会因为一条纯说明性告警永远拿不到基线 ——
   * 这正是 M1 跑测试时暴露出来的问题。
   */
  private deriveStatus(
    failed: readonly AdapterId[],
    warnings: readonly RunWarning[],
    metricCount: number,
  ): RunRecord['status'] {
    if (metricCount === 0) return 'failed';
    const degraded = warnings.some((w) => w.severity === 'degraded');
    if (failed.length > 0 || degraded) return 'partial';
    return 'success';
  }
}
