import { describe, expect, it } from 'vitest';
import {
  LlmConfigSchema,
  type LlmConfig,
  type LlmDiagnoseInput,
  type LlmDiagnoseOutput,
} from '@yuki-byte18/shared';
import { DIAGNOSE_PROMPT_VERSION, createLlmGateway, renderDiagnosePrompt } from './index.js';
import { createSilentLogger } from '../logger/index.js';

/**
 * 诊断 agent（L2）的测试。
 *
 * 与 `llm.test.ts` 同一套办法：注入 `loadSdk`，**不真调模型**。
 * 要验的分支恰恰是"模型胡说八道时要怎么办"，那些分支靠真模型既不确定也费钱。
 */

const silent = createSilentLogger();

const config = (overrides: Partial<LlmConfig> = {}): LlmConfig =>
  LlmConfigSchema.parse({ provider: 'openai', model: 'deepseek-chat', ...overrides });

/** 一份合法的 LLM 诊断输出 */
function validFinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'LONG_MAIN_THREAD_TASK',
    title: '第三方 SDK 加载期间出现 320ms 长任务',
    severity: 62,
    impact: { TBT: 270 },
    attribution: {
      level: 'resource',
      url: 'https://cdn.example.com/sdk.js',
      size: 240_000,
      contentType: 'application/javascript',
    },
    evidence: [
      {
        kind: 'trace-event',
        payload: { durationMs: 320 },
        description: 'trace 里最长任务 320ms，其 topFrame 指向 sdk.js',
      },
    ],
    confidence: 0.7,
    ...overrides,
  };
}

function diagnoseInput(overrides: Partial<LlmDiagnoseInput> = {}): LlmDiagnoseInput {
  return {
    runId: 'run_1',
    project: 'demo',
    route: '/',
    device: 'mobile',
    evidence: {
      metrics: [
        { name: 'TBT', value: 420, unit: 'ms', rating: 'needs-improvement', score: 70 },
      ],
      deltas: [{ name: 'TBT', delta: -80, scoreDelta: -10 }],
      sources: { trace: { longTasks: [{ durationMs: 320 }] } },
    },
    ruleFindings: [],
    ...overrides,
  };
}

/**
 * 构造一个返回固定文本的假 SDK 加载器。
 *
 * 返回的**就是那个 loader 函数**（并把调用计数挂在它身上），而不是一个
 * `{ loadSdk }` 包装对象 —— 后者在传参时很容易漏写 `.loadSdk`
 * （这个测试文件第一版就是这么错的：所有用例都静默降级为空实现，
 * 断言全线失败却看不出原因）。
 */
function sdkReturning(
  text: string,
  usage: Record<string, number> = { promptTokens: 1000, completionTokens: 200, totalTokens: 1200 },
) {
  let calls = 0;
  const loader = async () => ({
    generateText: async () => {
      calls += 1;
      return { text, usage };
    },
    model: () => ({}),
  });

  return Object.assign(loader, { calls: () => calls });
}

describe('诊断 agent — 输出校验与盖章', () => {
  it('合法结论被采纳，并由我们盖上 id / runId / source', async () => {
    const llm = createLlmGateway({
      config: config(),
      logger: silent,
      loadSdk: sdkReturning(JSON.stringify([validFinding()])),
    });

    const output: LlmDiagnoseOutput = await llm.diagnose(diagnoseInput(), silent);

    expect(output.findings).toHaveLength(1);
    const finding = output.findings[0];
    // id 由我们生成：LLM 编的 id 不该被采信
    expect(finding?.bottleneck.id).toContain('bn_llm_run_1');
    expect(finding?.bottleneck.runId).toBe('run_1');
    // 来源盖成 llm —— 报告要靠它把两种结论分开摆
    expect(finding?.bottleneck.source).toBe('llm');
    expect(finding?.bottleneck.occurrences).toBe(1);
    expect(output.promptVersion).toBe(DIAGNOSE_PROMPT_VERSION);
  });

  it('置信度被压到上限 0.75（它自称 0.99 也不认）', async () => {
    const llm = createLlmGateway({
      config: config(),
      logger: silent,
      loadSdk: sdkReturning(JSON.stringify([validFinding({ confidence: 0.99 })])),
    });

    const output = await llm.diagnose(diagnoseInput(), silent);
    expect(output.findings[0]?.bottleneck.confidence).toBe(0.75);
  });

  it('**没有证据的结论一律丢弃** —— 这是这一层最重要的闸门', async () => {
    const llm = createLlmGateway({
      config: config(),
      logger: silent,
      loadSdk: sdkReturning(JSON.stringify([validFinding({ evidence: [] })])),
    });

    const output = await llm.diagnose(diagnoseInput(), silent);
    expect(output.findings).toEqual([]);
  });

  it('自造瓶颈种类被丢弃（kind 是枚举）', async () => {
    const llm = createLlmGateway({
      config: config(),
      logger: silent,
      loadSdk: sdkReturning(JSON.stringify([validFinding({ kind: 'SLOW_FONTS' })])),
    });

    const output = await llm.diagnose(diagnoseInput(), silent);
    expect(output.findings).toEqual([]);
  });

  it('归因结构不对被丢弃（resource 必须带 url）', async () => {
    const llm = createLlmGateway({
      config: config(),
      logger: silent,
      loadSdk: sdkReturning(
        JSON.stringify([validFinding({ attribution: { level: 'resource', size: 1, contentType: 'x' } })]),
      ),
    });

    const output = await llm.diagnose(diagnoseInput(), silent);
    expect(output.findings).toEqual([]);
  });

  it('refines 原样带出，交给合并层决定怎么用', async () => {
    const llm = createLlmGateway({
      config: config(),
      logger: silent,
      loadSdk: sdkReturning(JSON.stringify([validFinding({ refines: 'bn_1' })])),
    });

    const output = await llm.diagnose(diagnoseInput(), silent);
    expect(output.findings[0]?.refines).toBe('bn_1');
  });

  it('不是 JSON 就返回空，不中断链路', async () => {
    const llm = createLlmGateway({
      config: config(),
      logger: silent,
      loadSdk: sdkReturning('我觉得这个页面挺慢的，建议优化一下。'),
    });

    const output = await llm.diagnose(diagnoseInput(), silent);
    expect(output.findings).toEqual([]);
  });

  it('多条里坏一条只丢那一条', async () => {
    const llm = createLlmGateway({
      config: config(),
      logger: silent,
      loadSdk: sdkReturning(JSON.stringify([validFinding(), { kind: 'NOPE' }, validFinding()])),
    });

    const output = await llm.diagnose(diagnoseInput(), silent);
    expect(output.findings).toHaveLength(2);
  });
});

describe('诊断 agent — prompt 里有什么', () => {
  it('带上规则结论（让它复核而不是重复）与来源摘要', () => {
    const prompt = renderDiagnosePrompt(
      diagnoseInput({
        ruleFindings: [
          {
            id: 'bn_1',
            runId: 'run_1',
            kind: 'LARGE_JS_BUNDLE',
            title: 'index.js 达 676KB',
            severity: 47,
            impact: { JS_SIZE: 436_506 },
            attribution: {
              level: 'resource',
              url: 'assets/index.js',
              size: 692_506,
              contentType: 'application/javascript',
            },
            evidence: [],
            confidence: 0.9,
            occurrences: 1,
            source: 'rule',
          },
        ],
      }),
    );

    expect(prompt).toContain('ruleFindings');
    expect(prompt).toContain('bn_1');
    expect(prompt).toContain('assets/index.js');
    // 证据摘要在里面：这是 LLM 能看出规则看不出的东西的唯一依据
    expect(prompt).toContain('longTasks');
  });
});

describe('诊断 agent — 累计预算', () => {
  it('上一次调用就快把预算花光时，下一次直接不发', async () => {
    // 每次调用花 $1，上限 $1.5：第一次放行，第二次必须被挡住
    const sdk = sdkReturning(JSON.stringify([validFinding()]), {
      promptTokens: 2_000_000,
      completionTokens: 0,
      totalTokens: 2_000_000,
    });

    const llm = createLlmGateway({
      config: config({ maxCostUsd: 1.5 }),
      logger: silent,
      loadSdk: sdk,
    });

    const first = await llm.diagnose(diagnoseInput(), silent);
    expect(first.cost.usd).toBeCloseTo(1, 2);

    const second = await llm.diagnose(diagnoseInput(), silent);
    // 被预算挡住：没有输出，也没有再花钱
    expect(second.findings).toEqual([]);
    expect(second.cost.usd).toBe(0);
    expect(sdk.calls()).toBe(1);
  });

  it('诊断与方案生成共享同一份预算（否则每处都不超、合起来超）', async () => {
    const sdk = sdkReturning(JSON.stringify([]), {
      promptTokens: 2_000_000,
      completionTokens: 0,
      totalTokens: 2_000_000,
    });

    const llm = createLlmGateway({
      config: config({ maxCostUsd: 1.5 }),
      logger: silent,
      loadSdk: sdk,
    });

    await llm.diagnose(diagnoseInput(), silent);
    await llm.plan(
      {
        diagnosis: {
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
        },
        bottlenecks: [],
        runId: 'run_1',
        project: 'demo',
        route: '/',
      },
      silent,
    );

    expect(sdk.calls()).toBe(1);
  });
});
