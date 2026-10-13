import { describe, expect, it } from 'vitest';
import { ValidationError } from '@yuki-byte18/shared';
import { artifact, webVitalsFixture } from '../fixtures/index.js';
import { parseWebVitals, samplesFromReport, unexpectedMetricNames } from './parse.js';
import type { WebVitalsReport } from './schema.js';

const asReport = (raw: unknown): WebVitalsReport => raw as WebVitalsReport;

describe('parseWebVitals', () => {
  it('提取上报中的现场指标', () => {
    const samples = parseWebVitals([
      artifact('web-vitals', 'web-vitals', webVitalsFixture({ lcp: 3100, cls: 0.14, inp: 240 })),
    ]);
    const byName = Object.fromEntries(samples.map((s) => [s.name, s.value]));

    expect(byName.LCP).toBe(3100);
    expect(byName.CLS).toBe(0.14);
    expect(byName.INP).toBe(240);
    expect(byName.FCP).toBe(1900);
    expect(byName.TTFB).toBe(690);
  });

  it('兼容裸数字写法 { LCP: 2800 }', () => {
    const samples = parseWebVitals([
      artifact('web-vitals', 'web-vitals', { metrics: { LCP: 2800, INP: 150 } }),
    ]);
    const byName = Object.fromEntries(samples.map((s) => [s.name, s.value]));

    expect(byName.LCP).toBe(2800);
    expect(byName.INP).toBe(150);
  });

  it('INP 缺失时只产出其余指标', () => {
    const samples = parseWebVitals([
      artifact('web-vitals', 'web-vitals', webVitalsFixture({ inp: null })),
    ]);
    expect(samples.some((s) => s.name === 'INP')).toBe(false);
    expect(samples.some((s) => s.name === 'LCP')).toBe(true);
  });

  it('忽略不认识的键（如构建产物指标被误上报）', () => {
    const samples = parseWebVitals([
      artifact(
        'web-vitals',
        'web-vitals',
        webVitalsFixture({ extra: { JS_SIZE: 999_999, MADE_UP: 1 } }),
      ),
    ]);
    expect(samples.some((s) => s.name === 'JS_SIZE')).toBe(false);
  });

  it('unexpectedMetricNames 报出「认识但不该由 web-vitals 产出」的指标', () => {
    const report = asReport(webVitalsFixture({ extra: { JS_SIZE: 1, IMAGE_SIZE: 2, NOPE: 3 } }));
    expect(unexpectedMetricNames(report).sort()).toEqual(['IMAGE_SIZE', 'JS_SIZE']);
  });

  it('值非有限时跳过该指标', () => {
    const samples = samplesFromReport(
      asReport({ metrics: { LCP: { value: Number.POSITIVE_INFINITY }, CLS: 0.1 } }),
    );
    expect(samples.map((s) => s.name)).toEqual(['CLS']);
  });

  it('值为 null 时不产出样本', () => {
    const samples = samplesFromReport(asReport({ metrics: { LCP: null, CLS: 0.2 } }));
    expect(samples.map((s) => s.name)).toEqual(['CLS']);
  });

  it('负载结构非法时抛 ValidationError', () => {
    expect(() =>
      parseWebVitals([artifact('web-vitals', 'web-vitals', { notMetrics: true })]),
    ).toThrow(ValidationError);
  });

  it('metrics 里的值类型错误时抛 ValidationError', () => {
    expect(() =>
      parseWebVitals([artifact('web-vitals', 'web-vitals', { metrics: { LCP: 'slow' } })]),
    ).toThrow(ValidationError);
  });

  it('空 metrics 返回空数组而不报错', () => {
    expect(parseWebVitals([artifact('web-vitals', 'web-vitals', { metrics: {} })])).toEqual([]);
  });
});
