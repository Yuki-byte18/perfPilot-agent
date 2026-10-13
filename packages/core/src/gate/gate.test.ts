import { describe, expect, it } from 'vitest';
import { evaluateCiGate } from './index.js';
import { configFixture, metric, runFixture } from '../fixtures/index.js';
import { computeDeltas } from '@yuki-byte18/shared';

/**
 * CI 门禁（M7 验收 1/5）。
 *
 * 这一组的关键不是"覆盖了几条分支"，而是钉死门禁**怎么判**：
 * 判的是回归，不是绝对值；没有数据时必须失败，而不是"没有回归所以通过"。
 */

/** 造一个带差值的 run：基线 → 当前 */
function runWith(
  current: Array<{ name: Parameters<typeof metric>[0]; value: number }>,
  baseline: Array<{ name: Parameters<typeof metric>[0]; value: number }>,
  overrides: Parameters<typeof runFixture>[0] = {},
) {
  const metrics = current.map((m) => metric(m.name, m.value));
  const baselineMetrics = baseline.map((m) => metric(m.name, m.value));

  return runFixture({
    metrics,
    deltas: computeDeltas(metrics, baselineMetrics, {}),
    baseline: { ref: 'main', runId: 'run_prev', metrics: baselineMetrics },
    ...overrides,
  });
}

describe('M7 验收 1 — 门禁判据', () => {
  it('无回归 → 通过', () => {
    // LCP 3500 → 2000：明显改善
    const gate = evaluateCiGate({
      run: runWith([{ name: 'LCP', value: 2000 }], [{ name: 'LCP', value: 3500 }]),
      config: configFixture(),
    });

    expect(gate.passed).toBe(true);
    expect(gate.failures).toEqual([]);
  });

  it('回归超过 max_regression → 不通过，并说清是哪一项、差多少', () => {
    // LCP 2000 → 3500：分数跌了 33，远超默认 max_regression 2
    const gate = evaluateCiGate({
      run: runWith([{ name: 'LCP', value: 3500 }], [{ name: 'LCP', value: 2000 }]),
      config: configFixture(),
    });

    expect(gate.passed).toBe(false);
    expect(gate.failures.join(' ')).toContain('LCP');
    expect(gate.failures.join(' ')).toContain('regression');
  });

  it('回归在允许范围内 → 通过（测量抖动不该挂掉 CI）', () => {
    // LCP 2500 → 2530：分数差不到 2
    const gate = evaluateCiGate({
      run: runWith([{ name: 'LCP', value: 2530 }], [{ name: 'LCP', value: 2500 }]),
      config: configFixture(),
    });

    expect(gate.passed).toBe(true);
  });

  it('阈值可由参数覆盖，不必改配置文件', () => {
    const run = runWith([{ name: 'LCP', value: 3500 }], [{ name: 'LCP', value: 2000 }]);

    // 放到 40 分以内就放行
    expect(evaluateCiGate({ run, config: configFixture(), maxRegression: 40 }).passed).toBe(true);
    // 收紧到 1 分就拦住
    expect(evaluateCiGate({ run, config: configFixture(), maxRegression: 1 }).passed).toBe(false);
  });

  it('零指标 → 不通过（"没测到"绝不能读成"没问题"）', () => {
    const gate = evaluateCiGate({
      run: runFixture({ metrics: [], deltas: [], baseline: null }),
      config: configFixture(),
    });

    expect(gate.passed).toBe(false);
    expect(gate.failures.join(' ')).toContain('collection');
  });

  it('可选来源不可用（HAR / trace 没接）→ 不判失败', () => {
    /**
     * 这条是**回归测试**：第一版的门禁写成"有任何 degraded 告警就失败"，
     * 于是每个没接 HAR / trace / web-vitals 的项目都会永久红灯 ——
     * 那种门禁很快就会被关掉，等于没有。
     */
    const run = runFixture({
      metrics: [metric('LCP', 2000)],
      deltas: [],
      warnings: [
        {
          adapter: 'har',
          code: 'ADAPTER_UNAVAILABLE',
          severity: 'degraded',
          message: 'har 不可用（外部工具未安装或输入缺失）',
        },
        {
          adapter: 'trace',
          code: 'ADAPTER_UNAVAILABLE',
          severity: 'degraded',
          message: 'trace 不可用',
        },
      ],
    });

    expect(evaluateCiGate({ run, config: configFixture() }).passed).toBe(true);
  });

  it('数据源本该可用却失败了 → 不通过（指标不完整且不可预期）', () => {
    const run = runFixture({
      metrics: [metric('LCP', 2000)],
      deltas: [],
      warnings: [
        {
          adapter: 'lighthouse',
          code: 'ADAPTER_FAILED',
          severity: 'degraded',
          message: 'lighthouse 采集失败：Chrome 崩溃',
        },
      ],
    });

    const gate = evaluateCiGate({ run, config: configFixture() });
    expect(gate.passed).toBe(false);
    expect(gate.failures.join(' ')).toContain('collection-integrity');
  });

  it('`info` 告警不影响门禁（那只是"来源变了，说明一下"）', () => {
    const run = runFixture({
      metrics: [metric('LCP', 2000)],
      deltas: [],
      warnings: [
        {
          adapter: 'web-vitals',
          code: 'METRIC_SOURCE_FALLBACK',
          severity: 'info',
          message: 'LCP 本次来源为 web-vitals',
        },
      ],
    });

    expect(evaluateCiGate({ run, config: configFixture() }).passed).toBe(true);
  });

  it('无基线时不判回归（首次运行不该被判成"回归了"）', () => {
    const gate = evaluateCiGate({
      run: runFixture({ metrics: [metric('LCP', 3800)], deltas: [], baseline: null }),
      config: configFixture(),
    });

    expect(gate.passed).toBe(true);
    expect(gate.checks.find((c) => c.name === 'regression')?.detail).toContain('无可用基线');
  });

  it('配了 error 绝对阈值时才判绝对值', () => {
    const config = configFixture({
      baseline: { ref: 'last-run', metrics: { LCP: { warning: 2500, error: 3000 } } },
    });

    // 3800ms 超过 error 3000
    const over = evaluateCiGate({
      run: runFixture({ metrics: [metric('LCP', 3800)], deltas: [], baseline: null }),
      config,
    });
    expect(over.passed).toBe(false);
    expect(over.failures.join(' ')).toContain('threshold:LCP');

    // 没配阈值的指标不参与绝对判定
    const notConfigured = evaluateCiGate({
      run: runFixture({ metrics: [metric('CLS', 0.9)], deltas: [], baseline: null }),
      config,
    });
    expect(notConfigured.passed).toBe(true);
  });
});

describe('M7 验收 5 — 门禁结果可复现', () => {
  it('同一份 run + 同一份配置，两次评估结果完全一致', () => {
    const run = runWith(
      [
        { name: 'LCP', value: 3500 },
        { name: 'CLS', value: 0.2 },
      ],
      [
        { name: 'LCP', value: 2000 },
        { name: 'CLS', value: 0.05 },
      ],
    );
    const config = configFixture();

    /**
     * 可复现不是"重跑一次碰巧一样"，而是结构上不可能不一样：
     * 这个函数不看时间、不看环境变量、不看随机数。
     * 因此这里连跑三次直接比对象 —— 任何一次不一致都说明引入了外部状态。
     */
    const first = evaluateCiGate({ run, config });
    const second = evaluateCiGate({ run, config });
    const third = evaluateCiGate({ run, config });

    expect(second).toEqual(first);
    expect(third).toEqual(first);
    expect(first.passed).toBe(false);
  });

  it('结论是纯数据，能被 JSON 往返（落盘的 gate.json 可再次比对）', () => {
    const gate = evaluateCiGate({
      run: runWith([{ name: 'LCP', value: 2000 }], [{ name: 'LCP', value: 3500 }]),
      config: configFixture(),
    });

    const restored = JSON.parse(JSON.stringify(gate)) as typeof gate;
    expect(restored).toEqual(gate);
  });
});
