import { describe, expect, it } from 'vitest';
import type { MetricName, MetricSeries, RunRecord } from '@yuki-byte18/shared';
import { MetricSeriesSchema, buildMetric } from '@yuki-byte18/shared';
import { buildMetricSeries } from './index.js';

/**
 * 跨 run 指标趋势（M8 验收 1 的「跨 run」那一半）。
 *
 * 这些用例原本长在报告页里（前端自己算趋势）。搬到 core 是因为前端拿不到
 * core 的实现，趋势只能由服务端算好 —— 而"来源变了就不给变化量"这条判断
 * 属于**测量正确性**，必须只有一份实现、只有一处测试。
 */

const metric = (name: MetricName, value: number, source = 'lighthouse') =>
  buildMetric({
    name,
    value,
    route: '/',
    device: 'mobile',
    source: source as 'lighthouse',
    collectedAt: '2026-01-17T14:25:30.000Z',
  });

function run(id: string, startedAt: string, values: Array<[MetricName, number, string?]>): RunRecord {
  return {
    schemaVersion: 1,
    llmCostUsd: 0,
    id,
    project: 'demo',
    route: '/',
    device: 'mobile',
    url: 'https://staging.example.com',
    status: 'success',
    startedAt,
    finishedAt: startedAt,
    durationMs: 1000,
    perfpilotVersion: '0.1.0',
    stages: [],
    metrics: values.map(([name, value, source]) =>
      source === undefined ? metric(name, value) : metric(name, value, source),
    ),
    baseline: null,
    deltas: [],
    warnings: [],
    artifacts: [],
  };
}

describe('buildMetricSeries — 时间顺序', () => {
  it('无论入参顺序如何，输出都是时间升序', () => {
    const series = buildMetricSeries([
      run('run_b', '2026-01-18T10:00:00.000Z', [['LCP', 2000]]),
      run('run_a', '2026-01-17T10:00:00.000Z', [['LCP', 3500]]),
    ]);

    expect(series[0]?.points.map((p) => p.runId)).toEqual(['run_a', 'run_b']);
    expect(series[0]?.change).toBe(-1500);
  });

  it('limit 取的是**最近**的 N 次，而不是最早的 N 次', () => {
    const runs = [
      run('run_1', '2026-01-17T10:00:00.000Z', [['LCP', 3500]]),
      run('run_2', '2026-01-18T10:00:00.000Z', [['LCP', 3000]]),
      run('run_3', '2026-01-19T10:00:00.000Z', [['LCP', 2500]]),
    ];

    const series = buildMetricSeries(runs, { limit: 2 });

    // 先排序再截断：留下的是最近两次，不是最早两次
    expect(series[0]?.points.map((p) => p.runId)).toEqual(['run_2', 'run_3']);
  });

  it('核心指标排在前面（LCP / CLS / INP），其余按字母', () => {
    const series = buildMetricSeries([
      run('run_1', '2026-01-17T10:00:00.000Z', [
        ['TBT', 400],
        ['INP', 150],
        ['LCP', 2000],
      ]),
    ]);

    expect(series.map((s) => s.name)).toEqual(['LCP', 'INP', 'TBT']);
  });
});

describe('buildMetricSeries — 可比性', () => {
  it('只有一次运行时 change 为 null，但 enoughData 是显式的', () => {
    const series = buildMetricSeries([run('run_1', '2026-01-17T10:00:00.000Z', [['LCP', 2000]])]);

    expect(series[0]?.change).toBeNull();
    expect(series[0]?.changePercent).toBeNull();
    // 关键：一个点画不出趋势，前端据此说"只有一个数据点"，而不是画一条假的持平线
    expect(series[0]?.enoughData).toBe(false);
  });

  it('测量来源变过 → 不给变化量，并标记 sourceChanged', () => {
    const series = buildMetricSeries([
      run('run_1', '2026-01-17T10:00:00.000Z', [['LCP', 3500, 'lighthouse']]),
      run('run_2', '2026-01-18T10:00:00.000Z', [['LCP', 2000, 'web-vitals']]),
    ]);

    const lcp = series[0];
    // 换了工具就换了尺子，不能画成"变快了 1500ms"
    expect(lcp?.change).toBeNull();
    expect(lcp?.changePercent).toBeNull();
    expect(lcp?.sourceChanged).toBe(true);
    // 但数据点本身要留着 —— 人需要看到"这两次测的不是一回事"
    expect(lcp?.points).toHaveLength(2);
    expect(lcp?.enoughData).toBe(true);
  });

  it('某次 run 缺某个指标时，其它指标不受影响', () => {
    const series = buildMetricSeries([
      run('run_1', '2026-01-17T10:00:00.000Z', [
        ['LCP', 3500],
        ['CLS', 0.05],
      ]),
      run('run_2', '2026-01-18T10:00:00.000Z', [['LCP', 2000]]),
    ]);

    expect(series.find((s) => s.name === 'LCP')?.points).toHaveLength(2);
    expect(series.find((s) => s.name === 'CLS')?.points).toHaveLength(1);
  });

  it('基数为 0 时不给百分比（除零会变成 Infinity）', () => {
    const series = buildMetricSeries([
      run('run_1', '2026-01-17T10:00:00.000Z', [['DUPLICATE_DEPS', 0]]),
      run('run_2', '2026-01-18T10:00:00.000Z', [['DUPLICATE_DEPS', 3]]),
    ]);

    expect(series[0]?.change).toBe(3);
    expect(series[0]?.changePercent).toBeNull();
  });

  it('names 过滤只留指定指标', () => {
    const series = buildMetricSeries(
      [
        run('run_1', '2026-01-17T10:00:00.000Z', [
          ['LCP', 2000],
          ['TBT', 400],
        ]),
      ],
      { names: ['TBT'] },
    );

    expect(series.map((s) => s.name)).toEqual(['TBT']);
  });

  it('没有指标时返回空数组，不崩', () => {
    expect(buildMetricSeries([run('run_1', '2026-01-17T10:00:00.000Z', [])])).toEqual([]);
    expect(buildMetricSeries([])).toEqual([]);
  });
});

describe('指标方向', () => {
  it('全部性能指标都是"越小越好"（方向搞反会让劣化被写成改善）', async () => {
    const { isLowerBetter, METRIC_NAMES } = await import('@yuki-byte18/shared');

    for (const name of METRIC_NAMES) {
      expect(isLowerBetter(name)).toBe(true);
    }
  });
});

describe('趋势与 schema 的契约', () => {
  it('core 产出的序列能通过 shared 的 schema（前后端契约一致）', () => {
    const series: MetricSeries[] = buildMetricSeries([
      run('run_1', '2026-01-17T10:00:00.000Z', [['LCP', 3500]]),
      run('run_2', '2026-01-18T10:00:00.000Z', [['LCP', 2000]]),
    ]);

    // 前端拿到的是**未经自己校验的外部输入**，因此这条必须过
    for (const item of series) {
      expect(MetricSeriesSchema.safeParse(item).success).toBe(true);
    }
  });

  it('schema 会拒绝被写坏的数据（而不是让前端拿到一个类型谎话）', () => {
    const broken = {
      name: 'LCP',
      points: [{ runId: 'run_1', startedAt: 'x', value: 1, score: 999, rating: 'good', source: 'lighthouse' }],
      change: null,
      changePercent: null,
      sourceChanged: false,
      enoughData: false,
    };

    // score 超出 0-100
    expect(MetricSeriesSchema.safeParse(broken).success).toBe(false);
  });
});
