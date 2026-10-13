import { describe, expect, it } from 'vitest';
import {
  CandidateSchema,
  createNullLlm,
  type Bottleneck,
  type BottleneckKind,
  type Candidate,
  type Diagnosis,
  type LlmDiagnoseInput,
  type LlmDiagnoseOutput,
  type LlmPlanInput,
  type LlmPlanOutput,
  type LlmPort,
  type LoggerPort,
} from '@yuki-byte18/shared';
import { Planner } from './index.js';
import { BUILTIN_PLANNER_RULES, PLANNER_RULE_SET_VERSION } from './rules/index.js';
import { addPreloadRule } from './rules/network.js';
import { largeBundleSplitRule } from './rules/dependencies.js';
import { createSilentLogger, createMemoryLogger } from '../logger/index.js';
import { configFixture } from '../fixtures/index.js';

/**
 * M3 验收测试。
 *
 * 六条验收标准逐条覆盖：
 * 1. 每个可修瓶颈至少 1 个候选；不可修瓶颈不产出
 * 2. 候选同时来自规则库与 LLM，每个都有 bottleneckIds 回链
 * 3. 每个候选带 class / expectedGain / confidence / risk / reversible
 * 4. LLM 输出 schema 校验失败 → 自动降级为仅规则库，链路不中断
 * 5. promptVersion 写入候选
 * 6. 成本记账，超 maxCostUsd 时停止并告警
 */

const silent = createSilentLogger();

// ─────────────────────────────────────────────────────────────────────
// 构造瓶颈与诊断
// ─────────────────────────────────────────────────────────────────────

let seq = 0;
function bottleneck(overrides: Partial<Bottleneck> = {}): Bottleneck {
  seq += 1;
  return {
    id: `bn_test${seq}`,
    runId: 'run_1',
    kind: 'OVERSIZED_IMAGE',
    title: '图片过大',
    severity: 70,
    impact: { IMAGE_SIZE: 900_000, TRANSFER_SIZE: 900_000 },
    attribution: {
      level: 'resource',
      url: 'https://staging.example.com/assets/hero.png',
      size: 1_200_000,
      contentType: 'image/png',
    },
    evidence: [],
    confidence: 0.9,
    occurrences: 1,
    ...overrides,
    // 放在 overrides 之后：`Partial<Bottleneck>` 的展开会让 source 变成可选，
    // 而这个是必填字段（LLM 结论走另一条路，由 core/llm 盖章）
    source: overrides.source ?? 'rule',
  };
}

function diagnosis(bottlenecks: Bottleneck[]): Diagnosis {
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
    bottlenecks,
    summary: '',
    ruleSetVersion: 'm2.1.0',
    createdAt: '2026-01-17T14:25:30.000Z',
  };
}

function planInput(bottlenecks: Bottleneck[]) {
  return {
    planId: 'plan_1',
    runId: 'run_1',
    project: 'demo',
    route: '/',
    diagnosis: diagnosis(bottlenecks),
    createdAt: '2026-01-17T14:25:30.000Z',
  };
}

function planner(overrides: Partial<ConstructorParameters<typeof Planner>[0]> = {}): Planner {
  return new Planner({
    // 配置里必须有 provider：没配 LLM 时**一次调用都不该发生**（花钱的事默认关着）。
    // 这里显式配上，是因为这一组用例注入的就是 LLM 替身 —— 想验它被调用。
    config: configFixture({ llm: { provider: 'openai', model: 'test-model', maxCostUsd: 2 } }),
    llm: createNullLlm(),
    memory: null,
    logger: silent,
    ...overrides,
  });
}

/**
 * 可编程的 LLM 替身。
 *
 * `diagnose` 默认返回空：这一组测的是**方案生成**，诊断 agent 的测试在
 * `diagnoser/diagnoser.test.ts`。但端口上两个方法都是必填的 ——
 * 一个"只要 plan 就行"的替身会让"诊断 agent 忘了接"这种疏漏编译不过。
 */
function mockLlm(
  impl: (input: LlmPlanInput, logger: LoggerPort) => Promise<LlmPlanOutput>,
  diagnoseImpl?: (input: LlmDiagnoseInput, logger: LoggerPort) => Promise<LlmDiagnoseOutput>,
): LlmPort {
  return {
    plan: impl,
    diagnose:
      diagnoseImpl ??
      (async () => ({
        findings: [],
        cost: { inputTokens: 0, outputTokens: 0, totalTokens: 0, usd: 0 },
        promptVersion: 'none',
      })),
  };
}

/** 造一个合法的 LLM 候选（对应某个瓶颈） */
function llmCandidateFor(target: Bottleneck, overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: `cand_llm_${target.id}`,
    runId: 'run_1',
    bottleneckIds: [target.id],
    class: 'B',
    title: 'LLM 建议：拆分该组件',
    description: '把大组件拆成按需加载的子组件',
    origin: 'llm',
    ruleId: null,
    promptVersion: 'm3.0.0',
    changes: [{ type: 'ast', file: 'src/App.tsx', node: 'component', description: '拆分' }],
    expectedGain: { LCP: 300 },
    confidence: 0.6,
    risk: 'medium',
    effort: 'medium',
    reversible: true,
    recalledFrom: [],
    bottleneckKinds: [target.kind],
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────
// 验收 1：可修瓶颈有候选，不可修瓶颈不产出
// ─────────────────────────────────────────────────────────────────────

describe('M3 验收 1 — 规则库覆盖', () => {
  it('每条内置规则都声明了它处理的 kind 与说明', () => {
    expect(BUILTIN_PLANNER_RULES.length).toBeGreaterThanOrEqual(8);
    expect(BUILTIN_PLANNER_RULES.every((r) => r.id.length > 0)).toBe(true);
    expect(BUILTIN_PLANNER_RULES.every((r) => r.description.length > 0)).toBe(true);
    const ids = BUILTIN_PLANNER_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('诊断器能产出的每一种瓶颈，规划器都有对应规则', async () => {
    // 这些是 core/diagnoser 目前真正会产出的 kind。
    // 遗漏任何一个都意味着「诊断出了瓶颈却给不出建议」——
    // 那正是 M3 要消灭的情况。
    const diagnosableKinds: BottleneckKind[] = [
      'OVERSIZED_IMAGE',
      'UNCOMPRESSED_IMAGE',
      'RENDER_BLOCKING_RESOURCE',
      'NO_COMPRESSION',
      'EXCESSIVE_REQUESTS',
      'CACHE_MISS',
      'MISSING_PRELOAD',
      'LARGE_JS_BUNDLE',
      'DUPLICATE_DEPENDENCY',
      'LEGACY_LIBRARY',
      'NO_CODE_SPLITTING',
      'LONG_MAIN_THREAD_TASK',
      'CLS_SHIFT_SOURCE',
    ];

    const covered = new Set(BUILTIN_PLANNER_RULES.map((r) => r.kind));
    const missing = diagnosableKinds.filter((k) => !covered.has(k));
    expect(missing).toEqual([]);
  });

  it('字型闪烁与字体阻塞共用同一条修复（font-display: swap）', () => {
    const covered = new Set(BUILTIN_PLANNER_RULES.map((r) => r.kind));
    expect(covered.has('WEBFONT_BLOCKING')).toBe(true);
    expect(covered.has('FONT_FLASH')).toBe(true);
  });

  it('每个可修瓶颈都产出至少一个候选', async () => {
    const cases: Array<[BottleneckKind, Partial<Bottleneck>]> = [
      ['OVERSIZED_IMAGE', {}],
      ['UNCOMPRESSED_IMAGE', {}],
      ['NO_COMPRESSION', { attribution: { level: 'resource', url: 'https://a/x.js', size: 1, contentType: 'application/javascript' } }],
      ['CACHE_MISS', { attribution: { level: 'resource', url: 'https://a/x.js', size: 1, contentType: 'application/javascript' } }],
      ['LARGE_JS_BUNDLE', { attribution: { level: 'resource', url: 'assets/index.js', size: 600_000, contentType: 'application/javascript' } }],
      ['DUPLICATE_DEPENDENCY', { attribution: { level: 'dependency', name: 'lodash', version: null, size: 71_000 } }],
      ['LEGACY_LIBRARY', { attribution: { level: 'dependency', name: 'moment', version: null, size: 288_000 } }],
      ['LONG_MAIN_THREAD_TASK', { attribution: { level: 'source', file: 'src/List.tsx', line: 88, column: 4, component: 'renderList' } }],
      ['CLS_SHIFT_SOURCE', { attribution: { level: 'component', name: 'img.hero', file: null, line: null, renderCount: null } }],
    ];

    for (const [kind, overrides] of cases) {
      const target = bottleneck({ kind, ...overrides });
      const outcome = await planner().plan(planInput([target]));
      expect(outcome.candidates.length, `${kind} 应该产出候选`).toBeGreaterThanOrEqual(1);
    }
  });

  it('不可修的瓶颈不产出候选（归因拿不到可操作主体）', async () => {
    // RENDER_BLOCKING_RESOURCE 的规则要求归因到具体资源；
    // 归因只到 component（没有 URL）时无从下手，应当不产出。
    const target = bottleneck({
      kind: 'RENDER_BLOCKING_RESOURCE',
      attribution: { level: 'component', name: 'unknown', file: null, line: null, renderCount: null },
    });

    const outcome = await planner().plan(planInput([target]));
    expect(outcome.candidates).toEqual([]);
  });

  it('规则存在但产不出候选的瓶颈，会被列入 unmatchedKinds（从而交给 LLM）', async () => {
    // UNUSED_DEPENDENCY 有规则，但那条规则要求归因到 dependency；
    // 这里给一个 resource 归因，规则会拒绝产出。
    // `unmatchedKinds` 的语义正是「没产出任何候选的 kind」，
    // 它同时驱动 LLM 补充逻辑 —— 所以必须如实反映「没建议」而不是「没规则」。
    const unsuitable = bottleneck({ kind: 'UNUSED_DEPENDENCY' });
    const covered = bottleneck({ kind: 'OVERSIZED_IMAGE' });

    const outcome = await planner().plan(planInput([unsuitable, covered]));

    expect(outcome.unmatchedKinds).toEqual(['UNUSED_DEPENDENCY']);
    expect(outcome.candidates.some((c) => c.bottleneckKinds.includes('OVERSIZED_IMAGE'))).toBe(true);
  });

  it('全部 kind 都产出候选时 unmatchedKinds 为空', async () => {
    const outcome = await planner().plan(
      planInput([
        bottleneck({ kind: 'OVERSIZED_IMAGE' }),
        bottleneck({
          kind: 'LEGACY_LIBRARY',
          attribution: { level: 'dependency', name: 'moment', version: null, size: 288_000 },
        }),
      ]),
    );

    expect(outcome.unmatchedKinds).toEqual([]);
  });

  it('空诊断产出空候选，不抛错', async () => {
    const outcome = await planner().plan(planInput([]));
    expect(outcome.candidates).toEqual([]);
    expect(outcome.ruleSetVersion).toBe(PLANNER_RULE_SET_VERSION);
  });

  it('一条规则抛异常不影响其它规则产出', async () => {
    const broken = {
      id: 'broken',
      kind: 'OVERSIZED_IMAGE' as const,
      description: '故意抛异常',
      plan() {
        throw new Error('规则写崩了');
      },
    };

    const outcome = await planner({ rules: [broken, ...BUILTIN_PLANNER_RULES] }).plan(
      planInput([bottleneck()]),
    );

    // broken 挂了，但内置的 compress/convert 规则仍然产出
    expect(outcome.candidates.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 验收 2：来源与回链
// ─────────────────────────────────────────────────────────────────────

describe('M3 验收 2 — 候选来源与回链', () => {
  it('每个候选都回链到至少一个瓶颈，且 kind 与瓶颈一致', async () => {
    const targets = [
      bottleneck({ kind: 'OVERSIZED_IMAGE' }),
      bottleneck({ kind: 'LARGE_JS_BUNDLE' }),
      bottleneck({ kind: 'CLS_SHIFT_SOURCE', attribution: { level: 'component', name: 'img', file: null, line: null, renderCount: null } }),
    ];

    const outcome = await planner().plan(planInput(targets));
    expect(outcome.candidates.length).toBeGreaterThan(0);

    const ids = new Set(targets.map((t) => t.id));
    for (const candidate of outcome.candidates) {
      expect(candidate.bottleneckIds.length, candidate.title).toBeGreaterThanOrEqual(1);
      // 回链必须指向本次的瓶颈，不能是编造的 id
      for (const id of candidate.bottleneckIds) expect(ids.has(id), `${candidate.title} 回链 ${id}`).toBe(true);
      expect(candidate.bottleneckKinds.every((k) => targets.some((t) => t.kind === k))).toBe(true);
    }
  });

  it('规则库覆盖不到的瓶颈，交给 LLM 补充（验收 2 的「同时来自两处」）', async () => {
    // 用一个没有规划规则的 kind 模拟「规则库覆盖不到」
    const orphan = bottleneck({ kind: 'MISSING_DIMENSIONS' });
    const noRule = { ...orphan, kind: 'UNUSED_DEPENDENCY' as const };

    const llm = mockLlm(async (input) => ({
      candidates: input.bottlenecks.map((b) => llmCandidateFor(b)),
      cost: { inputTokens: 100, outputTokens: 50, totalTokens: 150, usd: 0.001 },
      promptVersion: 'm3.0.0',
    }));

    const outcome = await planner({ llm }).plan(planInput([noRule]));

    expect(outcome.candidates.some((c) => c.origin === 'llm')).toBe(true);
    expect(outcome.llmCostUsd).toBeGreaterThan(0);
  });

  /**
   * `llm.plan_mode` 的两种行为（第二轮新增）。
   *
   * 默认 `always`：LLM 的价值不只在"补规则的空"，同一个瓶颈它常能给出规则
   * 写不出的更具体方案。`fallback` 保留 M3 的旧行为（只在规则弃权时才问，
   * 省 token）。
   */
  it('plan_mode=always：规则已覆盖的瓶颈照样问 LLM', async () => {
    let called = false;
    let passedExisting = 0;
    const llm = mockLlm(async (input) => {
      called = true;
      passedExisting = input.existingCandidates?.length ?? 0;
      return {
        candidates: [],
        cost: { inputTokens: 0, outputTokens: 0, totalTokens: 0, usd: 0 },
        promptVersion: 'm3.1.0',
      };
    });

    await planner({ llm }).plan(planInput([bottleneck({ kind: 'OVERSIZED_IMAGE' })]));

    expect(called).toBe(true);
    // 规则候选要一并告知 LLM，否则它会换个说法重复提一遍（然后被去重丢掉）
    expect(passedExisting).toBeGreaterThan(0);
  });

  it('plan_mode=fallback：规则覆盖了就完全不问（省 token）', async () => {
    let called = false;
    const llm = mockLlm(async () => {
      called = true;
      return {
        candidates: [],
        cost: { inputTokens: 0, outputTokens: 0, totalTokens: 0, usd: 0 },
        promptVersion: 'm3.1.0',
      };
    });

    await planner({
      llm,
      config: configFixture({
        llm: { provider: 'openai', model: 'test-model', plan_mode: 'fallback' },
      }),
    }).plan(planInput([bottleneck({ kind: 'OVERSIZED_IMAGE' })]));

    expect(called).toBe(false);
  });

  it('LLM 候选必须带 promptVersion（可追溯）', async () => {
    const llm = mockLlm(async (input) => ({
      candidates: input.bottlenecks.map((b) => llmCandidateFor(b, { promptVersion: 'm3.0.0' })),
      cost: { inputTokens: 10, outputTokens: 10, totalTokens: 20, usd: 0.0001 },
      promptVersion: 'm3.0.0',
    }));

    const outcome = await planner({ llm }).plan(
      planInput([bottleneck({ kind: 'UNUSED_DEPENDENCY' })]),
    );
    const fromLlm = outcome.candidates.filter((c) => c.origin === 'llm');

    expect(fromLlm.length).toBeGreaterThan(0);
    expect(fromLlm.every((c) => c.promptVersion !== null)).toBe(true);
  });

  it('provider=none 时不产出 LLM 候选，也不报错', async () => {
    const outcome = await planner({ llm: createNullLlm() }).plan(
      planInput([bottleneck({ kind: 'OVERSIZED_IMAGE' })]),
    );

    expect(outcome.llmCostUsd).toBe(0);
    expect(outcome.candidates.every((c) => c.origin === 'rule')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 验收 3：候选字段完整
// ─────────────────────────────────────────────────────────────────────

describe('M3 验收 3 — 候选字段完整性', () => {
  it('每个候选都带 class / expectedGain / confidence / risk / reversible，且能过 schema', async () => {
    const targets = [
      bottleneck({ kind: 'OVERSIZED_IMAGE' }),
      bottleneck({ kind: 'UNCOMPRESSED_IMAGE' }),
      bottleneck({ kind: 'LARGE_JS_BUNDLE' }),
      bottleneck({ kind: 'LEGACY_LIBRARY', attribution: { level: 'dependency', name: 'moment', version: null, size: 288_000 } }),
      bottleneck({ kind: 'LONG_MAIN_THREAD_TASK', attribution: { level: 'source', file: 'src/a.tsx', line: 1, column: 0, component: null } }),
    ];

    const outcome = await planner().plan(planInput(targets));
    expect(outcome.candidates.length).toBeGreaterThan(0);

    for (const candidate of outcome.candidates) {
      expect(['A', 'B', 'C'], candidate.title).toContain(candidate.class);
      expect(candidate.confidence, candidate.title).toBeGreaterThan(0);
      expect(candidate.confidence, candidate.title).toBeLessThanOrEqual(1);
      expect(['low', 'medium', 'high'], candidate.title).toContain(candidate.risk);
      expect(typeof candidate.reversible, candidate.title).toBe('boolean');
      expect(candidate.expectedGain, candidate.title).toBeTypeOf('object');
      expect(candidate.changes.length, candidate.title).toBeGreaterThanOrEqual(1);

      const parsed = CandidateSchema.safeParse(candidate);
      if (!parsed.success) {
        throw new Error(`${candidate.title} schema 校验失败: ${JSON.stringify(parsed.error.issues)}`);
      }
    }
  });

  it('规则命中的置信度统一 0.9（确定性来源，但仍非 1.0）', async () => {
    const outcome = await planner().plan(planInput([bottleneck({ kind: 'OVERSIZED_IMAGE' })]));
    expect(outcome.candidates.every((c) => c.confidence === 0.9)).toBe(true);
  });

  it('不可逆的候选只能是 C 类（schema 硬约束）', async () => {
    const outcome = await planner().plan(
      planInput([bottleneck({ kind: 'CLS_SHIFT_SOURCE', attribution: { level: 'component', name: 'img', file: null, line: null, renderCount: null } })]),
    );

    for (const candidate of outcome.candidates) {
      if (!candidate.reversible) expect(candidate.class).toBe('C');
    }
  });

  it('A/B/C 三级都被规则库用到（分级不是纸上谈兵）', async () => {
    const targets = [
      bottleneck({ kind: 'OVERSIZED_IMAGE' }),
      bottleneck({ kind: 'NO_CODE_SPLITTING' }),
      bottleneck({ kind: 'CLS_SHIFT_SOURCE', attribution: { level: 'component', name: 'img', file: null, line: null, renderCount: null } }),
      bottleneck({ kind: 'LONG_MAIN_THREAD_TASK', attribution: { level: 'source', file: 'src/a.tsx', line: 1, column: 0, component: null } }),
      bottleneck({ kind: 'EXCESSIVE_REQUESTS' }),
    ];

    const outcome = await planner().plan(planInput(targets));
    const classes = new Set(outcome.candidates.map((c) => c.class));

    expect(classes.has('A')).toBe(true);
    expect(classes.has('B')).toBe(true);
    expect(classes.has('C')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 验收 4：LLM 降级
// ─────────────────────────────────────────────────────────────────────

describe('M3 验收 4 — LLM 失败自动降级', () => {
  it('LLM 抛异常时降级为仅规则库，规则候选照常产出', async () => {
    const logger = createMemoryLogger();
    const llm = mockLlm(async () => {
      throw new Error('上游 503');
    });

    const outcome = await planner({ llm, logger }).plan(
      planInput([
        bottleneck({ kind: 'OVERSIZED_IMAGE' }),
        bottleneck({ kind: 'UNUSED_DEPENDENCY' }),
      ]),
    );

    // 规则候选还在
    expect(outcome.candidates.some((c) => c.origin === 'rule')).toBe(true);
    expect(logger.entries.some((e) => e.level === 'warn')).toBe(true);
  });

  it('LLM 返回空候选时不影响规则候选', async () => {
    const llm = mockLlm(async () => ({
      candidates: [],
      cost: { inputTokens: 0, outputTokens: 0, totalTokens: 0, usd: 0 },
      promptVersion: 'm3.0.0',
    }));

    const outcome = await planner({ llm }).plan(planInput([bottleneck({ kind: 'OVERSIZED_IMAGE' })]));
    expect(outcome.candidates.length).toBeGreaterThan(0);
    expect(outcome.candidates.every((c) => c.origin === 'rule')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 验收 6：成本记账
// ─────────────────────────────────────────────────────────────────────

describe('M3 验收 6 — LLM 成本记账', () => {
  it('成本汇总到 PlanOutcome', async () => {
    const llm = mockLlm(async (input) => ({
      candidates: input.bottlenecks.map((b) => llmCandidateFor(b)),
      cost: { inputTokens: 800, outputTokens: 400, totalTokens: 1_200, usd: 0.0234 },
      promptVersion: 'm3.0.0',
    }));

    const outcome = await planner({ llm }).plan(
      planInput([bottleneck({ kind: 'UNUSED_DEPENDENCY' })]),
    );
    expect(outcome.llmCostUsd).toBeCloseTo(0.0234, 4);
  });

  it('超预算的 LLM 实现返回 0 成本与空候选时，链路照常产出规则候选', async () => {
    // core/llm 在成本超限时会返回空候选 + 实际成本；
    // planner 侧只要能继续走规则库即可（成本策略属于 core/llm 的职责）
    const llm = mockLlm(async () => ({
      candidates: [],
      cost: { inputTokens: 5_000, outputTokens: 2_000, totalTokens: 7_000, usd: 9.99 },
      promptVersion: 'm3.0.0',
    }));

    const outcome = await planner({ llm }).plan(
      planInput([
        bottleneck({ kind: 'OVERSIZED_IMAGE' }),
        bottleneck({ kind: 'UNUSED_DEPENDENCY' }),
      ]),
    );

    expect(outcome.llmCostUsd).toBeCloseTo(9.99, 2);
    expect(outcome.candidates.some((c) => c.origin === 'rule')).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 去重与确定性
// ─────────────────────────────────────────────────────────────────────

describe('Planner — 去重与确定性', () => {
  it('同一瓶颈的同类改动被合并，保留置信度更高的', async () => {
    const target = bottleneck({ kind: 'OVERSIZED_IMAGE' });
    const outcome = await planner().plan(planInput([target]));

    const byChangeType = new Map<string, number>();
    for (const candidate of outcome.candidates) {
      const key = `${[...candidate.bottleneckIds].sort().join(',')}|${candidate.changes.map((c) => c.type).sort().join(',')}`;
      byChangeType.set(key, (byChangeType.get(key) ?? 0) + 1);
    }

    expect([...byChangeType.values()].every((n) => n === 1)).toBe(true);
  });

  it('候选按置信度降序排列', async () => {
    const outcome = await planner().plan(
      planInput([bottleneck({ kind: 'OVERSIZED_IMAGE' }), bottleneck({ kind: 'LARGE_JS_BUNDLE' })]),
    );

    const confidences = outcome.candidates.map((c) => c.confidence);
    for (let i = 1; i < confidences.length; i += 1) {
      expect(confidences[i - 1]).toBeGreaterThanOrEqual(confidences[i] as number);
    }
  });

  it('同一份输入产出完全相同的候选（快照稳定）', async () => {
    // 瓶颈只造一次并复用：候选 id 由瓶颈 id 派生，
    // 每次重新构造瓶颈会拿到不同的 id，那样比的就不是「同一份输入」了。
    const targets = [
      bottleneck({ kind: 'OVERSIZED_IMAGE' }),
      bottleneck({
        kind: 'NO_COMPRESSION',
        attribution: { level: 'resource', url: 'https://a/x.js', size: 1, contentType: 'application/javascript' },
      }),
    ];
    const input = planInput(targets);

    const a = await planner().plan(input);
    const b = await planner().plan(input);
    expect(JSON.stringify(a.candidates)).toBe(JSON.stringify(b.candidates));
  });
});

/**
 * 规则库的"诚实性"约束。
 *
 * 这一组防的不是崩溃，而是**报告说假话**：预期收益抄自瓶颈的 severity、
 * 预加载提示的资源类型写死、配置里引用项目根本没有的包。
 * 这类问题不会让任何测试变红，只会让用户照着做完发现数字一动不动。
 */
describe('规则库 — 不编造收益与资源类型', () => {
  const ruleCtx = { runId: 'run_1', project: 'demo', route: '/', bottlenecks: [] };

  function resourceBottleneck(kind: BottleneckKind, url: string, contentType: string): Bottleneck {
    return bottleneck({ kind, attribution: { level: 'resource', url, size: 1000, contentType } });
  }

  /** 取 config 改动要插入的那段文本（change.after 对 config 类就是字面量/片段） */
  function afterOf(candidate: Candidate | undefined): string {
    const change = candidate?.changes[0];
    return change !== undefined && change.type === 'config' ? String(change.after) : '';
  }

  it('add-preload：as 按资源真实类型给，不再一律 fetch', () => {
    const cases: Array<[string, string, string]> = [
      ['assets/index-abc.js', 'application/javascript', 'as="script"'],
      ['assets/app.css', 'text/css', 'as="style"'],
      ['assets/hero.png', 'image/png', 'as="image"'],
      // 字体必须带 crossorigin：否则浏览器当成另一个请求，预加载那份用不上
      ['assets/font.woff2', 'font/woff2', 'as="font" crossorigin'],
    ];

    for (const [url, contentType, expected] of cases) {
      const candidates = addPreloadRule.plan(resourceBottleneck('MISSING_PRELOAD', url, contentType), ruleCtx);
      expect(candidates).toHaveLength(1);
      expect(afterOf(candidates[0])).toContain(expected);
    }
  });

  it('add-preload：类型判断不出来时不发候选（猜错比不做更慢）', () => {
    const unknown = resourceBottleneck('MISSING_PRELOAD', 'https://api.example.com/thing', 'application/octet-stream');
    expect(addPreloadRule.plan(unknown, ruleCtx)).toEqual([]);

    // contentType 缺失时按扩展名兜底，认得出来就照常给
    const byExtension = resourceBottleneck('MISSING_PRELOAD', '/assets/chunk-1.js', '');
    expect(addPreloadRule.plan(byExtension, ruleCtx)).toHaveLength(1);
  });

  it('manualChunks 只出建议：不承诺收益，也不再编造包名', () => {
    const target = resourceBottleneck('LARGE_JS_BUNDLE', 'assets/index-abc.js', 'application/javascript');
    const [candidate] = largeBundleSplitRule.plan(target, ruleCtx);

    // C 类 = 只出建议，不产出 patch（decision 层的 routeFor 会把它路由到 manual）
    expect(candidate?.class).toBe('C');
    // 拆 chunk 不改变总字节数：填任何数字都是编造
    expect(candidate?.expectedGain).toEqual({});
    // 规划阶段拿不到项目的依赖清单，写死 react/lodash 会在 Vue 项目上写出无效配置
    const serialized = JSON.stringify(candidate?.changes);
    expect(serialized).not.toContain('react');
    expect(serialized).not.toContain('lodash');
    // 关键限制必须写在标题里：报告的方案表只渲染标题，不渲染 description
    expect(candidate?.title).toContain('不减总大小');
  });
});
