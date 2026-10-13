import {
  BOTTLENECK_KINDS,
  CandidateSchema,
  EFFORTS,
  EVIDENCE_KINDS,
  LlmCandidateSchema,
  LlmFindingSchema,
  METRIC_NAMES,
  OPTIMIZATION_CLASSES,
  RISK_LEVELS,
  createNullLlm,
  parseExternal,
  toPerfPilotError,
  type Candidate,
  type LlmCandidateDraft,
  type LlmConfig,
  type LlmCost,
  type LlmDiagnoseInput,
  type LlmDiagnoseOutput,
  type LlmFinding,
  type LlmFindingDraft,
  type LlmPlanInput,
  type LlmPlanOutput,
  type LlmPort,
  type LoggerPort,
} from '@yuki-byte18/shared';

/**
 * core/llm —— 全项目唯一的 LLM 出口（硬约束 6）。
 *
 * 其它模块不得持有 LLM client，必须通过 `LlmPort` 调用。
 * decision 模块更是被 ESLint 规则硬性禁止 import 本目录（硬约束 7）。
 *
 * ## 两个能力，一条边界
 *
 * | 能力 | 谁在用 | 输出 | 错了会怎样 |
 * | --- | --- | --- | --- |
 * | `diagnose` 诊断 agent | `core/diagnoser` | `Bottleneck[]` | 这条结论被丢弃，规则结论照旧 |
 * | `plan` 方案生成 | `core/planner` | `Candidate[]` | 降级为纯规则库 |
 *
 * **决策层永远不在这里。** 诊断可以由 LLM 主导（"这里为什么慢"是开放问题），
 * 决策不行（"改不改"必须可复现）—— 这是这个项目敢在 CI 里当门禁的前提。
 *
 * ## 设计要点
 *
 * 1. **prompt 版本化**：两个 prompt 各自一个版本号，写进产出，历史可追溯。
 * 2. **输出强校验**：必须过 schema，不合法的**逐条**丢弃并告警，
 *    绝不把不可信数据塞进下游。诊断结论还额外要求**至少一条证据**。
 * 3. **成本记账是累计的**：诊断 + 方案两处调用共享 `maxCostUsd`，
 *    否则"每处都不超上限"合起来照样能超。
 * 4. **降级安全**：provider=none、SDK 未装、key 没配、调用报错、输出不是 JSON
 *    —— 任何一种都只让对应能力退化为空，链路不中断。
 */

/** 方案生成 prompt 版本。任何文案改动都要升版本，保证历史候选可解释 */
export const PROMPT_VERSION = 'm3.1.0';

/** 诊断 agent prompt 版本。与方案生成各自独立演进 */
export const DIAGNOSE_PROMPT_VERSION = 'd1.0.0';

/** LLM 网关配置 */
export interface LlmGatewayOptions {
  config: LlmConfig;
  logger: LoggerPort;
  /**
   * 注入 SDK 加载器（**测试用**）。
   *
   * 生产不传，走动态 import。存在的意义是让「输出校验失败要降级」
   * 「成本超限要停手」这些分支能被真实测到 —— 那些分支恰恰是不能靠
   * 真调一次 LLM 来验证的（要花真钱且不确定）。
   */
  loadSdk?: SdkLoader;
}

/** SDK 表面 + provider 的 model 构造函数 */
type SdkLoader = (config: LlmConfig) => Promise<{
  generateText: AiSdkSurface['generateText'];
  model: (name: string) => unknown;
}>;

/**
 * 创建 LLM 网关。
 *
 * provider=none 时直接返回空实现；否则尝试加载 AI SDK。
 * SDK 加载失败（未安装依赖 / key 未配置）时降级为 null 实现并记 warning ——
 * 这样「没装 LLM 依赖」不会让整个 CLI 崩掉，只是退化为纯规则库。
 */
export function createLlmGateway(options: LlmGatewayOptions): LlmPort {
  const { config, logger } = options;

  if (config.provider === 'none') {
    logger.debug('LLM provider=none，方案生成与诊断均仅使用规则库');
    return createNullLlm();
  }

  // 尝试加载 AI SDK。用动态 import 避免在 provider=none 时也强行加载，
  // 也让「没装 ai 依赖」的环境能正常编译运行。
  return createAiSdkLlm(config, logger, options.loadSdk ?? loadAiSdk);
}

/**
 * 基于 Vercel AI SDK 的 LLM 实现。
 *
 * 封装在单独函数里：`loadSdk` 可注入，测试无需真实 SDK 即可覆盖
 * 解析失败、成本超限等分支。
 */
function createAiSdkLlm(config: LlmConfig, logger: LoggerPort, loadSdk: SdkLoader): LlmPort {
  // 延迟加载：只有在真正调用时才 import SDK，避免顶层 import 在未安装时崩溃
  let sdk: Awaited<ReturnType<SdkLoader>> | null = null;

  /**
   * **累计**花费。
   *
   * 早先只在单次调用的返回值上比 `maxCostUsd`，那在只有一个调用点时是对的；
   * 加上诊断 agent 之后就不成立了 —— 诊断花 1.9、方案再花 1.9，
   * 每一处都"没超 2 美元"，合起来快 4 美元。预算必须跨调用累计。
   */
  let spentUsd = 0;
  /** 上一次调用的花费，用来预判"再来一次会不会超" */
  let lastCallUsd = 0;

  async function getSdk() {
    if (sdk !== null) return sdk;
    try {
      sdk = await loadSdk(config);
      return sdk;
    } catch (err) {
      const error = toPerfPilotError(err);
      logger.warn('AI SDK 加载失败，LLM 能力已降级为空', {
        provider: config.provider,
        error: error.message,
      });
      return null;
    }
  }

  /**
   * 预算是否已经用完。
   *
   * 只看"已花 ≥ 上限"是不够的：花了 1.9、上限 2 时会**再放一次**调用进来，
   * 而一次调用可能又要 1 美元 —— 上限就成了摆设。因此再加一条预判：
   * **如果再来一次和上次一样贵的调用就会超，那就不发**。
   * 预判用的是上一次的实测花费（首次没有参照，只能放行）。
   */
  function budgetExhausted(): boolean {
    if (spentUsd >= config.maxCostUsd) return true;
    return lastCallUsd > 0 && spentUsd + lastCallUsd > config.maxCostUsd;
  }

  function charge(cost: LlmCost): void {
    spentUsd += cost.usd;
    lastCallUsd = cost.usd;
  }

  /** 两个能力共用的调用骨架：加载 SDK → 调 → 计成本 → 交给各自的解析器 */
  async function call<T>(input: {
    label: string;
    planLogger: LoggerPort;
    buildPrompt: () => { system: string; prompt: string };
    parse: (text: string) => T[];
    empty: () => T[];
  }): Promise<{ items: T[]; cost: LlmCost }> {
    const noCost: LlmCost = { inputTokens: 0, outputTokens: 0, totalTokens: 0, usd: 0 };

    if (budgetExhausted()) {
      input.planLogger.warn('LLM 预算已用完，跳过本次调用', {
        spentUsd: spentUsd,
        maxCostUsd: config.maxCostUsd,
      });
      return { items: input.empty(), cost: noCost };
    }

    const sdkInstance = await getSdk();
    if (sdkInstance === null) return { items: input.empty(), cost: noCost };

    const startedAt = performance.now();
    const { system, prompt } = input.buildPrompt();

    try {
      const { text, usage } = await sdkInstance.generateText({
        model: sdkInstance.model(config.model),
        system,
        prompt,
        // 限制输出长度，避免 LLM 啰嗦导致成本失控。
        // 两个字段名都传：AI SDK v5 改名为 maxOutputTokens，v4 叫 maxTokens，
        // 少传一个就等于输出长度没人管 —— 那是真金白银的风险。
        maxTokens: 4096,
        maxOutputTokens: 4096,
        temperature: 0.2,
      });

      const cost = computeCost(usage, config.provider);
      charge(cost);

      input.planLogger.debug('LLM 调用完成', {
        label: input.label,
        durationMs: Math.round(performance.now() - startedAt),
        costUsd: cost.usd,
        spentUsd: Math.round(spentUsd * 1e6) / 1e6,
      });

      // 本次调用就让累计值越界：仍然采用本次输出（已经付过钱了），
      // 但后续调用会被 budgetExhausted() 挡住
      const items = input.parse(text);
      return { items, cost };
    } catch (err) {
      const error = toPerfPilotError(err);
      input.planLogger.error('LLM 调用失败，降级为仅规则库', {
        label: input.label,
        error: error.message,
        code: error.code,
      });
      return { items: input.empty(), cost: noCost };
    }
  }

  return {
    async plan(input: LlmPlanInput, planLogger: LoggerPort): Promise<LlmPlanOutput> {
      const { items, cost } = await call<Candidate>({
        label: 'plan',
        planLogger,
        buildPrompt: () => ({ system: buildPlanSystemPrompt(), prompt: buildPlanUserPrompt(input) }),
        parse: (text) => parseCandidates(text, input, planLogger),
        empty: () => [],
      });

      return { candidates: items, cost, promptVersion: PROMPT_VERSION };
    },

    async diagnose(
      input: LlmDiagnoseInput,
      diagnoseLogger: LoggerPort,
    ): Promise<LlmDiagnoseOutput> {
      const { items, cost } = await call<LlmFinding>({
        label: 'diagnose',
        planLogger: diagnoseLogger,
        buildPrompt: () => ({
          system: buildDiagnoseSystemPrompt(),
          prompt: buildDiagnoseUserPrompt(input),
        }),
        parse: (text) => parseFindings(text, input, diagnoseLogger),
        empty: () => [],
      });

      return { findings: items, cost, promptVersion: DIAGNOSE_PROMPT_VERSION };
    },
  };
}

/**
 * 我们实际用到的 AI SDK 表面。
 *
 * 刻意**只声明用到的部分**，而不是 `import type { generateText } from 'ai'`。
 *
 * 原因不是偷懒：LLM provider 在配置里是可选的（`provider: none` 时不走这条路）。
 * 让 `ai` 成为编译期硬依赖，等于要求每个只想跑规则库的用户都装一遍 SDK，
 * 而 M3 的验收明确要求「LLM 不可用时自动降级为仅规则库」。
 * 声明本地契约后：没装 SDK 也能 build / typecheck / 跑测试，
 * 真正调用时才动态加载，失败由上层捕获并降级。
 */
interface AiSdkSurface {
  generateText(options: {
    model: unknown;
    system: string;
    prompt: string;
    maxTokens: number;
    maxOutputTokens: number;
    temperature: number;
  }): Promise<{ text: string; usage: unknown }>;
  /** provider 包的 model 构造函数（openai / anthropic） */
  createModel: (name: string) => unknown;
}

/**
 * 动态加载一个**可选依赖**。
 *
 * specifier 用变量传是必须的：写成字面量 `import('ai')` 时 TypeScript 会去解析
 * 那个包的类型，没装就报 TS2307，整包编译不过 —— 可选依赖就变成了硬依赖。
 * 传变量让 TS 放弃静态解析，代价是失去 SDK 的类型安全，
 * 由上面的 `AiSdkSurface` 契约补回来。
 */
async function importOptional(specifier: string): Promise<unknown> {
  return import(specifier);
}

/**
 * 读取 API key。
 *
 * 配置里给了 `api_key_env` 就**必须**有值：这时用户明确说了"用哪把钥匙"，
 * 拿不到就报错，而不是默默回落到 SDK 的默认约定 ——
 * 那会让"我明明配了 DeepSeek 的 key"变成"结果它去请求了 OpenAI 并 401"。
 */
function apiKeyOf(config: LlmConfig): string | undefined {
  if (config.api_key_env === null) return undefined;

  const value = process.env[config.api_key_env];
  if (value === undefined || value === '') {
    throw new Error(
      `环境变量 ${config.api_key_env} 未设置或为空（llm.api_key_env 指定了它）`,
    );
  }
  return value;
}

async function loadAiSdk(config: LlmConfig): Promise<{
  generateText: AiSdkSurface['generateText'];
  model: (name: string) => unknown;
}> {
  const isOpenAi = config.provider === 'openai';
  const providerPackage = isOpenAi ? '@ai-sdk/openai' : '@ai-sdk/anthropic';
  const providerExport = isOpenAi ? 'openai' : 'anthropic';
  const factoryExport = isOpenAi ? 'createOpenAI' : 'createAnthropic';

  let ai: Partial<AiSdkSurface>;
  try {
    ai = (await importOptional('ai')) as Partial<AiSdkSurface>;
  } catch (err) {
    // 直接抛 Node 的 ERR_MODULE_NOT_FOUND 虽然也算说清了，但它讲的是"哪个文件
    // 找不到哪个模块"，而用户需要知道的只有一件事：装什么。
    throw new Error(
      `可选依赖 \`ai\` 未安装，LLM 功能需要它。请运行 \`npm add ai ${providerPackage}\``,
      { cause: err },
    );
  }

  if (typeof ai.generateText !== 'function') {
    // 提示里必须写**当前 provider 对应的**包：配的是 anthropic 却让装 openai，
    // 会让人以为配置写错了。
    throw new Error(`\`ai\` 包版本不兼容，请运行 \`npm add ai ${providerPackage}\``);
  }

  const provider = (await importOptional(providerPackage)) as Record<string, unknown>;
  const apiKey = apiKeyOf(config);

  /**
   * 优先用工厂函数建一个**带 baseURL 的** provider。
   *
   * `baseURL` 是接国内/自建模型的关键：DeepSeek、Qwen、GLM、vLLM、Ollama
   * 都是 OpenAI 兼容接口，区别只在入口地址。直接用默认导出（`openai`）
   * 会固定打 api.openai.com，`base_url` 配了也不生效 —— 那正是"配了没用"的经典坑。
   */
  const factory = provider[factoryExport];
  const builtWithFactory = typeof factory === 'function';
  const client = builtWithFactory
    ? (factory as (options: Record<string, unknown>) => unknown)({
        ...(config.base_url === null ? {} : { baseURL: config.base_url }),
        ...(apiKey === undefined ? {} : { apiKey }),
      })
    : provider;

  const model = pickModelFactory(client) ?? (builtWithFactory ? null : provider[providerExport]);

  if (typeof model !== 'function') {
    throw new Error(
      builtWithFactory
        ? `\`${providerPackage}\` 的 ${factoryExport} 建出来的 client 上没有模型工厂` +
            '（可用的形态是 client 本身 / .chat / .languageModel）—— 这是版本不兼容，请检查 SDK 版本'
        : `\`${providerPackage}\` 未安装或版本不兼容，请运行 \`npm add ${providerPackage}\``,
    );
  }

  return {
    generateText: ai.generateText,
    model: model as (name: string) => unknown,
  };
}

/**
 * 从 provider client 上挑出"用模型名建模型"的那个函数。
 *
 * ## 这里踩过一个会**静默花错钱**的坑
 *
 * 早先这一行写的是 `client[providerExport]`（即 `client.openai`）。而
 * `@ai-sdk/openai` 建出来的 client **没有** `.openai` 这个属性 —— 它本身可调用
 * （`client('deepseek-chat')`），另有 `.chat` / `.languageModel`。
 * 于是那一行永远是 `undefined`，`??` 于是回退到**默认 provider**：
 * 它只认 `OPENAI_API_KEY`，并且**完全丢掉 base_url**。
 *
 * 后果分两种，都很糟：
 *
 * - 配了 DeepSeek、环境里没有 `OPENAI_API_KEY` → 报 "OpenAI API key is missing"，
 *   把一个用户根本没配过的东西说成原因；
 * - 环境里**恰好**有 `OPENAI_API_KEY` → 请求真的发去 api.openai.com。
 *   用户以为在用 DeepSeek，账单来自 OpenAI。
 *
 * 所以这里显式列出真实存在的三种形态，并且**不再用 `??` 静默兜底**：
 * 工厂建出来的 client 上找不到模型工厂，就当版本不兼容直接报错。
 */
export function pickModelFactory(client: unknown): ((name: string) => unknown) | null {
  if (typeof client === 'function') return client as (name: string) => unknown;
  if (client === null || typeof client !== 'object') return null;

  const candidate = client as { chat?: unknown; languageModel?: unknown };
  if (typeof candidate.chat === 'function') return candidate.chat as (name: string) => unknown;
  if (typeof candidate.languageModel === 'function') {
    return candidate.languageModel as (name: string) => unknown;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// 输出解析
// ─────────────────────────────────────────────────────────────────────

/** 从 LLM 输出中提取 JSON 文本（处理 ```json ... ``` 包裹） */
function extractJson(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();

  // 没有代码块，尝试直接解析整个文本
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return trimmed;

  return null;
}

/** 告警里附原始输出时的截断长度：够看清形状，又不至于淹掉日志 */
const RAW_LOG_LIMIT = 800;

function clip(text: string): string {
  return text.length <= RAW_LOG_LIMIT
    ? text
    : `${text.slice(0, RAW_LOG_LIMIT)}…（共 ${text.length} 字）`;
}

/**
 * 把 LLM 输出解析成 `unknown[]`：剥 markdown、解析 JSON、单对象包成数组。
 *
 * 失败时**一定附上原始输出的开头**。这条是拿真钱换来的：第一次真调 LLM 时，
 * 校验失败的告警里只有 zod 的字段名，看不到模型到底说了什么，
 * 于是"为什么它给的形状不对"只能靠猜 —— 每轮调 prompt 都成了盲调。
 */
function parseJsonArray(text: string, logger: LoggerPort, what: string): unknown[] | null {
  const jsonText = extractJson(text);
  if (jsonText === null) {
    logger.warn(`${what} 输出不是有效 JSON，已丢弃`, { raw: clip(text) });
    return null;
  }

  try {
    const raw: unknown = JSON.parse(jsonText);
    return Array.isArray(raw) ? raw : [raw];
  } catch {
    logger.warn(`${what} 输出 JSON 解析失败，已丢弃`, { raw: clip(jsonText) });
    return null;
  }
}

/**
 * 解析 LLM 输出的候选方案。逐条处理，坏的那条不影响其它。
 *
 * **两道闸**：
 *
 * 1. `LlmCandidateSchema` —— 只问模型"只有它才知道"的东西
 *    （改什么、多大把握、可不可逆）；
 * 2. 我们自己盖章 —— `id` / `runId` / `origin` / `promptVersion` / `recalledFrom`，
 *    以及从 `bottleneckIds` 反查出来的 `bottleneckKinds`；补齐之后再过一遍
 *    **完整**的 `CandidateSchema`，跨字段约束（"不可逆只能是 C 类"）才真正生效。
 *
 * 早先只有第 2 步、没有第 1 步 —— 于是每一条候选都因为
 * "runId: Required / promptVersion: Required" 被拒，花了钱零产出，
 * 而报错看着还像是模型不听话。
 */
function parseCandidates(text: string, input: LlmPlanInput, logger: LoggerPort): Candidate[] {
  const arr = parseJsonArray(text, logger, 'LLM 方案');
  if (arr === null) return [];

  const kindById = new Map(input.bottlenecks.map((b) => [b.id, b.kind]));
  const candidates: Candidate[] = [];

  for (const [index, item] of arr.entries()) {
    try {
      const draft = parseExternal(LlmCandidateSchema, item, { what: 'LLM 候选方案' });

      const kinds = [
        ...new Set(
          draft.bottleneckIds.map((id) => kindById.get(id)).filter((kind) => kind !== undefined),
        ),
      ];

      /**
       * 回链的瓶颈一个都对不上 → 丢弃并说清原因。
       *
       * 候选必须能指回它要解决的问题（报告要按瓶颈分组，决策层要靠它算收益），
       * 而"编一个看起来像的 id"是模型的常见行为。与其留一条看着有方案、
       * 其实不指向任何问题的候选，不如丢掉。
       */
      if (kinds.length === 0) {
        logger.warn('LLM 候选回链的瓶颈都不存在，已丢弃该条', {
          bottleneckIds: draft.bottleneckIds,
          raw: clip(JSON.stringify(item)),
        });
        continue;
      }

      const filled: Candidate = {
        ...draft,
        id: `cand_llm_${input.runId}_${index}`,
        runId: input.runId,
        origin: 'llm',
        ruleId: null,
        promptVersion: PROMPT_VERSION,
        recalledFrom: [],
        bottleneckKinds: kinds,
      };

      candidates.push(parseExternal(CandidateSchema, filled, { what: 'LLM 候选方案' }));
    } catch (err) {
      const error = toPerfPilotError(err);
      logger.warn('LLM 候选校验失败，已丢弃该条', {
        error: error.message,
        raw: clip(JSON.stringify(item)),
      });
    }
  }

  return candidates;
}

/**
 * 校验诊断结论时用的 schema：`impact` 允许缺失（默认空对象）。
 *
 * `impact`（这个瓶颈影响了哪些指标）是**补充信息**，用于报告展示；
 * 证据、归因、种类才是必须的。模型偶尔漏掉它，不该让整条结论作废 ——
 * 那等于为一个小疏漏丢掉一次已经付过钱的调用。
 */
const LlmFindingInputSchema = LlmFindingSchema.extend({
  impact: LlmFindingSchema.shape.impact.default({}),
});

/**
 * 解析诊断 agent 的输出。
 *
 * 三道闸，缺一不可：
 * 1. **schema 校验** —— 种类/归因字段都是枚举，编不出来
 * 2. **必须有证据**（`evidence` 至少一条，写在 `LlmFindingSchema` 里）——
 *    没有证据的结论无法复核，等于让一个不可验证的说法进报告
 * 3. **id / runId / source 由我们盖章** —— LLM 只提供"发现了什么"
 */
function parseFindings(text: string, input: LlmDiagnoseInput, logger: LoggerPort): LlmFinding[] {
  const arr = parseJsonArray(text, logger, 'LLM 诊断');
  if (arr === null) return [];

  const findings: LlmFinding[] = [];
  for (const [index, item] of arr.entries()) {
    try {
      const parsed = parseExternal(LlmFindingInputSchema, item, { what: 'LLM 诊断结论' });

      findings.push({
        bottleneck: {
          id: `bn_llm_${input.runId}_${index}`,
          runId: input.runId,
          kind: parsed.kind,
          title: parsed.title,
          severity: parsed.severity,
          impact: parsed.impact,
          attribution: parsed.attribution,
          evidence: parsed.evidence,
          // 上限 0.75：LLM 的结论天然比确定性规则更不确定，别让它自称很有把握
          confidence: Math.min(parsed.confidence, 0.75),
          occurrences: 1,
          source: 'llm',
        },
        refines: parsed.refines ?? null,
      });
    } catch (err) {
      const error = toPerfPilotError(err);
      logger.warn('LLM 诊断结论校验失败，已丢弃该条', {
        error: error.message,
        raw: clip(JSON.stringify(item)),
      });
    }
  }

  return findings;
}

/**
 * 估算成本（简化版：按 token 数 × 单价）。
 *
 * 入参是 `unknown` 而不是具体的 usage 类型：AI SDK 的 usage 字段名跨版本变动过
 * （`promptTokens` / `inputTokens` / `usage.inputTokens` 都出现过）。
 * 与其绑死一个版本，不如在这里宽松读取 —— 读不到就当 0，
 * 成本记账宁可少算也不能因为字段改名而崩掉整轮方案生成。
 */
function computeCost(usage: unknown, provider: string): LlmCost {
  const read = (source: unknown, key: string): number => {
    if (typeof source !== 'object' || source === null) return 0;
    const value = (source as Record<string, unknown>)[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  };

  const inputTokens = read(usage, 'promptTokens') || read(usage, 'inputTokens');
  const outputTokens = read(usage, 'completionTokens') || read(usage, 'outputTokens');
  const totalTokens = read(usage, 'totalTokens') || inputTokens + outputTokens;

  // 粗略单价（美元/1K tokens），实际应查对应模型的定价。
  // 走 OpenAI 兼容入口的第三方服务（DeepSeek 等）单价更低，这里会**高估** ——
  // 宁可高估：高估只会让预算更早停手，低估会让账单超预期。
  const inputPrice = provider === 'anthropic' ? 0.003 : 0.0005;
  const outputPrice = provider === 'anthropic' ? 0.015 : 0.0015;

  const usd = (inputTokens / 1000) * inputPrice + (outputTokens / 1000) * outputPrice;

  return { inputTokens, outputTokens, totalTokens, usd: Math.round(usd * 1e6) / 1e6 };
}

// ─────────────────────────────────────────────────────────────────────
// Prompt 构造
// ─────────────────────────────────────────────────────────────────────

/**
 * 把枚举数组渲染成 prompt 里的一行。
 *
 * **从常量生成，不手抄**：上一次真调 LLM，模型编出了 `kind: "IMAGE_SIZE"`
 * （一个指标名），因为 prompt 只说"必须是给定枚举值之一"却**从没给出枚举**。
 * 手抄还有第二个坑：schema 加了新种类，prompt 不会跟着变，而且没人会发现。
 */
const listOf = (values: readonly string[]): string => values.join(' | ');

/**
 * Prompt 里的示例 —— **不是装饰**。
 *
 * 模型的输出形状几乎完全跟着示例走。第一次真调 LLM 时，输入里把规则证据
 * 渲染成了字符串数组，模型就照着输出字符串数组，而 schema 要的是对象：
 * 5 条结论全被丢掉，花了钱零产出。
 *
 * 类型标注让"示例本身不合法"在编译期暴露；`llm-prompt.test.ts` 再用
 * **真正的 schema** 校验一次（跨字段 refine 只在运行时生效）。
 */
const DIAGNOSE_EXAMPLE: LlmFindingDraft = {
  kind: 'LONG_MAIN_THREAD_TASK',
  title: '首屏存在 240ms 长任务，与第三方统计脚本的加载时间重合',
  severity: 70,
  impact: { TBT: 240, INP: 180 },
  attribution: {
    level: 'source',
    file: 'src/main.ts',
    line: 42,
    column: null,
    component: null,
  },
  evidence: [
    {
      kind: 'trace-event',
      description: 'trace 中 1.8s 处有一个 240ms 长任务，topFrame 指向 src/main.ts:42',
      payload: { durationMs: 240, startTime: 1800 },
    },
  ],
  confidence: 0.6,
  refines: 'bn_rule_1',
};

const PLAN_EXAMPLE: LlmCandidateDraft = {
  bottleneckIds: ['bn_rule_1'],
  class: 'B',
  title: '把非首屏路由改成按需加载',
  description:
    '首屏只需要首页组件。把路由表里的静态 import 改成 () => import(...)，其余路由的代码延后到访问时再下载。',
  changes: [
    {
      type: 'ast',
      file: 'src/router/index.ts',
      node: 'lazy-route-component',
      description: '把 component: Home 改成 () => import("../views/Home.vue")',
    },
  ],
  expectedGain: { LCP: 300, FCP: 150 },
  confidence: 0.6,
  risk: 'medium',
  effort: 'low',
  reversible: true,
};

function buildPlanSystemPrompt(): string {
  return [
    '你是前端性能优化专家。根据诊断结果，为每个瓶颈生成可执行的优化方案。',
    '',
    '## 输出格式（严格遵守）',
    '',
    '只输出 JSON 数组，不要解释文字、不要 markdown 代码块。每个元素形如：',
    '',
    JSON.stringify(PLAN_EXAMPLE, null, 2),
    '',
    '**不要**输出 id / runId / origin / ruleId / promptVersion / recalledFrom / bottleneckKinds：',
    '这些由我们自己填（你写了也会被忽略）。你只需要回答"改什么、为什么、多大把握、可不可逆"。',
    '',
    '## 字段约束',
    '',
    '1. `bottleneckIds` 至少一个，且必须是**输入里出现过**的瓶颈 id。',
    '2. `changes` 至少一项，`type` 只能是下面四类，并按类型给全字段（多给字段会被拒）：',
    '   - `ast`：file, node, description（可选 before / after）',
    '   - `asset`：file, operation（convert-webp | compress | resize）, params',
    '   - `config`：file, key, before, after',
    '   - `dependency`：reason（可选 remove / replace）',
    `3. \`class\` 只能是 ${listOf(OPTIMIZATION_CLASSES)}：A=全自动（不改运行时语义），`,
    '   B=半自动（改渲染/加载时序，需人工确认），C=仅建议。',
    '4. `reversible: false` 的候选只能是 C 类。',
    `5. \`expectedGain\` 的键取自：${listOf(METRIC_NAMES)}；数值单位与该指标一致（ms / byte / count）。`,
    '   只写这个改法**真能改变**的指标：拆分 chunk 不会减少总字节数，压缩图片不会改善 LCP 的服务器部分。',
    '   宁可少写，也不要写一个做不到的数字 —— 猜大的收益会在验证阶段直接被打回。',
    `6. \`confidence\` 不超过 0.75；\`risk\` 取 ${listOf(RISK_LEVELS)}；\`effort\` 取 ${listOf(EFFORTS)}。`,
  ].join('\n');
}

function buildPlanUserPrompt(input: LlmPlanInput): string {
  const bottlenecksSummary = input.bottlenecks
    .map((b) => `- [${b.kind}] ${b.title} (severity=${b.severity}, confidence=${b.confidence})`)
    .join('\n');

  return JSON.stringify(
    {
      project: input.project,
      route: input.route,
      runId: input.runId,
      bottlenecks: input.bottlenecks.map((b) => ({
        id: b.id,
        kind: b.kind,
        title: b.title,
        severity: b.severity,
        impact: b.impact,
        attribution: b.attribution,
        confidence: b.confidence,
      })),
      bottlenecksSummary,
      /**
       * 规则库已经给出的候选。**必须告诉它**：否则 LLM 会把同一个改法
       * 换个说法再提一遍，然后在去重时被丢掉 —— 白花钱，还看得见地"没产出"。
       */
      existingCandidates: (input.existingCandidates ?? []).map((c) => ({
        id: c.id,
        title: c.title,
        class: c.class,
        changes: c.changes,
      })),
    },
    null,
    2,
  );
}

function buildDiagnoseSystemPrompt(): string {
  return [
    '你是前端性能诊断专家。输入是一次真实运行采集到的数据摘要，以及确定性规则已经给出的结论。',
    '',
    '你的任务是**复核与补充**，不是从零猜：',
    'A. 如果规则结论正确，不要重复它。',
    'B. 如果规则结论的归因太粗（比如只说"某个 chunk 大"），你可以给出更具体的归因，',
    '   并在 `refines` 里写上那条规则的瓶颈 id。',
    'C. 补充规则漏掉的问题 —— 尤其是需要跨来源关联才能看出来的',
    '   （例如某个长任务与某个第三方脚本的加载时间重合）。',
    '',
    '## 输出格式（严格遵守；不合规的整条会被丢弃）',
    '',
    '只输出 JSON 数组，不要解释文字、不要 markdown 代码块。每个元素形如：',
    '',
    JSON.stringify(DIAGNOSE_EXAMPLE, null, 2),
    '',
    '## 字段约束',
    '',
    '1. `kind` 必须**逐字**取自这个列表（不许自造，也不许拿指标名当种类）：',
    `   ${listOf(BOTTLENECK_KINDS)}`,
    '2. `evidence` 必须是**对象数组**（至少一条），每项的 `kind` 取自：',
    `   ${listOf(EVIDENCE_KINDS)}`,
    '   ⚠️ 输入里的 `ruleFindings[].evidence` 是给你**读**的字符串摘要，形状与你输出的不同：',
    '   你输出的是对象，且 `description` 要点明这条结论是从输入的哪一项数据得出的。',
    '   **没有证据的结论一律会被丢弃。**',
    '3. `attribution` 按 `level` 给字段，**多给字段也会被拒**（每个 level 都是 strict）：',
    '   - resource: url, size, contentType',
    '   - dependency: name, version（可为 null）, size',
    '   - source: file, line, column（可为 null）, component（可为 null）',
    '   - component: name, file（可为 null）, line（可为 null）, renderCount（可为 null）',
    '   - config: file, key',
    `4. \`impact\` 是"指标名 → 数值"的对象，键取自：${listOf(METRIC_NAMES)}。`,
    '   只写你**确有数据支撑**的指标；一个都没有就写 `{}`。',
    '5. `severity` 取 0-100；`confidence` 不要超过 0.75。',
    '6. `refines` 只在"你在复核某条规则结论"时出现，值是那条规则的瓶颈 id；否则整个字段不要写。',
    '7. 输入数据不足以支撑任何新结论时，输出 `[]`。',
    '   **宁可什么都不说，也不要编一个看起来合理但没有数据支撑的问题。**',
  ].join('\n');
}

function buildDiagnoseUserPrompt(input: LlmDiagnoseInput): string {
  return JSON.stringify(
    {
      project: input.project,
      route: input.route,
      device: input.device,
      runId: input.runId,
      metrics: input.evidence.metrics,
      deltas: input.evidence.deltas,
      sources: input.evidence.sources,
      ruleFindings: input.ruleFindings.map((b) => ({
        id: b.id,
        kind: b.kind,
        title: b.title,
        severity: b.severity,
        impact: b.impact,
        attribution: b.attribution,
        /**
         * 证据**按对象的形状**给，只省略 payload。
         *
         * 早先这里传的是 `e.description`（字符串数组），于是模型照着输出字符串，
         * 而 schema 要的是对象 —— 5 条结论全被丢掉。**给模型看什么形状，
         * 它就会还什么形状**，这一点比 prompt 里写十行说明都管用。
         */
        evidence: b.evidence.map((e) => ({ kind: e.kind, description: e.description })),
      })),
    },
    null,
    2,
  );
}

/** 供测试与文档使用：把诊断输入渲染成实际发送的 prompt（不发起调用） */
export function renderDiagnosePrompt(input: LlmDiagnoseInput): string {
  return buildDiagnoseUserPrompt(input);
}

/**
 * 供测试使用的 prompt 契约出口。
 *
 * 存在的意义只有一个：让 `prompt-contract.test.ts` 能验两件事。
 *
 * 1. **示例本身合法** —— 用**真正的 schema** 校验。类型标注管得住字段名，
 *    管不住跨字段 refine 与 `.strict()`，而那两条恰恰是运行时真正生效的。
 * 2. **枚举逐字出现在 prompt 里** —— 枚举加了新值、prompt 没跟上时，
 *    模型会给出"看着合理但不在枚举里"的种类（真实发生过：拿指标名 `IMAGE_SIZE`
 *    当瓶颈种类），整条结论被丢弃：花了钱、零产出，报错还像是模型不听话。
 */
export const LLM_PROMPT_CONTRACT = {
  plan: buildPlanSystemPrompt,
  diagnose: buildDiagnoseSystemPrompt,
  planExample: PLAN_EXAMPLE,
  diagnoseExample: DIAGNOSE_EXAMPLE,
} as const;
