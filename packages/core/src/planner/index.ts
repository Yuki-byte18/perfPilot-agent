import {
  toPerfPilotError,
  type Bottleneck,
  type Candidate,
  type Diagnosis,
  type LoggerPort,
  type LlmPort,
  type MemoryPort,
  type PerfPilotConfig,
  type PlannedChange,
  type ProjectProfile,
} from '@yuki-byte18/shared';
import { BUILTIN_PLANNER_RULES, PLANNER_RULE_SET_VERSION } from './rules/index.js';
import type { PlannerContext, PlannerRule } from './types.js';
import { recallAndAdjust } from '../memory/recall.js';

export interface PlanInput {
  planId: string;
  runId: string;
  project: string;
  route: string;
  diagnosis: Diagnosis;
  createdAt: string;
  /**
   * 本次运行识别出的技术栈，覆盖构造时的 `options.techStack`。
   *
   * 由流水线传进来（它从采集产物里推断出了项目画像）：技术栈是**一次运行的事实**，
   * 不是规划器的配置。放构造期会让"同一份诊断换个项目重跑"得到不同的召回结果。
   */
  techStack?: string;
}

export interface PlannerOptions {
  config: PerfPilotConfig;
  llm: LlmPort;
  memory: MemoryPort | null;
  logger: LoggerPort;
  rules?: readonly PlannerRule[];
  /** 技术栈识别结果，用于记忆召回；不传则从配置/画像推断 */
  techStack?: string;
}

export interface PlanOutcome {
  candidates: Candidate[];
  /** 规则集版本 */
  ruleSetVersion: string;
  /** LLM 调用成本（美元） */
  llmCostUsd: number;
  /** 哪些瓶颈没有被任何规则覆盖（留给人工或后续规则扩展） */
  unmatchedKinds: string[];
}

/**
 * 方案生成器（README §5 core/planner）。
 *
 * 流程：
 * 1. **规则库**：对每个瓶颈应用所有匹配 kind 的规划规则，生成确定性候选。
 * 2. **LLM 补充**：对规则库未覆盖的瓶颈，调用 LLM 生成候选（provider=none 时跳过）。
 * 3. **记忆召回**：用历史方案调整置信度，失败记忆中的候选直接剔除。
 * 4. **去重**：同一瓶颈的同类改动合并。
 *
 * 关键约束：
 * - 每个候选必须回链到至少一个瓶颈（`bottleneckIds` 非空）。
 * - LLM 输出必须经 schema 校验，失败则只用规则库，链路不中断。
 */
export class Planner {
  private readonly options: PlannerOptions;
  private readonly rules: readonly PlannerRule[];

  constructor(options: PlannerOptions) {
    this.options = options;
    this.rules = options.rules ?? BUILTIN_PLANNER_RULES;
  }

  async plan(input: PlanInput): Promise<PlanOutcome> {
    const { logger, llm, memory, config } = this.options;
    const bottlenecks = input.diagnosis.bottlenecks;

    logger.info('开始方案生成', { bottlenecks: bottlenecks.length });

    const ctx: PlannerContext = {
      runId: input.runId,
      project: input.project,
      route: input.route,
      bottlenecks,
    };

    // ── 1. 规则库生成确定性候选 ────────────────────────────────────
    const ruleCandidates = this.generateFromRules(bottlenecks, ctx, logger);

    // 统计哪些瓶颈种类没有被任何规则覆盖
    const matchedKinds = new Set(ruleCandidates.flatMap((c) => c.bottleneckKinds));
    const unmatchedKinds = bottlenecks
      .map((b) => b.kind)
      .filter((k, i, arr) => !matchedKinds.has(k) && arr.indexOf(k) === i);

    // ── 2. LLM 生成候选 ────────────────────────────────────────────
    let llmCandidates: Candidate[] = [];
    let llmCostUsd = 0;

    /**
     * LLM 的参与范围由 `llm.plan_mode` 决定：
     *
     * - `always`（默认）：对**每个**瓶颈都问一遍，与规则候选一起进决策层排序。
     *   LLM 的价值不只在"补规则的空"：同一个瓶颈，它常能给出规则写不出的
     *   更具体方案（规则是模式匹配，只能覆盖已知形状）。
     * - `fallback`：只在规则库没给出候选时才问（M3 的旧行为）。
     */
    const planMode = config.llm?.plan_mode ?? 'always';
    const llmBottlenecks =
      planMode === 'always'
        ? [...bottlenecks]
        : bottlenecks.filter((b) => !matchedKinds.has(b.kind));

    const llmEnabled = config.llm !== null && config.llm.provider !== 'none';

    if (llmBottlenecks.length > 0 && llmEnabled) {
      try {
        const output = await llm.plan(
          {
            diagnosis: input.diagnosis,
            bottlenecks: llmBottlenecks,
            runId: input.runId,
            project: input.project,
            route: input.route,
            // 带上规则已经给出的候选：否则它会把同一个改法换个说法再提一遍，
            // 然后在去重时被丢掉 —— 用户看到的是"花了钱但没产出"
            existingCandidates: ruleCandidates,
          },
          logger,
        );
        llmCandidates = output.candidates;
        llmCostUsd = output.cost.usd;
        logger.debug('LLM 方案生成完成', {
          planMode,
          inputBottlenecks: llmBottlenecks.length,
          candidates: llmCandidates.length,
          costUsd: llmCostUsd,
        });
      } catch (err) {
        const error = toPerfPilotError(err);
        logger.warn('LLM 方案生成失败，降级为仅规则库', { error: error.message });
      }
    }

    let allCandidates = [...ruleCandidates, ...llmCandidates];

    // ── 3. 记忆召回：调整置信度 + 剔除失败记忆 ──────────────────────
    if (memory !== null) {
      allCandidates = await this.applyMemory(
        allCandidates,
        memory,
        config,
        logger,
        input.techStack,
      );
    }

    // ── 4. 去重 + 过滤 ─────────────────────────────────────────────
    const finalCandidates = this.deduplicate(allCandidates);

    logger.info('方案生成完成', {
      ruleCandidates: ruleCandidates.length,
      llmCandidates: llmCandidates.length,
      final: finalCandidates.length,
      planMode,
      unmatchedKinds,
    });

    return {
      candidates: finalCandidates,
      ruleSetVersion: PLANNER_RULE_SET_VERSION,
      llmCostUsd,
      unmatchedKinds,
    };
  }

  /** 规则库：对每个瓶颈应用所有匹配 kind 的规则 */
  private generateFromRules(
    bottlenecks: readonly Bottleneck[],
    ctx: PlannerContext,
    logger: LoggerPort,
  ): Candidate[] {
    const candidates: Candidate[] = [];

    for (const bottleneck of bottlenecks) {
      const applicableRules = this.rules.filter((r) => r.kind === bottleneck.kind);
      if (applicableRules.length === 0) continue;

      for (const rule of applicableRules) {
        try {
          const produced = rule.plan(bottleneck, ctx);
          candidates.push(...produced);
        } catch (err) {
          const error = toPerfPilotError(err);
          logger.warn('规划规则执行失败', {
            ruleId: rule.id,
            bottleneckId: bottleneck.id,
            error: error.message,
          });
        }
      }
    }

    return candidates;
  }

  /**
   * 记忆召回：调整置信度，剔除曾失败的候选。
   *
   * M6 起实际逻辑搬到了 `core/memory/recall.ts` —— 这里只负责把
   * 「技术栈怎么来的」告诉它。规划器不该同时管规则库、LLM、记忆三件事。
   */
  private async applyMemory(
    candidates: Candidate[],
    memory: MemoryPort,
    config: PerfPilotConfig,
    logger: LoggerPort,
    runTechStack?: string,
  ): Promise<Candidate[]> {
    // 优先级：本次运行推断 > 构造期指定 > 项目画像 > unknown
    const techStack =
      runTechStack ?? this.options.techStack ?? (await this.detectTechStack(memory, config));

    const outcome = await recallAndAdjust({
      memory,
      candidates,
      project: config.project.name,
      techStack,
      logger,
    });

    if (outcome.suppressed.length > 0) {
      logger.info('有候选因失败记忆被剔除', {
        suppressed: outcome.suppressed.map((s) => s.candidateId),
      });
    }

    return outcome.candidates;
  }

  /** 从项目画像或配置推断技术栈 */
  private async detectTechStack(
    memory: MemoryPort,
    config: PerfPilotConfig,
  ): Promise<string> {
    const profile: ProjectProfile | null = await memory.getProfile(config.project.name);
    if (profile !== null) return profile.techStack;
    return 'unknown';
  }

  /**
   * 去重：同一个瓶颈、改**同一个落点**，只保留一个。
   *
   * 判据比早先精确了一层：不以"改动类型"为粒度，而以改动**落点**为粒度
   * （文件 + 键 / AST 节点 / 操作 / 依赖名）。早先只看 type，于是
   * "针对同一个瓶颈换一个配置项"这种**不同**方案会被当成重复丢掉 ——
   * 加了 LLM 之后这变成真问题：它提出的更具体方案与规则那条 type 相同，
   * 一进来就被规则吞掉了，用户看不到任何 LLM 产出。
   *
   * 平手时保留置信度更高的那个：规则是确定性的 0.9、LLM 上限 0.75，
   * 因此**规则优先** —— 可复现的那一份先说话，这是刻意的。
   */
  private deduplicate(candidates: Candidate[]): Candidate[] {
    const seen = new Map<string, Candidate>();

    for (const candidate of candidates) {
      const bnKey = [...candidate.bottleneckIds].sort().join(',');
      const changeKey = candidate.changes.map(changeTarget).sort().join(',');
      const key = `${bnKey}|${changeKey}`;

      const existing = seen.get(key);
      if (existing === undefined || candidate.confidence > existing.confidence) {
        seen.set(key, candidate);
      }
    }

    return [...seen.values()].sort((a, b) => b.confidence - a.confidence);
  }
}

/** 一条改动的落点。同一个落点才算同一个改法 */
function changeTarget(change: PlannedChange): string {
  switch (change.type) {
    case 'config':
      return `config:${change.file}#${change.key}`;
    case 'ast':
      return `ast:${change.file}#${change.node}`;
    case 'asset':
      return `asset:${change.file}#${change.operation}`;
    case 'dependency':
      return `dependency:${[...(change.remove ?? [])].sort().join('+')}|${
        change.replace === undefined ? '' : `${change.replace.from}>${change.replace.to}`
      }`;
    default:
      return 'unknown';
  }
}

export { BUILTIN_PLANNER_RULES, PLANNER_RULE_SET_VERSION } from './rules/index.js';
export * from './types.js';
