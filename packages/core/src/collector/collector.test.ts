import { describe, expect, it } from 'vitest';
import { AdapterError, type MetricName, type RunWarning } from '@yuki-byte18/shared';
import { assertCollectionUsable, collect } from './index.js';
import { createMemoryLogger } from '../logger/index.js';
import { fakeCollector } from '../fixtures/index.js';

const base = {
  outputDir: '/tmp/run',
  url: 'https://staging.example.com',
  route: '/',
  device: 'mobile' as const,
  timeoutMs: 1000,
};

const options = (collectors: Parameters<typeof collect>[0]['collectors']) => ({
  ...base,
  collectors,
  logger: createMemoryLogger(),
});

const codes = (warnings: readonly RunWarning[]): string[] => warnings.map((w) => w.code);

describe('collect — 正常路径', () => {
  it('合并多个 adapter 的样本并打分', async () => {
    const result = await collect(
      options([
        fakeCollector({ id: 'lighthouse', samples: [{ name: 'LCP', value: 3000 }] }),
        fakeCollector({ id: 'bundle-analyzer', samples: [{ name: 'JS_SIZE', value: 400_000 }] }),
      ]),
    );

    expect(result.metrics).toHaveLength(2);
    expect(result.succeeded.sort()).toEqual(['bundle-analyzer', 'lighthouse']);
    expect(result.failed).toEqual([]);
    expect(result.warnings).toEqual([]);

    const lcp = result.metrics.find((m) => m.name === 'LCP');
    expect(lcp?.source).toBe('lighthouse');
    expect(lcp?.unit).toBe('ms');
    expect(lcp?.rating).toBe('needs-improvement');
    expect(lcp?.route).toBe('/');
    expect(lcp?.device).toBe('mobile');
  });

  it('产出未打分样本，打分统一由 collector 完成（阈值覆盖在此生效）', async () => {
    const result = await collect({
      ...options([fakeCollector({ id: 'lighthouse', samples: [{ name: 'LCP', value: 3000 }] })]),
      thresholds: { LCP: { warning: 5000, error: 9000 } },
    });

    // 默认阈值下 3000ms 是 needs-improvement；覆盖后应该是 good
    expect(result.metrics[0]?.rating).toBe('good');
    expect(result.metrics[0]?.score).toBe(100);
  });

  it('记录每个指标最终采用的来源', async () => {
    const result = await collect(
      options([
        fakeCollector({ id: 'lighthouse', samples: [{ name: 'LCP', value: 2500 }] }),
        fakeCollector({ id: 'web-vitals', samples: [{ name: 'INP', value: 180 }] }),
      ]),
    );

    expect(result.sources).toEqual({ LCP: 'lighthouse', INP: 'web-vitals' });
  });
});

describe('collect — 降级（M1 验收标准第 4 条）', () => {
  it('单个 adapter 崩溃时其余指标照常产出', async () => {
    const logger = createMemoryLogger();
    const result = await collect({
      ...base,
      collectors: [
        fakeCollector({ id: 'lighthouse', collectThrows: true }),
        fakeCollector({ id: 'bundle-analyzer', samples: [{ name: 'JS_SIZE', value: 300_000 }] }),
      ],
      logger,
    });

    expect(result.metrics).toHaveLength(1);
    expect(result.failed).toEqual(['lighthouse']);
    expect(result.succeeded).toEqual(['bundle-analyzer']);
    expect(codes(result.warnings)).toEqual(['ADAPTER_FAILED']);
    // 降级必须留下日志，否则线上只能看到「少了个指标」
    expect(logger.entries.some((e) => e.level === 'error')).toBe(true);
  });

  it('探活失败时该 adapter 被跳过并记 warning', async () => {
    const result = await collect(
      options([
        fakeCollector({ id: 'lighthouse', unavailable: true }),
        fakeCollector({ id: 'web-vitals', samples: [{ name: 'INP', value: 200 }] }),
      ]),
    );

    expect(codes(result.warnings)).toEqual(['ADAPTER_UNAVAILABLE']);
    expect(result.metrics.map((m) => m.name)).toEqual(['INP']);
    // 被跳过不算 failed：它没有失败，只是没参与
    expect(result.failed).toEqual([]);
  });

  it('探活本身抛异常时不把整条链路带崩', async () => {
    const result = await collect(
      options([
        fakeCollector({ id: 'lighthouse', probeThrows: true }),
        fakeCollector({ id: 'web-vitals', samples: [{ name: 'INP', value: 200 }] }),
      ]),
    );

    expect(codes(result.warnings)).toEqual(['ADAPTER_UNAVAILABLE']);
    expect(result.metrics).toHaveLength(1);
  });

  it('输出无法解析时该来源记 warning，其余来源不受影响', async () => {
    const result = await collect(
      options([
        fakeCollector({ id: 'lighthouse', parseThrows: true, samples: [{ name: 'LCP', value: 1 }] }),
        fakeCollector({ id: 'bundle-analyzer', samples: [{ name: 'JS_SIZE', value: 100 }] }),
      ]),
    );

    expect(result.failed).toEqual(['lighthouse']);
    expect(codes(result.warnings)).toEqual(['ADAPTER_OUTPUT_INVALID']);
    expect(result.metrics.map((m) => m.name)).toEqual(['JS_SIZE']);
  });

  it('全部 adapter 失败时 assertCollectionUsable 抛错（避免「零指标绿灯」）', async () => {
    const result = await collect(
      options([
        fakeCollector({ id: 'lighthouse', collectThrows: true }),
        fakeCollector({ id: 'web-vitals', collectThrows: true }),
      ]),
    );

    expect(result.metrics).toEqual([]);
    expect(result.attempted).toEqual(['lighthouse', 'web-vitals']);
    expect(() => assertCollectionUsable(result)).toThrow(AdapterError);
  });

  it('部分失败时 assertCollectionUsable 放行', async () => {
    const result = await collect(
      options([
        fakeCollector({ id: 'lighthouse', collectThrows: true }),
        fakeCollector({ id: 'web-vitals', samples: [{ name: 'INP', value: 100 }] }),
      ]),
    );

    expect(() => assertCollectionUsable(result)).not.toThrow();
  });

  it('没有 adapter 时不误判为全部失败', async () => {
    const result = await collect(options([]));
    expect(() => assertCollectionUsable(result)).not.toThrow();
    expect(result.metrics).toEqual([]);
  });

  it('全部探活失败（一个都没被调用）不算「全部失败」，交由零指标路径处理', async () => {
    const result = await collect(
      options([
        fakeCollector({ id: 'lighthouse', unavailable: true }),
        fakeCollector({ id: 'web-vitals', unavailable: true }),
      ]),
    );

    expect(result.attempted).toEqual([]);
    expect(result.failed).toEqual([]);
    // 分母是 attempted，所以这里不该抛 —— 抛了会掩盖「工具没装」这个真实原因
    expect(() => assertCollectionUsable(result)).not.toThrow();
    expect(result.metrics).toEqual([]);
  });
});

describe('collect — 来源仲裁', () => {
  const lcpFrom = (source: 'lighthouse' | 'web-vitals', value: number) =>
    fakeCollector({ id: source, samples: [{ name: 'LCP' as MetricName, value }] });

  it('同一指标多来源时取优先级最高的（LCP 归 Lighthouse）', async () => {
    const result = await collect(options([lcpFrom('web-vitals', 2800), lcpFrom('lighthouse', 3200)]));

    expect(result.metrics).toHaveLength(1);
    expect(result.metrics[0]?.value).toBe(3200);
    expect(result.metrics[0]?.source).toBe('lighthouse');
    expect(result.warnings).toEqual([]);
  });

  it('首选来源未产出该指标时降级到次选，并记 METRIC_SOURCE_FALLBACK', async () => {
    const result = await collect(options([lcpFrom('web-vitals', 2800)]));

    expect(result.metrics[0]?.source).toBe('web-vitals');
    expect(codes(result.warnings)).toEqual(['METRIC_SOURCE_FALLBACK']);
    // 跨次对比的读者必须被明确告知来源变了
    expect(result.warnings[0]?.message).toContain('LCP');
  });

  it('INP 的首选来源是 web-vitals（实验室测不准交互延迟）', async () => {
    const result = await collect(
      options([
        fakeCollector({ id: 'web-vitals', samples: [{ name: 'INP', value: 180 }] }),
        fakeCollector({ id: 'lighthouse', samples: [{ name: 'INP', value: 420 }] }),
      ]),
    );

    expect(result.metrics[0]?.value).toBe(180);
    expect(result.warnings).toEqual([]);
  });
});

describe('collect — 产物与上下文', () => {
  it('产物原样透传，供 M2 下钻取证', async () => {
    const result = await collect(
      options([fakeCollector({ id: 'lighthouse', samples: [{ name: 'LCP', value: 3000 }] })]),
    );

    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]?.adapter).toBe('lighthouse');
    expect(result.artifacts[0]?.route).toBe('/');
  });

  it('没有样本的 adapter 不产出产物也不报错', async () => {
    const result = await collect(options([fakeCollector({ id: 'lighthouse' })]));
    expect(result.artifacts).toEqual([]);
    expect(result.metrics).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('指标带上 route 与 device，多路由报告不会串数据', async () => {
    const result = await collect({
      ...base,
      route: '/dashboard',
      device: 'desktop',
      collectors: [fakeCollector({ id: 'lighthouse', samples: [{ name: 'LCP', value: 2000 }] })],
      logger: createMemoryLogger(),
    });

    expect(result.metrics[0]?.route).toBe('/dashboard');
    expect(result.metrics[0]?.device).toBe('desktop');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 多轮采集（collect.runs）
// ─────────────────────────────────────────────────────────────────────

/**
 * 性能指标天然有抖动，而门禁判的是**差值** —— 单轮的抖动会被读成"回归"。
 * 这一组验的是 `collect.runs > 1` 时逐指标取中位数。
 */
describe('collect — 多轮采集取中位数', () => {
  /** 每轮返回不同的值，模拟测量抖动 */
  function flakyCollector(values: number[]): Parameters<typeof collect>[0]['collectors'][number] {
    let call = 0;
    return {
      id: 'lighthouse',
      isAvailable: async () => true,
      collect: async () => [],
      toMetrics: () => {
        const value = values[Math.min(call, values.length - 1)] ?? 0;
        call += 1;
        return [{ name: 'LCP' as MetricName, value }];
      },
    };
  }

  it('三轮取中位数：极端值被压掉', async () => {
    // 3000 / 3200 / 9000（第三轮被某个后台任务拖慢）
    const result = await collect({
      ...base,
      runs: 3,
      collectors: [flakyCollector([3000, 3200, 9000])],
      logger: createMemoryLogger(),
    });

    // 中位数是 3200，而不是平均后的 5066
    expect(result.metrics[0]?.value).toBe(3200);
    expect(result.completedRuns).toBe(3);
  });

  it('两轮取中间两个的平均值', async () => {
    const result = await collect({
      ...base,
      runs: 2,
      collectors: [flakyCollector([3000, 3200])],
      logger: createMemoryLogger(),
    });

    expect(result.metrics[0]?.value).toBe(3100);
  });

  it('单轮时不做任何加工（保持既有行为）', async () => {
    const result = await collect({
      ...base,
      collectors: [flakyCollector([3456])],
      logger: createMemoryLogger(),
    });

    expect(result.metrics[0]?.value).toBe(3456);
    expect(result.completedRuns).toBe(1);
  });

  it('某个来源只在一部分轮次里成功时，仍按它自己的样本取中位数', async () => {
    let call = 0;
    const flaky: Parameters<typeof collect>[0]['collectors'][number] = {
      id: 'web-vitals',
      isAvailable: async () => true,
      collect: async () => {
        call += 1;
        // 第二轮挂掉
        if (call === 2) throw new Error('端点没起来');
        return [];
      },
      toMetrics: () => [{ name: 'INP' as MetricName, value: call === 1 ? 150 : 250 }],
    };

    /**
     * 必须再配一个**始终成功**的来源。
     *
     * 只有 web-vitals 一个来源时，它挂掉的那一轮就是"全军覆没"，
     * 而全军覆没会让多轮提前结束（那是设计：多轮用于降噪，不用于重试）。
     * 有了 lighthouse 兜底，第二轮才算"部分失败"，轮次才会继续。
     */
    const result = await collect({
      ...base,
      runs: 3,
      collectors: [
        fakeCollector({ id: 'lighthouse', samples: [{ name: 'LCP', value: 3000 }] }),
        flaky,
      ],
      logger: createMemoryLogger(),
    });

    // 成功的是第 1、3 轮（150 / 250）→ 中位数 200；失败的那轮不参与
    const inp = result.metrics.find((m) => m.name === 'INP');
    expect(inp?.value).toBe(200);
    expect(result.completedRuns).toBe(3);
    expect(result.failed).toContain('web-vitals');
    // 始终成功的那个来源不受影响
    expect(result.metrics.find((m) => m.name === 'LCP')?.value).toBe(3000);
  });

  it('某一轮全军覆没时不再跑剩余轮次（多轮是降噪，不是重试）', async () => {
    const result = await collect({
      ...base,
      runs: 5,
      collectors: [fakeCollector({ id: 'lighthouse', collectThrows: true })],
      logger: createMemoryLogger(),
    });

    // 只跑了 1 轮就该停：工具挂了，再跑 4 次只是把同样的失败重复 4 遍
    expect(result.completedRuns).toBe(0);
    expect(codes(result.warnings)).toContain('ADAPTER_FAILED');
    const skipWarning = result.warnings.find((w) => w.message.includes('跳过剩余'));
    expect(skipWarning?.message).toContain('4 轮');
  });

  it('跨轮重复的告警被去重（不会出现 N 条一模一样的）', async () => {
    const result = await collect({
      ...base,
      runs: 3,
      collectors: [fakeCollector({ id: 'lighthouse', collectThrows: true })],
      logger: createMemoryLogger(),
    });

    const failures = result.warnings.filter((w) => w.code === 'ADAPTER_FAILED');
    // 一条"采集失败" + 一条"跳过剩余轮次"，而不是 3 条采集失败
    expect(failures.length).toBeLessThanOrEqual(2);
  });

  it('多轮之间串行执行，不并发（并发会争抢 CPU 让数字失真）', async () => {
    let inFlight = 0;
    let maxInFlight = 0;

    const serial: Parameters<typeof collect>[0]['collectors'][number] = {
      id: 'lighthouse',
      isAvailable: async () => true,
      collect: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return [];
      },
      toMetrics: () => [{ name: 'LCP' as MetricName, value: 3000 }],
    };

    await collect({ ...base, runs: 3, collectors: [serial], logger: createMemoryLogger() });

    // 轮次之间必须是串行的：同一时刻只有一个采集在跑
    expect(maxInFlight).toBe(1);
  });
});
