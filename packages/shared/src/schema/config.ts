import { z } from 'zod';
import { METRIC_NAMES } from '../types/metric.js';
import type { MetricName } from '../types/metric.js';
import { VERIFIABLE_CHECK_KINDS, type VerifiableCheckKind } from '../types/verification.js';
import { REPORT_FORMATS } from '../types/config.js';

const MetricThresholdConfigSchema = z
  .object({
    warning: z.number().finite(),
    error: z.number().finite(),
  })
  .strict();

/**
 * 指标阈值覆盖表。用 `METRIC_NAMES` 反向构造 shape 再 `.partial()`：
 * 既得到精确类型，又能在运行时拒绝 `LPC: {...}` 这类拼写错误 —— 这是手写
 * `z.record` 做不到的。
 *
 * `.strict()` 不能省：zod 的 `z.object` 默认**静默丢弃**未知键，
 * 少了它，写错的指标名会被无声吞掉，用户以为阈值生效了、实际跑的是默认值。
 */
const metricThresholdShape = Object.fromEntries(
  METRIC_NAMES.map((name) => [name, MetricThresholdConfigSchema]),
) as Record<MetricName, typeof MetricThresholdConfigSchema>;

export const BaselineMetricsSchema = z.object(metricThresholdShape).partial().strict();

/** 所有阈值必须满足 warning ≤ error，否则评分函数的方向就反了 */
const thresholdsRefine = <T extends { warning: number; error: number }>(v: T): boolean =>
  v.warning <= v.error;

export const BaselineMetricsRefinedSchema = BaselineMetricsSchema.refine(
  (metrics) => Object.values(metrics).every((m) => m === undefined || thresholdsRefine(m)),
  { message: '每个指标的 warning 阈值必须 ≤ error 阈值' },
);

export const ProjectConfigSchema = z
  .object({
    name: z.string().min(1),
    root: z.string().min(1).default('.'),
  })
  .strict();

export const TargetConfigSchema = z
  .object({
    url: z.string().url(),
    routes: z.array(z.string().min(1)).min(1).default(['/']),
    // 默认空串是「未接入 SCM」的合法状态，因此这里不能用 .min(1) ——
    // 否则默认值自己就过不了校验，最小配置会直接报错。
    repo: z.string().default(''),
    branch: z.string().min(1).default('main'),
  })
  .strict();

export const BaselineConfigSchema = z
  .object({
    ref: z.string().min(1).default('last-run'),
    metrics: BaselineMetricsRefinedSchema.default({}),
  })
  .strict();

export const OptimizationConfigSchema = z
  .object({
    auto_fix: z.array(z.string().min(1)).default([]),
    manual_confirm: z.array(z.string().min(1)).default([]),
    suggest_only: z.array(z.string().min(1)).default([]),
  })
  .strict();

export const DecisionThresholdsSchema = z
  .object({
    min_gain: z.number().min(0).default(5),
    max_regression: z.number().min(0).default(2),
    max_new_errors: z.number().int().min(0).default(0),
    // 刻度与 core/decision 的效用式对齐：真实候选的 utility 落在个位数到几十，
    // 不是 0-100。60/35 会让所有候选都判 reject（见 M4 实测）。
    apply_score: z.number().default(30),
    confirm_score: z.number().default(10),
  })
  .strict()
  .refine((t) => t.confirm_score <= t.apply_score, {
    message: 'confirm_score 必须 ≤ apply_score，否则裁决区间会重叠',
  });

/**
 * 指标权重覆盖表。与阈值表同一套构造方式：由 `METRIC_NAMES` 反向构造 shape，
 * 既能拒绝 `LPC` 这类拼写错误，又能得到精确类型。
 */
const metricWeightShape = Object.fromEntries(
  METRIC_NAMES.map((name) => [name, z.number().min(0).max(1)]),
) as Record<MetricName, z.ZodNumber>;

export const DecisionWeightsSchema = z
  .object({
    /** 逐指标权重覆盖；缺省项用内置默认（见 core/decision 的 DEFAULT_METRIC_WEIGHTS） */
    metrics: z.object(metricWeightShape).partial().strict().default({}),
    /**
     * 风险厌恶系数 λ。utility = expectedGain × confidence − cost − λ × risk。
     * λ=1 表示「1 分风险抵 1 分收益」；调大则更保守。
     */
    risk_aversion: z.number().min(0).default(1),
  })
  .strict()
  .default({});

export const DecisionConfigSchema = z
  .object({
    jev: z.boolean().default(true),
    thresholds: DecisionThresholdsSchema.default({}),
    weights: DecisionWeightsSchema,
  })
  .strict();

export const ReportConfigSchema = z
  .object({
    format: z.array(z.enum(REPORT_FORMATS)).min(1).default(['markdown', 'json']),
    comment_mr: z.boolean().default(false),
    auto_pr: z.boolean().default(false),
  })
  .strict();

export const CollectConfigSchema = z
  .object({
    timeoutMs: z.number().int().positive().default(120_000),
    /**
     * 采集轮次。>1 时逐指标取**中位数**以降噪。
     *
     * 性能指标天然有抖动（同一份代码两次测出的 LCP 差 50ms 是常事），
     * 而门禁是按差值判的 —— 单轮采集的抖动会被读成"回归"。
     * 代价是采集时间线性增加（`timeoutMs` 是**单轮**超时，不是总超时）。
     */
    runs: z.number().int().positive().max(10).default(1),
  })
  .strict();

/**
 * LLM 配置（README §9.4、ADR 008）。
 *
 * `provider: none`（默认）时**一次调用都不会发生**，方案生成退化为纯规则库 ——
 * 不配就是不花钱，这是刻意的默认值。
 *
 * `openai` 这一个值同时覆盖所有 **OpenAI 兼容**服务（DeepSeek / Qwen / GLM /
 * 本地 Ollama）：填 `base_url` 指向它的入口即可，不必为每个厂商加一个枚举值。
 */
export const LlmConfigSchema = z
  .object({
    provider: z.enum(['openai', 'anthropic', 'none']).default('none'),
    model: z.string().min(1).default('gpt-4o-mini'),
    /** OpenAI 兼容服务的入口地址；不填走 SDK 默认（api.openai.com）。DeepSeek 填 https://api.deepseek.com */
    base_url: z.string().url().nullable().default(null),
    /**
     * 从哪个环境变量读 API key。
     *
     * 不填就交给 SDK 的默认约定（`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`）。
     * 显式写出来的价值：一个机器上同时有多个厂商的 key 时，
     * "这次到底用了哪把钥匙"是能看出来的。
     */
    api_key_env: z.string().min(1).nullable().default(null),
    /** 单轮运行的成本上限（美元）。累计计算，超了就不再调用 */
    maxCostUsd: z.number().min(0).default(2),
    /**
     * LLM 在**方案生成**里的参与范围：
     * - `always`（默认）：对每个瓶颈都出候选，与规则候选一起进决策层排序
     * - `fallback`：只在规则库没给出候选时兜底（M3 的旧行为）
     */
    plan_mode: z.enum(['always', 'fallback']).default('always'),
    /**
     * 是否启用**诊断 agent**：让 LLM 读原始证据（Lighthouse / HAR / trace /
     * bundle scan 的摘要）做归因复核与补充，而不是只靠确定性规则。
     *
     * 关掉它 = LLM 只参与"给方案"，不参与"看问题"。
     */
    diagnose: z.boolean().default(true),
  })
  .strict();

export const MemoryConfigSchema = z
  .object({
    driver: z.enum(['sqlite', 'postgres']).default('sqlite'),
    url: z.string().min(1).default('.perfpilot/memory.db'),
  })
  .strict();

/**
 * 验证阶段的检查项配置（README §11）。
 *
 * 检查是**拿被测项目自己的脚本**跑的（`<包管理器> run <script>`），
 * 因此有两件事必须可配，否则换个技术栈就整条链路失效：
 *
 * 1. **包管理器**。用 pnpm 去跑一个 npm 项目，在没装 pnpm 的 CI runner 上
 *    直接失败 —— 而失败会被记成「检查未通过」，把整轮优化回滚掉，
 *    报出来的理由是"单测没过"，与真正的原因（包管理器不对）毫无关系。
 *    默认 `auto`：从 lockfile 判断，判断不出来才回落到 pnpm。
 * 2. **脚本名与检查清单**。`typecheck` 还是 `type-check`、有没有 E2E，
 *    只有项目自己知道。脚本名写 `null` 表示"这个项目不做这项检查"
 *    （与"没有这个脚本"一样记为 skipped，而不是 failed）。
 */
const checkScriptShape = Object.fromEntries(
  VERIFIABLE_CHECK_KINDS.map((kind) => [kind, z.string().min(1).nullable()]),
) as Record<VerifiableCheckKind, z.ZodNullable<z.ZodString>>;

export const ChecksConfigSchema = z
  .object({
    package_manager: z.enum(['auto', 'pnpm', 'npm', 'yarn', 'bun']).default('auto'),
    kinds: z.array(z.enum(VERIFIABLE_CHECK_KINDS)).min(1).default([...VERIFIABLE_CHECK_KINDS]),
    scripts: z.object(checkScriptShape).partial().strict().default({}),
  })
  .strict();

/**
 * `.perfpilot.yml` 的 schema。
 *
 * 全部 `.strict()`：配置里写错一个键（比如 `minGain` 而不是 `min_gain`）会在
 * 启动时报错，而不是被静默忽略然后用默认值跑完一整轮 CI。
 *
 * **没有 `ci` 段。** 它曾经有两个字段（`trigger` / `baseline`）声明了却没有任何
 * 代码读它们：触发方式只由 CI 平台的 YAML 决定，基线策略在 `baseline.ref` 里。
 * 声明了却不生效的开关比没有更糟 —— 用户会以为改了它有用。
 * 旧配置里写了 `ci:` 会在启动时被 `.strict()` 直接拒绝，这是有意的：
 * 宁可启动就报错，也不要让人对着一份"配了但没反应"的 CI 配置查半天。
 */
export const PerfPilotConfigSchema = z
  .object({
    project: ProjectConfigSchema,
    target: TargetConfigSchema,
    baseline: BaselineConfigSchema.default({}),
    optimization: OptimizationConfigSchema.default({}),
    decision: DecisionConfigSchema.default({}),
    report: ReportConfigSchema.default({}),
    collect: CollectConfigSchema.default({}),
    checks: ChecksConfigSchema.default({}),
    llm: LlmConfigSchema.nullable().default(null),
    memory: MemoryConfigSchema.default({}),
  })
  .strict();

// ─────────────────────────────────────────────────────────────────────
// 类型由 schema 反推 —— 全项目唯一的配置类型来源（README §7）
// ─────────────────────────────────────────────────────────────────────

export type PerfPilotConfig = z.infer<typeof PerfPilotConfigSchema>;
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
export type TargetConfig = z.infer<typeof TargetConfigSchema>;
export type BaselineConfig = z.infer<typeof BaselineConfigSchema>;
export type OptimizationConfig = z.infer<typeof OptimizationConfigSchema>;
export type DecisionConfig = z.infer<typeof DecisionConfigSchema>;
export type DecisionThresholdsConfig = z.infer<typeof DecisionThresholdsSchema>;
export type ReportConfig = z.infer<typeof ReportConfigSchema>;
export type CollectConfig = z.infer<typeof CollectConfigSchema>;
export type ChecksConfig = z.infer<typeof ChecksConfigSchema>;
export type LlmConfig = z.infer<typeof LlmConfigSchema>;
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;

/** 单个指标的阈值对（warning = good 边界，error = poor 边界） */
export type MetricThresholdConfig = z.infer<typeof MetricThresholdConfigSchema>;

/**
 * 指标阈值覆盖表。
 *
 * 所有需要「可选的逐指标阈值」的地方都用这个类型，**不要自己写
 * `Partial<Record<MetricName, MetricThresholdConfig>>`**：后者在
 * `exactOptionalPropertyTypes` 下与 schema 的输出类型不互相赋值。
 */
export type MetricThresholdsOverride = z.infer<typeof BaselineMetricsSchema>;

/**
 * 指标权重覆盖表。
 *
 * 与 `MetricThresholdsOverride` 同样是 schema 反推的：手写
 * `Partial<Record<MetricName, number>>` 在 `exactOptionalPropertyTypes` 下
 * 与 zod 的输出不互相赋值（zod 推出的是 `number | undefined`）。
 */
export type MetricWeightsOverride = z.infer<typeof DecisionWeightsSchema>['metrics'];
export type DecisionWeights = z.infer<typeof DecisionWeightsSchema>;
