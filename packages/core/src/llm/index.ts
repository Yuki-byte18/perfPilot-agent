import {
  CandidateSchema,
  LlmFindingSchema,
  createNullLlm,
  parseExternal,
  toPerfPilotError,
  type Candidate,
  type LlmConfig,
  type LlmCost,
  type LlmDiagnoseInput,
  type LlmDiagnoseOutput,
  type LlmFinding,
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
  const client =
    typeof factory === 'function'
      ? (factory as (options: Record<string, unknown>) => Record<string, unknown>)({
          ...(config.base_url === null ? {} : { baseURL: config.base_url }),
          ...(apiKey === undefined ? {} : { apiKey }),
        })
      : provider;

  const model = client[providerExport] ?? provider[providerExport];
  if (typeof model !== 'function') {
    throw new Error(
      `\`${providerPackage}\` 未安装或版本不兼容，请运行 \`npm add ${providerPackage}\``,
    );
  }

  return {
    generateText: ai.generateText,
    model: model as (name: string) => unknown,
  };
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

/** 把 LLM 输出解析成 `unknown[]`：剥 markdown、解析 JSON、单对象包成数组 */
function parseJsonArray(text: string, logger: LoggerPort, what: string): unknown[] | null {
  const jsonText = extractJson(text);
  if (jsonText === null) {
    logger.warn(`${what} 输出不是有效 JSON，已丢弃`);
    return null;
  }

  try {
    const raw: unknown = JSON.parse(jsonText);
    return Array.isArray(raw) ? raw : [raw];
  } catch {
    logger.warn(`${what} 输出 JSON 解析失败，已丢弃`);
    return null;
  }
}

/** 解析 LLM 输出的候选方案。失败的候选逐个丢弃，不影响其它。 */
function parseCandidates(text: string, input: LlmPlanInput, logger: LoggerPort): Candidate[] {
  const arr = parseJsonArray(text, logger, 'LLM 方案');
  if (arr === null) return [];

  const candidates: Candidate[] = [];
  for (const item of arr) {
    try {
      const parsed = parseExternal(CandidateSchema, item, { what: 'LLM 候选方案' });
      // 补全 runId 和 promptVersion（LLM 不该自己编这些）
      candidates.push({
        ...parsed,
        runId: input.runId,
        promptVersion: PROMPT_VERSION,
        origin: 'llm',
        ruleId: null,
      });
    } catch (err) {
      const error = toPerfPilotError(err);
      logger.warn('LLM 候选校验失败，已丢弃该条', { error: error.message });
    }
  }

  return candidates;
}

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
      const parsed = parseExternal(LlmFindingSchema, item, { what: 'LLM 诊断结论' });

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
      logger.warn('LLM 诊断结论校验失败，已丢弃该条', { error: error.message });
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

function buildPlanSystemPrompt(): string {
  return [
    '你是前端性能优化专家。根据诊断结果，为每个瓶颈生成可执行的优化方案。',
    '',
    '严格遵守以下规则：',
    '1. 只输出 JSON 数组，不要任何解释文字或 markdown 代码块。',
    '2. 每个候选必须回链到至少一个瓶颈（bottleneckIds 非空）。',
    '3. expectedGain 只列出该候选能影响的指标，单位与 Metric 一致（ms/byte/count）。',
    '4. class 只能是 A/B/C：A=全自动（不改运行时语义），B=半自动（改渲染/加载时序），C=仅建议。',
    '5. reversible=false 的候选只能是 C 类。',
    '6. confidence 不要超过 0.75（LLM 生成的方案天然有不确定性）。',
    '7. changes 数组至少一项，每项必须有 type 字段。',
    '8. expectedGain 只能写这个改法**真能改变**的指标：拆分 chunk 不会减少总字节数，',
    '   压缩图片不会改善 LCP 的服务器部分。宁可少写，也不要写一个做不到的数字。',
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
    '   并在 refines 里写上那条规则的 bottleneck id。',
    'C. 补充规则漏掉的问题 —— 尤其是需要跨来源关联才能看出来的',
    '   （例如某个长任务与某个第三方脚本的加载时间重合）。',
    '',
    '硬性要求：',
    '1. 只输出 JSON 数组，不要解释文字或 markdown 代码块。',
    '2. kind 必须是给定的枚举值之一，不能自造。',
    '3. 每一条结论**必须**带至少一条 evidence，且 evidence 的 description 里要点明',
    '   它是从输入的哪一项数据得出的。**没有证据的结论一律会被丢弃。**',
    '4. attribution 必须符合 level 对应的结构（resource/dependency/source/component/config）。',
    '5. severity 取 0-100；confidence 不要超过 0.75。',
    '6. 如果输入的数据不足以支撑任何新结论，就输出空数组 []。',
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
        evidence: b.evidence.map((e) => e.description),
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
