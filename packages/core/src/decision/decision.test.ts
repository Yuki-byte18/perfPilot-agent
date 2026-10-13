import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DecisionSchema,
  TOOL_ROUTES,
  type Candidate,
  type OptimizationClass,
  type PlannedChange,
} from '@yuki-byte18/shared';
import { DecisionEngine, riskLevelOf } from './index.js';
import {
  DEFAULT_METRIC_WEIGHTS,
  computeCost,
  computeExpectedGain,
  computeRisk,
  computeUtility,
  normalizeGain,
} from './utility.js';
import { ROUTE_TABLE, routeFor } from './routing.js';
import { checkAllowlist, grade } from './grading.js';
import { createSilentLogger } from '../logger/index.js';
import { configFixture } from '../fixtures/index.js';

/**
 * M4 验收测试（Jev 决策层）。
 *
 * 六条验收标准逐条覆盖：
 * 1. 纯函数：同输入同输出
 * 2. utility 四项分量各自可测 + 权重边界
 * 3. 工具路由表覆盖 5 种 ToolRoute
 * 4. A/B/C ↔ apply/confirm/suggest 映射，阈值来自配置
 * 5. 决策路径不含 LLM（依赖图断言）
 * 6. thresholds 快照写入 Decision
 */

const silent = createSilentLogger();

// ─────────────────────────────────────────────────────────────────────
// 构造候选
// ─────────────────────────────────────────────────────────────────────

let seq = 0;
function candidate(overrides: Partial<Candidate> = {}): Candidate {
  seq += 1;
  return {
    id: `cand_${seq}`,
    runId: 'run_1',
    bottleneckIds: ['bn_1'],
    class: 'A',
    title: '压缩图片',
    description: '转 WebP',
    origin: 'rule',
    ruleId: 'compress',
    promptVersion: null,
    changes: [
      { type: 'asset', file: 'assets/hero.png', operation: 'convert-webp', params: {} },
    ],
    expectedGain: { IMAGE_SIZE: 200_000 },
    confidence: 0.9,
    risk: 'low',
    effort: 'low',
    reversible: true,
    recalledFrom: [],
    bottleneckKinds: ['OVERSIZED_IMAGE'],
    ...overrides,
  };
}

const engine = (overrides: Parameters<typeof configFixture>[0] = {}) =>
  new DecisionEngine({ config: configFixture(overrides), logger: silent });

const decide = (candidates: Candidate[], overrides: Parameters<typeof configFixture>[0] = {}) =>
  engine(overrides).decide({ runId: 'run_1', candidates, createdAt: '2026-01-17T14:25:30.000Z' });

// ─────────────────────────────────────────────────────────────────────
// 验收 2：utility 四项分量
// ─────────────────────────────────────────────────────────────────────

describe('M4 验收 2 — utility 四项分量', () => {
  it('normalizeGain 用 (poor − good) 跨度归一化', () => {
    // LCP: good=2500 poor=4000，跨度 1500ms
    expect(normalizeGain('LCP', 750)).toBeCloseTo(50, 5);
    expect(normalizeGain('LCP', 1500)).toBeCloseTo(100, 5);
    // 超过跨度封顶 100
    expect(normalizeGain('LCP', 99_999)).toBe(100);
    // 负数 / 零 / 非有限值不给收益
    expect(normalizeGain('LCP', 0)).toBe(0);
    expect(normalizeGain('LCP', -100)).toBe(0);
    expect(normalizeGain('LCP', Number.NaN)).toBe(0);
  });

  it('跨度为零或写反时记 0，而不是给一个假的满分', () => {
    expect(normalizeGain('LCP', 500, { LCP: { warning: 3000, error: 3000 } })).toBe(0);
  });

  it('expectedGain 是所涉指标归一化收益的加权平均', () => {
    // 只碰 LCP：按 LCP 自身的完成度计分（省 750ms / 跨度 1500ms = 50），
    // 不被权重稀释 —— 权重用于跨候选排序，不是用来让单个候选缩水的。
    expect(computeExpectedGain({ expectedGain: { LCP: 750 } })).toBeCloseTo(50, 2);
    // TBT 默认权重 0，不参与加权
    expect(computeExpectedGain({ expectedGain: { TBT: 500 } })).toBe(0);
  });

  it('同时影响多个指标时被高权重那一项主导', () => {
    // LCP 完成度 50（权重 0.35）、IMAGE_SIZE 完成度 100（权重 0.04）
    // → (0.35×50 + 0.04×100) / 0.39 ≈ 55.1，靠近 LCP 而非被平均成 75
    const value = computeExpectedGain({ expectedGain: { LCP: 750, IMAGE_SIZE: 1_000_000 } });
    expect(value).toBeGreaterThan(50);
    expect(value).toBeLessThan(60);
  });

  it('权重可由配置覆盖（边界：权重 1 与权重 0）', () => {
    expect(computeExpectedGain({ expectedGain: { LCP: 1500 } }, { LCP: 1 })).toBeCloseTo(100, 2);
    expect(computeExpectedGain({ expectedGain: { LCP: 1500 } }, { LCP: 0 })).toBe(0);
  });

  it('默认权重之和为 1（保证 expectedGain 落在 0-100）', () => {
    const total = Object.values(DEFAULT_METRIC_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it('expectedGain 永不越界', () => {
    const huge = computeExpectedGain(
      { expectedGain: { LCP: 99_999, CLS: 99, INP: 99_999, JS_SIZE: 99_999_999 } },
      { LCP: 1, CLS: 1, INP: 1, JS_SIZE: 1 },
    );
    expect(huge).toBeLessThanOrEqual(100);
    expect(huge).toBeGreaterThanOrEqual(0);
  });

  it('cost 由改动面与 effort 决定，且不超过 100', () => {
    expect(computeCost(candidate({ effort: 'low' }))).toBe(3); // 1 文件 2 + low 1
    expect(computeCost(candidate({ effort: 'medium' }))).toBe(6);
    expect(computeCost(candidate({ effort: 'high' }))).toBe(10);

    const many = candidate({
      effort: 'high',
      changes: Array.from({ length: 20 }, (_, i) => ({
        type: 'ast' as const,
        file: `src/f${i}.tsx`,
        node: 'x',
        description: 'y',
      })),
    });
    expect(computeCost(many)).toBe(20); // 文件面上限 12 + high 8
  });

  it('cost 按去重后的文件数计（同一文件改两次不算两个文件）', () => {
    const twice = candidate({
      effort: 'low',
      changes: [
        { type: 'ast', file: 'src/a.tsx', node: 'x', description: 'y' },
        { type: 'ast', file: 'src/a.tsx', node: 'z', description: 'w' },
      ],
    });
    expect(computeCost(twice)).toBe(3);
  });

  it('risk 随分级与改动面上升，不可逆额外放大', () => {
    const low = computeRisk(candidate({ class: 'A' }));
    const mid = computeRisk(candidate({ class: 'B' }));
    const high = computeRisk(candidate({ class: 'C' }));

    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
    expect(computeRisk(candidate({ class: 'A', reversible: false }))).toBeGreaterThan(low);
  });

  it('utility = expectedGain × confidence − cost − λ × risk', () => {
    const c = candidate({ expectedGain: { LCP: 1500 }, confidence: 1, effort: 'low' });
    const { score, breakdown } = computeUtility({ candidate: c, riskAversion: 1 });

    expect(breakdown.expectedGain).toBeCloseTo(100, 2); // LCP 省满整个跨度
    expect(score).toBeCloseTo(100 - breakdown.cost - breakdown.risk, 2);
  });

  it('λ（风险厌恶）可调，且只影响 risk 项', () => {
    const c = candidate({ expectedGain: { LCP: 1500 }, confidence: 1, class: 'C' });
    const lenient = computeUtility({ candidate: c, riskAversion: 0 });
    const strict = computeUtility({ candidate: c, riskAversion: 1 });

    expect(lenient.breakdown).toEqual(strict.breakdown);
    expect(lenient.score).toBeGreaterThan(strict.score);
  });

  it('confidence 是乘数：置信度减半则收益减半', () => {
    // λ=0 消掉风险项，让差值纯粹反映 confidence 的乘数效应
    const full = computeUtility({
      candidate: candidate({ expectedGain: { LCP: 1500 }, confidence: 1 }),
      riskAversion: 0,
    });
    const half = computeUtility({
      candidate: candidate({ expectedGain: { LCP: 1500 }, confidence: 0.5 }),
      riskAversion: 0,
    });

    // 差值恰为「收益的一半」（cost/risk 相同，相减抵消）
    const expectedDelta = full.breakdown.expectedGain * 0.5;
    expect(full.score - half.score).toBeCloseTo(expectedDelta, 2);
  });

  it('零收益 + 有成本 → utility 为负（该拒绝）', () => {
    const c = candidate({ expectedGain: {}, confidence: 1, effort: 'high' });
    expect(computeUtility({ candidate: c }).score).toBeLessThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 验收 3：工具路由
// ─────────────────────────────────────────────────────────────────────

describe('M4 验收 3 — 工具路由表', () => {
  it('路由表覆盖 4 种改动类型 → 4 个执行器', () => {
    expect(ROUTE_TABLE).toHaveLength(4);
    expect(new Set(ROUTE_TABLE.map((r) => r.route))).toEqual(
      new Set(['ast-rewriter', 'asset-processor', 'config-editor', 'dependency-editor']),
    );
  });

  it('5 种 ToolRoute 全部可达（第 5 种 manual 由兜底规则产生）', () => {
    const reachable = new Set<string>(ROUTE_TABLE.map((r) => r.route));

    reachable.add(routeFor(candidate({ class: 'C' })).route);
    expect(new Set(reachable)).toEqual(new Set(TOOL_ROUTES));
  });

  /** 每种改动类型造一个合法的 PlannedChange —— 用真实的形状，不用类型断言糊过去 */
  const changeOf = (type: PlannedChange['type']): PlannedChange => {
    switch (type) {
      case 'ast':
        return { type, file: 'src/a.tsx', node: 'component', description: '拆分' };
      case 'asset':
        return { type, file: 'assets/a.png', operation: 'convert-webp', params: {} };
      case 'config':
        return { type, file: 'vite.config.ts', key: 'build.target', before: null, after: 'es2020' };
      case 'dependency':
        return { type, remove: ['lodash'], reason: '未使用' };
    }
  };

  it.each([
    ['ast', 'ast-rewriter'],
    ['asset', 'asset-processor'],
    ['config', 'config-editor'],
    ['dependency', 'dependency-editor'],
  ] as const)('改动类型 %s → %s', (type, route) => {
    const built = candidate({ changes: [changeOf(type)] });
    expect(routeFor(built).route).toBe(route);
  });

  it('C 类一律 manual（仅建议，不产出 patch）', () => {
    const decision = routeFor(candidate({ class: 'C' }));
    expect(decision.route).toBe('manual');
    expect(decision.reason).toContain('C 类');
  });

  it('不可逆的一律 manual（没有自动回滚的兜底）', () => {
    const decision = routeFor(candidate({ reversible: false }));
    expect(decision.route).toBe('manual');
    expect(decision.reason).toContain('不可逆');
  });

  it('改动跨多类执行器 → manual，并说明原因', () => {
    const mixed = candidate({
      changes: [
        { type: 'ast', file: 'src/a.tsx', node: 'x', description: 'y' },
        { type: 'config', file: 'vite.config.ts', key: 'k', before: null, after: 1 },
      ],
    });

    const decision = routeFor(mixed);
    expect(decision.route).toBe('manual');
    expect(decision.reason).toContain('跨');
  });

  it('没有改动项时 manual（无从执行）', () => {
    expect(routeFor(candidate({ changes: [] })).route).toBe('manual');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 验收 4：分级映射与白名单
// ─────────────────────────────────────────────────────────────────────

describe('M4 验收 4 — A/B/C ↔ apply/confirm/suggest', () => {
  const thresholds = { minGain: 5, maxRegression: 2, maxNewErrors: 0, applyScore: 60, confirmScore: 35 };

  const gradeWith = (utility: number, klass: OptimizationClass, maxClass: OptimizationClass | null = klass) =>
    grade({ utility, klass, thresholds, maxClass }).verdict;

  it('A 类分数达标 → apply', () => {
    expect(gradeWith(80, 'A')).toBe('apply');
    expect(gradeWith(60, 'A')).toBe('apply');
  });

  it('A 类分数不够 → 降为 confirm，而不是照做', () => {
    expect(gradeWith(59.9, 'A')).toBe('confirm');
    expect(gradeWith(35, 'A')).toBe('confirm');
  });

  it('A 类分数太低 → reject', () => {
    expect(gradeWith(34.9, 'A')).toBe('reject');
    expect(gradeWith(-10, 'A')).toBe('reject');
  });

  it('B 类最多到 confirm，永远不会 apply', () => {
    expect(gradeWith(999, 'B')).toBe('confirm');
    expect(gradeWith(35, 'B')).toBe('confirm');
    expect(gradeWith(34.9, 'B')).toBe('reject');
  });

  it('C 类只出建议，永远不会 confirm/apply', () => {
    expect(gradeWith(999, 'C')).toBe('suggest');
    expect(gradeWith(1, 'C')).toBe('suggest');
    expect(gradeWith(0, 'C')).toBe('reject');
  });

  it('白名单把候选降级时，裁决跟着降', () => {
    // A 类候选但白名单只允许到 C
    expect(gradeWith(999, 'A', 'C')).toBe('suggest');
    // A 类但白名单只允许到 B
    expect(gradeWith(999, 'A', 'B')).toBe('confirm');
  });

  it('白名单拒绝（maxClass=null）→ 直接 reject', () => {
    const result = grade({ utility: 999, klass: 'A', thresholds, maxClass: null });
    expect(result.verdict).toBe('reject');
    expect(result.reasons.join(' ')).toContain('白名单');
  });

  it('阈值来自配置：改配置即改裁决', () => {
    const strict = { ...thresholds, applyScore: 95 };
    expect(grade({ utility: 80, klass: 'A', thresholds: strict, maxClass: 'A' }).verdict).toBe('confirm');

    const lenient = { ...thresholds, applyScore: 10, confirmScore: 5 };
    expect(grade({ utility: 20, klass: 'A', thresholds: lenient, maxClass: 'A' }).verdict).toBe('apply');
  });

  it('白名单只列了部分 kind 时，未列出的被拒绝', () => {
    const optimization = { auto_fix: ['OVERSIZED_IMAGE'], manual_confirm: [], suggest_only: [] };
    const covered = checkAllowlist({ class: 'A', bottleneckKinds: ['OVERSIZED_IMAGE'] }, optimization);
    const missing = checkAllowlist({ class: 'A', bottleneckKinds: ['LARGE_JS_BUNDLE'] }, optimization);

    expect(covered.allowed).toBe(true);
    expect(missing.allowed).toBe(false);
    expect(missing.reason).toContain('LARGE_JS_BUNDLE');
  });

  it('白名单为空时不做限制（未配置 ≠ 什么都不允许）', () => {
    const empty = { auto_fix: [], manual_confirm: [], suggest_only: [] };
    const result = checkAllowlist({ class: 'A', bottleneckKinds: ['OVERSIZED_IMAGE'] }, empty);

    expect(result.allowed).toBe(true);
    expect(result.maxClass).toBe('A');
  });

  it('kind 只出现在更低一级列表时被降级', () => {
    const optimization = { auto_fix: [], manual_confirm: [], suggest_only: ['OVERSIZED_IMAGE'] };
    const result = checkAllowlist({ class: 'A', bottleneckKinds: ['OVERSIZED_IMAGE'] }, optimization);

    expect(result.allowed).toBe(true);
    expect(result.maxClass).toBe('C');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 验收 1 + 6：纯函数与阈值快照
// ─────────────────────────────────────────────────────────────────────

describe('M4 验收 1 & 6 — 确定性与阈值快照', () => {
  it('同一份输入两次决策完全一致（快照稳定）', () => {
    const input = { runId: 'run_1', candidates: [candidate(), candidate({ class: 'B' })], createdAt: '2026-01-17T14:25:30.000Z' };
    const a = engine().decide(input);
    const b = engine().decide(input);

    expect(JSON.stringify(a.decisions)).toBe(JSON.stringify(b.decisions));
  });

  it('每个候选恰好一条决策，包括被拒绝的', () => {
    const candidates = [candidate(), candidate({ class: 'C' }), candidate({ expectedGain: {} })];
    const { decisions } = decide(candidates);

    expect(decisions).toHaveLength(candidates.length);
    expect(new Set(decisions.map((d) => d.candidateId))).toEqual(new Set(candidates.map((c) => c.id)));
  });

  it('thresholds 快照写入每条决策，且来自配置', () => {
    const { decisions, thresholds } = decide([candidate()], {
      decision: {
        jev: true,
        thresholds: { min_gain: 9, max_regression: 3, max_new_errors: 1, apply_score: 70, confirm_score: 40 },
        weights: { metrics: {}, risk_aversion: 1 },
      },
    });

    expect(thresholds).toEqual({
      minGain: 9,
      maxRegression: 3,
      maxNewErrors: 1,
      applyScore: 70,
      confirmScore: 40,
    });
    expect(decisions[0]?.thresholds).toEqual(thresholds);
  });

  it('决策按 utility 降序排列', () => {
    const { decisions } = decide([
      candidate({ expectedGain: { LCP: 100 } }),
      candidate({ expectedGain: { LCP: 1500 } }),
      candidate({ expectedGain: { LCP: 800 } }),
    ]);

    const scores = decisions.map((d) => d.score);
    for (let i = 1; i < scores.length; i += 1) {
      expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i] as number);
    }
  });

  it('没有执行器能处理的候选，不会被判 apply', () => {
    /**
     * 真实事故：LLM 把 `asset` 与 `ast` 混在**同一个** `changes` 里。
     * `routeFor` 正确地判了 `manual`，但分数够高时 `verdict` 仍然是 `apply` ——
     * 于是报告出现自相矛盾的两行：上面 `apply 1`，下面"产出 0 份 patch"，
     * 而真正的原因（"没有执行器能处理改动类型 asset/ast"）藏在执行阶段的备注里。
     */
    const mixed = candidate({
      class: 'A',
      expectedGain: { LCP: 1500 },
      changes: [
        { type: 'asset', file: 'public/hero.png', operation: 'compress', params: {} },
        { type: 'ast', file: 'src/hero.tsx', node: 'add-loading-lazy', description: '加 lazy' },
      ],
    });

    const { decisions } = decide([mixed]);
    const [decision] = decisions;

    expect(decision?.route).toBe('manual');
    expect(decision?.verdict).toBe('suggest');
    expect(decision?.reasons.join(' ')).toContain('没有执行器能完整处理');
  });

  it('所有决策都能通过 DecisionSchema', () => {
    const { decisions } = decide([
      candidate(),
      candidate({ class: 'B' }),
      candidate({ class: 'C', reversible: false }),
      candidate({ changes: [], expectedGain: {} }),
    ]);

    for (const decision of decisions) {
      const parsed = DecisionSchema.safeParse(decision);
      if (!parsed.success) {
        throw new Error(`schema 校验失败: ${JSON.stringify(parsed.error.issues)}`);
      }
    }
  });

  it('空候选产出空决策与全零计数', () => {
    const { decisions, counts } = decide([]);
    expect(decisions).toEqual([]);
    expect(counts).toEqual({ apply: 0, confirm: 0, suggest: 0, reject: 0 });
  });

  it('每条决策都带可读理由，拒绝的尤其要说明原因', () => {
    const { decisions } = decide([candidate({ expectedGain: {} })]);

    expect(decisions[0]?.reasons.length).toBeGreaterThan(0);
    expect(decisions[0]?.reasons.join(' ')).toContain('utility');
  });

  it('decision.jev=false 时不启用效用模型，全部降为 suggest（保守开关）', () => {
    const { decisions } = decide([candidate(), candidate({ class: 'C' })], {
      decision: { jev: false },
    });

    expect(decisions).toHaveLength(2);
    expect(decisions.every((d) => d.verdict === 'suggest')).toBe(true);
    expect(decisions.every((d) => d.route === 'manual')).toBe(true);
    expect(decisions.every((d) => d.score === 0)).toBe(true);
    expect(decisions[0]?.reasons.join(' ')).toContain('jev=false');
  });
});

describe('riskLevelOf', () => {
  it('不可逆一律 high', () => {
    expect(riskLevelOf(0, { reversible: false })).toBe('high');
  });

  it('按分数分档', () => {
    expect(riskLevelOf(2, { reversible: true })).toBe('low');
    expect(riskLevelOf(6, { reversible: true })).toBe('medium');
    expect(riskLevelOf(15, { reversible: true })).toBe('high');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 验收 5：决策路径不含 LLM
// ─────────────────────────────────────────────────────────────────────

describe('M4 验收 5 — 决策路径不含 LLM', () => {
  /**
   * 依赖图断言。
   *
   * 直接读 `core/src/decision/` 下的源码，检查 import 里不出现
   * LLM 相关的路径或包名。比 ESLint 规则更直接：ESLint 保证「提交时」合规，
   * 这个测试保证「任何时候」都合规（包括有人改了 eslint 配置之后）。
   */
  it('decision 目录下没有任何文件 import LLM 相关模块', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);

    const forbidden = [/['"][^'"]*\/llm\//, /['"]ai['"]/, /['"]@ai-sdk\//, /['"]openai['"]/];
    const offenders: string[] = [];

    for (const file of files) {
      const source = readFileSync(join(dir, file), 'utf8');
      for (const line of source.split('\n')) {
        // 只看 import / export ... from 语句，注释里提到 LLM 不算违规
        if (!/^\s*(import|export)\b/.test(line)) continue;
        if (forbidden.some((re) => re.test(line))) offenders.push(`${file}: ${line.trim()}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('LlmPort 无法让决策模块产出不同结果（决策不依赖 LLM 端口）', () => {
    // 结构性保证：DecisionEngine 的构造参数里没有 llm
    const e = new DecisionEngine({ config: configFixture(), logger: silent });
    expect(Object.keys(e)).not.toContain('llm');
  });
});
