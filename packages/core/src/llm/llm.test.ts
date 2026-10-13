import { describe, expect, it } from 'vitest';
import {
  CandidateSchema,
  LlmConfigSchema,
  createNullLlm,
  type Bottleneck,
  type Diagnosis,
  type LlmConfig,
  type LlmPlanInput,
} from '@yuki-byte18/shared';
import { PROMPT_VERSION, createLlmGateway } from './index.js';
import { createMemoryLogger, createSilentLogger } from '../logger/index.js';

/**
 * `core/llm` 验收测试（M3 标准 4 / 5 / 6）。
 *
 * 全部通过注入 `loadSdk` 完成，**不真调 LLM**：
 * 需要验证的分支恰恰是「输出不合法」「成本超限」这类异常路径，
 * 靠真模型既不确定也费钱。
 */

const silent = createSilentLogger();

/**
 * 走 schema 构造配置，而不是手写字面量。
 *
 * `llm` 段在长出 `base_url` / `plan_mode` / `diagnose` 之后，手写的那份
 * 会立刻编译失败 —— 让 schema 提供默认值，以后加字段不用再改测试。
 */
const llmConfig = (overrides: Partial<LlmConfig> = {}): LlmConfig =>
  LlmConfigSchema.parse({ provider: 'openai', model: 'gpt-4o-mini', ...overrides });

let seq = 0;
function bottleneck(): Bottleneck {
  seq += 1;
  return {
    id: `bn_${seq}`,
    runId: 'run_1',
    kind: 'UNUSED_DEPENDENCY',
    title: '未使用的依赖',
    severity: 40,
    impact: {},
    attribution: { level: 'dependency', name: 'lodash', version: null, size: 71_000 },
    evidence: [],
    confidence: 0.9,
    occurrences: 1,
    source: 'rule',
  };
}

function diagnosis(): Diagnosis {
  return {
    id: 'diag_1',
    runId: 'run_1',
    project: 'demo',
    route: '/',
    device: 'mobile',
    baselineRef: null,
    metrics: [],
    baselineMetrics: [],
    deltas: [],
    regressions: [],
    bottlenecks: [],
    summary: '',
    ruleSetVersion: 'm2.1.0',
    createdAt: '2026-01-17T14:25:30.000Z',
  };
}

function planInput(targets: Bottleneck[]): LlmPlanInput {
  return {
    diagnosis: diagnosis(),
    bottlenecks: targets,
    runId: 'run_1',
    project: 'demo',
    route: '/',
  };
}

/** 一份合法的 LLM 输出（对应给定瓶颈） */
function validCandidateJson(target: Bottleneck): Record<string, unknown> {
  return {
    id: `cand_llm_${target.id}`,
    runId: 'run_1',
    bottleneckIds: [target.id],
    class: 'B',
    title: '拆分该组件',
    description: '按需加载',
    origin: 'llm',
    ruleId: null,
    promptVersion: PROMPT_VERSION,
    changes: [{ type: 'ast', file: 'src/App.tsx', node: 'component', description: '拆分' }],
    expectedGain: { LCP: 200 },
    confidence: 0.6,
    risk: 'medium',
    effort: 'medium',
    reversible: true,
    recalledFrom: [],
    bottleneckKinds: [target.kind],
  };
}

/** 用固定文本构造一个假的 SDK */
function sdkReturning(text: string, usage: Record<string, number> = { promptTokens: 100, completionTokens: 50, totalTokens: 150 }) {
  return async () => ({
    generateText: async () => ({ text, usage }),
    model: () => ({}),
  });
}

// ─────────────────────────────────────────────────────────────────────
// 验收 4：输出校验与降级
// ─────────────────────────────────────────────────────────────────────

describe('M3 验收 4 — LLM 输出校验与降级', () => {
  it('合法输出被解析为候选，并回填 runId / origin / promptVersion', async () => {
    const target = bottleneck();
    const llm = createLlmGateway({
      config: llmConfig(),
      logger: silent,
      loadSdk: sdkReturning(JSON.stringify([validCandidateJson(target)])),
    });

    const output = await llm.plan(planInput([target]), silent);

    expect(output.candidates).toHaveLength(1);
    expect(output.candidates[0]?.runId).toBe('run_1');
    expect(output.candidates[0]?.origin).toBe('llm');
    expect(output.candidates[0]?.ruleId).toBeNull();
    // 验收 5：promptVersion 写入候选
    expect(output.candidates[0]?.promptVersion).toBe(PROMPT_VERSION);
  });

  it('包裹在 markdown 代码块里的 JSON 也能解析', async () => {
    const target = bottleneck();
    const text = `这里是建议：\n\`\`\`json\n${JSON.stringify([validCandidateJson(target)])}\n\`\`\`\n以上。`;

    const llm = createLlmGateway({ config: llmConfig(), logger: silent, loadSdk: sdkReturning(text) });
    const output = await llm.plan(planInput([target]), silent);

    expect(output.candidates).toHaveLength(1);
  });

  it('完全不是 JSON 的输出 → 丢弃并告警，不抛错', async () => {
    const logger = createMemoryLogger();
    const llm = createLlmGateway({
      config: llmConfig(),
      logger,
      loadSdk: sdkReturning('我觉得这个页面需要优化一下性能。'),
    });

    const output = await llm.plan(planInput([bottleneck()]), logger);

    expect(output.candidates).toEqual([]);
    expect(logger.entries.some((e) => e.level === 'warn')).toBe(true);
  });

  it('JSON 合法但字段不合规 → 丢弃该条，不影响同批次其它候选', async () => {
    const good = bottleneck();
    const bad = bottleneck();
    const logger = createMemoryLogger();

    // 第二条 confidence 越界（>1），必须被 schema 拦下
    const payload = [
      validCandidateJson(good),
      { ...validCandidateJson(bad), confidence: 3 },
    ];

    const llm = createLlmGateway({
      config: llmConfig(),
      logger,
      loadSdk: sdkReturning(JSON.stringify(payload)),
    });

    const output = await llm.plan(planInput([good, bad]), logger);

    expect(output.candidates).toHaveLength(1);
    expect(output.candidates[0]?.bottleneckIds).toEqual([good.id]);
    expect(logger.entries.some((e) => e.level === 'warn')).toBe(true);
  });

  it('缺必填字段的候选被丢弃（bottleneckIds 为空）', async () => {
    const target = bottleneck();
    const payload = [{ ...validCandidateJson(target), bottleneckIds: [] }];

    const llm = createLlmGateway({
      config: llmConfig(),
      logger: silent,
      loadSdk: sdkReturning(JSON.stringify(payload)),
    });

    const output = await llm.plan(planInput([target]), silent);
    expect(output.candidates).toEqual([]);
  });

  it('不可逆却标成 B 类的候选被 schema 拒绝', async () => {
    const target = bottleneck();
    const payload = [{ ...validCandidateJson(target), reversible: false }];

    const llm = createLlmGateway({
      config: llmConfig(),
      logger: silent,
      loadSdk: sdkReturning(JSON.stringify(payload)),
    });

    expect((await llm.plan(planInput([target]), silent)).candidates).toEqual([]);
  });

  it('SDK 加载失败 → 降级为空实现并告警，调用不抛错', async () => {
    const logger = createMemoryLogger();
    const llm = createLlmGateway({
      config: llmConfig(),
      logger,
      loadSdk: async () => {
        throw new Error("Cannot find package 'ai'");
      },
    });

    const output = await llm.plan(planInput([bottleneck()]), logger);

    expect(output.candidates).toEqual([]);
    expect(output.cost.usd).toBe(0);
    expect(logger.entries.some((e) => e.level === 'warn')).toBe(true);
  });

  it('provider=none 时直接返回空实现，不加载 SDK', async () => {
    let loaded = false;
    const llm = createLlmGateway({
      config: llmConfig({ provider: 'none' }),
      logger: silent,
      loadSdk: async () => {
        loaded = true;
        throw new Error('不该被调用');
      },
    });

    const output = await llm.plan(planInput([bottleneck()]), silent);
    expect(loaded).toBe(false);
    expect(output.candidates).toEqual([]);
  });

  it('返回单个对象（而非数组）也能被接受', async () => {
    const target = bottleneck();
    const llm = createLlmGateway({
      config: llmConfig(),
      logger: silent,
      loadSdk: sdkReturning(JSON.stringify(validCandidateJson(target))),
    });

    expect((await llm.plan(planInput([target]), silent)).candidates).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 验收 6：成本记账
// ─────────────────────────────────────────────────────────────────────

describe('M3 验收 6 — 成本记账与预算', () => {
  it('成本按 token 数结算并写进返回值', async () => {
    const target = bottleneck();
    const llm = createLlmGateway({
      config: llmConfig(),
      logger: silent,
      loadSdk: sdkReturning(JSON.stringify([validCandidateJson(target)]), {
        promptTokens: 1_000,
        completionTokens: 500,
        totalTokens: 1_500,
      }),
    });

    const output = await llm.plan(planInput([target]), silent);

    expect(output.cost.inputTokens).toBe(1_000);
    expect(output.cost.outputTokens).toBe(500);
    expect(output.cost.totalTokens).toBe(1_500);
    expect(output.cost.usd).toBeGreaterThan(0);
  });

  /**
   * 预算语义（第二轮改过，理由写在这里）：
   *
   * 早先是"单次调用费用超上限 → **丢弃本次输出**，但成本照记"。那个做法在
   * 只有一个调用点时看着安全，实际上是**为已经付过的钱再付一次代价** ——
   * 钱已经花了，把答案扔掉不会让账单变小，只是白花。
   *
   * 现在改成**调用前**判断：已经花掉的 + 上一次的实测花费 会超上限，就不再发起。
   * 因此这里断言变成：调用照样发生（第一次没有参照）、成本照记、
   * 而**后续调用被挡住**（见 diagnose.test.ts 的累计预算用例）。
   */
  it('单次调用就可能超预算时：照样采用本次输出，但成本照记且后续不再调用', async () => {
    const logger = createMemoryLogger();
    const target = bottleneck();

    const llm = createLlmGateway({
      // 预算压到极低：第一次调用没有参照只能放行，之后必须停手
      config: llmConfig({ maxCostUsd: 0.000001 }),
      logger,
      loadSdk: sdkReturning(JSON.stringify([validCandidateJson(target)]), {
        promptTokens: 500_000,
        completionTokens: 200_000,
        totalTokens: 700_000,
      }),
    });

    const output = await llm.plan(planInput([target]), logger);

    // 付过钱的那一次输出被采用（丢掉它等于白花钱）
    expect(output.candidates).toHaveLength(1);
    expect(output.cost.usd).toBeGreaterThan(0.000001);

    // 但紧接着的第二次调用会被预算挡住，且不再产生费用
    const second = await llm.plan(planInput([target]), logger);
    expect(second.candidates).toEqual([]);
    expect(second.cost.usd).toBe(0);
    expect(logger.entries.some((e) => e.level === 'warn' && e.msg.includes('预算已用完'))).toBe(true);
  });

  it('usage 字段改名（inputTokens/outputTokens）时也能读到', async () => {
    const target = bottleneck();
    const llm = createLlmGateway({
      config: llmConfig(),
      logger: silent,
      loadSdk: sdkReturning(JSON.stringify([validCandidateJson(target)]), {
        inputTokens: 800,
        outputTokens: 200,
      } as Record<string, number>),
    });

    const output = await llm.plan(planInput([target]), silent);
    expect(output.cost.inputTokens).toBe(800);
    expect(output.cost.outputTokens).toBe(200);
  });

  it('usage 完全缺失时成本为 0，不抛错', async () => {
    const target = bottleneck();
    const llm = createLlmGateway({
      config: llmConfig(),
      logger: silent,
      loadSdk: async () => ({
        generateText: async () => ({ text: JSON.stringify([validCandidateJson(target)]), usage: undefined }),
        model: () => ({}),
      }),
    });

    const output = await llm.plan(planInput([target]), silent);
    expect(output.cost.usd).toBe(0);
    expect(output.candidates).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 验收 5：prompt 版本化
// ─────────────────────────────────────────────────────────────────────

describe('M3 验收 5 — prompt 版本化', () => {
  it('返回的 promptVersion 与写入候选的一致', async () => {
    const target = bottleneck();
    const llm = createLlmGateway({
      config: llmConfig(),
      logger: silent,
      loadSdk: sdkReturning(JSON.stringify([validCandidateJson(target)])),
    });

    const output = await llm.plan(planInput([target]), silent);

    expect(output.promptVersion).toBe(PROMPT_VERSION);
    expect(output.candidates[0]?.promptVersion).toBe(output.promptVersion);
  });

  it('版本号形如 m<主版本>.<次版本>.<修订>，可用于追溯', () => {
    expect(PROMPT_VERSION).toMatch(/^m\d+\.\d+\.\d+$/);
  });

  it('LLM 自己编的 promptVersion 会被覆盖为网关当前版本', async () => {
    const target = bottleneck();
    const forged = { ...validCandidateJson(target), promptVersion: 'm9.9.9' };

    const llm = createLlmGateway({
      config: llmConfig(),
      logger: silent,
      loadSdk: sdkReturning(JSON.stringify([forged])),
    });

    const output = await llm.plan(planInput([target]), silent);
    // 候选里不能留 LLM 自己声称的版本 —— 那会让追溯指向一个不存在的 prompt
    expect(output.candidates[0]?.promptVersion).toBe(PROMPT_VERSION);
  });

  it('产出的候选全部能通过 CandidateSchema', async () => {
    const target = bottleneck();
    const llm = createLlmGateway({
      config: llmConfig(),
      logger: silent,
      loadSdk: sdkReturning(JSON.stringify([validCandidateJson(target)])),
    });

    const output = await llm.plan(planInput([target]), silent);
    for (const candidate of output.candidates) {
      expect(CandidateSchema.safeParse(candidate).success).toBe(true);
    }
  });
});

describe('createNullLlm', () => {
  it('返回空候选与零成本，promptVersion 明确标为 none', async () => {
    const output = await createNullLlm().plan(planInput([bottleneck()]), silent);

    expect(output.candidates).toEqual([]);
    expect(output.cost.usd).toBe(0);
    expect(output.promptVersion).toBe('none');
  });
});
