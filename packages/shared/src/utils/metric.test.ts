import { describe, expect, it } from 'vitest';
import {
  METRIC_SPECS,
  buildMetric,
  computeDelta,
  computeDeltas,
  rateMetric,
  resolveSpec,
  round,
  scoreMetric,
  sortMetrics,
  sourceChanges,
} from '../utils/metric.js';
import type { Metric, MetricName } from '../types/metric.js';

const lcp = METRIC_SPECS.LCP;

describe('scoreMetric', () => {
  it('good 边界及以内给满分', () => {
    expect(scoreMetric(1000, lcp)).toBe(100);
    expect(scoreMetric(2500, lcp)).toBe(100);
  });

  it('good → poor 线性降到 50', () => {
    expect(scoreMetric(3250, lcp)).toBeCloseTo(75, 5);
    expect(scoreMetric(4000, lcp)).toBeCloseTo(50, 5);
  });

  it('poor 之后继续降到 0，且不会为负', () => {
    expect(scoreMetric(6000, lcp)).toBeCloseTo(25, 5);
    expect(scoreMetric(8000, lcp)).toBeCloseTo(0, 5);
    expect(scoreMetric(999_999, lcp)).toBe(0);
  });

  it('分数随指标劣化单调不增', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let v = 0; v <= 12_000; v += 100) {
      const score = scoreMetric(v, lcp);
      expect(score).toBeLessThanOrEqual(previous + 1e-9);
      previous = score;
    }
  });

  it('计分类指标（good=0）也满足分段定义', () => {
    const dup = METRIC_SPECS.DUPLICATE_DEPS;
    expect(scoreMetric(0, dup)).toBe(100);
    expect(scoreMetric(2.5, dup)).toBeCloseTo(75, 5);
    expect(scoreMetric(5, dup)).toBeCloseTo(50, 5);
    expect(scoreMetric(10, dup)).toBe(0);
  });

  it('good 与 poor 重合时退化为二值判断，不产生 NaN', () => {
    const degenerate = { ...lcp, good: 100, poor: 100 };
    expect(scoreMetric(50, degenerate)).toBe(100);
    expect(scoreMetric(101, degenerate)).toBe(0);
  });

  it('非有限值返回 0 而不是抛错（采集可能产生 NaN）', () => {
    expect(scoreMetric(Number.NaN, lcp)).toBe(0);
    expect(scoreMetric(Number.POSITIVE_INFINITY, lcp)).toBe(0);
  });

  it('higher-is-better 方向通过取反复用同一条曲线', () => {
    const higherIsBetter = {
      unit: 'score' as const,
      direction: 'higher-is-better' as const,
      good: 90,
      poor: 50,
      precision: 0,
    };
    expect(scoreMetric(95, higherIsBetter)).toBe(100);
    expect(scoreMetric(90, higherIsBetter)).toBe(100);
    expect(scoreMetric(70, higherIsBetter)).toBeCloseTo(75, 5);
    expect(scoreMetric(50, higherIsBetter)).toBeCloseTo(50, 5);
  });
});

describe('rateMetric', () => {
  it('按 good / poor 边界给出评级', () => {
    expect(rateMetric(2400, lcp)).toBe('good');
    expect(rateMetric(2500, lcp)).toBe('good');
    expect(rateMetric(3000, lcp)).toBe('needs-improvement');
    expect(rateMetric(4000, lcp)).toBe('needs-improvement');
    expect(rateMetric(4001, lcp)).toBe('poor');
  });
});

describe('resolveSpec', () => {
  it('无覆盖时返回默认规格', () => {
    expect(resolveSpec('LCP')).toEqual(lcp);
  });

  it('warning / error 覆盖 good / poor 边界', () => {
    const spec = resolveSpec('LCP', { LCP: { warning: 1000, error: 2000 } });
    expect(spec.good).toBe(1000);
    expect(spec.poor).toBe(2000);
    expect(scoreMetric(1500, spec)).toBeCloseTo(75, 5);
  });

  it('只覆盖部分指标时其余保持默认', () => {
    const spec = resolveSpec('CLS', { LCP: { warning: 1, error: 2 } });
    expect(spec).toEqual(METRIC_SPECS.CLS);
  });
});

describe('buildMetric', () => {
  const base = {
    name: 'LCP' as MetricName,
    value: 3000,
    route: '/',
    device: 'mobile' as const,
    source: 'lighthouse' as const,
    collectedAt: '2026-01-17T14:25:30.000Z',
  };

  it('unit / rating / score 由规格表唯一决定', () => {
    const metric = buildMetric(base);
    expect(metric.unit).toBe('ms');
    expect(metric.rating).toBe('needs-improvement');
    expect(metric.score).toBeCloseTo(83.33, 2);
  });

  it('score 被限制在 0-100 且保留两位', () => {
    const metric = buildMetric({ ...base, value: 99_999 });
    expect(metric.score).toBe(0);
  });
});

describe('computeDelta', () => {
  const make = (name: MetricName, value: number): Metric =>
    buildMetric({
      name,
      value,
      route: '/',
      device: 'mobile',
      source: 'lighthouse',
      collectedAt: '2026-01-17T14:25:30.000Z',
    });

  it('无基线时 delta 字段为 null，而不是编造 0', () => {
    const delta = computeDelta(make('LCP', 3000), null);
    expect(delta.baseline).toBeNull();
    expect(delta.delta).toBeNull();
    expect(delta.deltaPercent).toBeNull();
    expect(delta.scoreDelta).toBeNull();
    expect(delta.current).toBe(3000);
  });

  it('指标变慢 → delta 与 scoreDelta 均为负（回归）', () => {
    const delta = computeDelta(make('LCP', 3000), make('LCP', 2000));
    expect(delta.delta).toBe(-1000);
    expect(delta.deltaPercent).toBeCloseTo(-50, 2);
    expect(delta.scoreDelta).toBeCloseTo(-16.67, 2);
  });

  it('指标变快 → delta 与 scoreDelta 均为正（改善）', () => {
    const delta = computeDelta(make('LCP', 2000), make('LCP', 3000));
    expect(delta.delta).toBe(1000);
    expect(delta.deltaPercent).toBeCloseTo(33.33, 2);
    expect(delta.scoreDelta).toBeCloseTo(16.67, 2);
  });

  it('体积减小同样记为正改善（方向统一在 shared 内完成）', () => {
    const delta = computeDelta(make('JS_SIZE', 250_000), make('JS_SIZE', 400_000));
    expect(delta.delta).toBe(150_000);
    expect(delta.scoreDelta).toBeGreaterThan(0);
  });

  it('基线为 0 时百分比不可计算，返回 null 而非 Infinity', () => {
    const delta = computeDelta(make('DUPLICATE_DEPS', 3), make('DUPLICATE_DEPS', 0));
    expect(delta.deltaPercent).toBeNull();
    expect(delta.delta).toBe(-3);
  });

  it('测量来源不同则不给差值（跨工具相减会造出假回归）', () => {
    const current = buildMetric({
      name: 'LCP',
      value: 2000,
      route: '/',
      device: 'mobile',
      source: 'web-vitals',
      collectedAt: '2026-01-17T14:25:30.000Z',
    });
    const baseline = buildMetric({
      name: 'LCP',
      value: 4000,
      route: '/',
      device: 'mobile',
      source: 'lighthouse',
      collectedAt: '2026-01-16T14:25:30.000Z',
    });

    const delta = computeDelta(current, baseline);
    // 数字仍然展示出来，方便人判断；但不给出任何差值结论
    expect(delta.current).toBe(2000);
    expect(delta.baseline).toBe(4000);
    expect(delta.delta).toBeNull();
    expect(delta.deltaPercent).toBeNull();
    expect(delta.scoreDelta).toBeNull();
  });

  it('来源相同时正常计算', () => {
    const delta = computeDelta(make('LCP', 2000), make('LCP', 3000));
    expect(delta.scoreDelta).not.toBeNull();
  });
});

describe('computeDeltas', () => {
  const make = (name: MetricName, value: number): Metric =>
    buildMetric({
      name,
      value,
      route: '/',
      device: 'mobile',
      source: 'lighthouse',
      collectedAt: '2026-01-17T14:25:30.000Z',
    });

  it('按指标名逐个对齐，缺失的基线不参与', () => {
    const deltas = computeDeltas(
      [make('LCP', 3000), make('CLS', 0.3)],
      [make('LCP', 2000), make('TBT', 100)],
    );
    expect(deltas).toHaveLength(2);
    expect(deltas[0]?.scoreDelta).not.toBeNull();
    expect(deltas[1]?.scoreDelta).toBeNull();
  });

  it('基线为空数组时全部返回 null 差值', () => {
    const deltas = computeDeltas([make('LCP', 3000)], []);
    expect(deltas.every((d) => d.scoreDelta === null)).toBe(true);
  });
});

describe('sourceChanges', () => {
  const withSource = (name: MetricName, value: number, source: Metric['source']): Metric =>
    buildMetric({
      name,
      value,
      route: '/',
      device: 'mobile',
      source,
      collectedAt: '2026-01-17T14:25:30.000Z',
    });

  it('找出换了测量来源的指标', () => {
    const changes = sourceChanges(
      [withSource('LCP', 2000, 'web-vitals'), withSource('CLS', 0.1, 'lighthouse')],
      [withSource('LCP', 3000, 'lighthouse'), withSource('CLS', 0.2, 'lighthouse')],
    );

    expect(changes).toEqual([{ name: 'LCP', from: 'lighthouse', to: 'web-vitals' }]);
  });

  it('基线里没有的指标不算来源变化', () => {
    expect(sourceChanges([withSource('INP', 150, 'web-vitals')], [])).toEqual([]);
  });
});

describe('sortMetrics / round', () => {
  it('排序稳定，保证落盘顺序可 diff', () => {
    const make = (name: MetricName): Metric =>
      buildMetric({
        name,
        value: 1,
        route: '/',
        device: 'mobile',
        source: 'lighthouse',
        collectedAt: '2026-01-17T14:25:30.000Z',
      });
    const sorted = sortMetrics([make('LCP'), make('CLS'), make('TBT')]);
    expect(sorted.map((m) => m.name)).toEqual(['CLS', 'LCP', 'TBT']);
  });

  it('round 处理负数与零位', () => {
    expect(round(-16.666, 2)).toBe(-16.67);
    expect(round(1.5, 0)).toBe(2);
  });
});
