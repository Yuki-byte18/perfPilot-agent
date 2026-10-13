import { describe, expect, it } from 'vitest';
import { ValidationError } from '@yuki-byte18/shared';
import { artifact, lighthouseFixture } from '../fixtures/index.js';
import { parseLighthouse, samplesFromResult, lighthouseVersionOf } from './parse.js';
import type { LighthouseResult } from './schema.js';

const asResult = (raw: unknown): LighthouseResult => raw as LighthouseResult;

const collect = (raw: unknown, route = '/') =>
  parseLighthouse([artifact('lighthouse', 'lighthouse-result', raw, { route })]);

describe('parseLighthouse — 指标提取', () => {
  it('从 audits 提取全部实验室指标', () => {
    const samples = collect(lighthouseFixture());
    const byName = Object.fromEntries(samples.map((s) => [s.name, s.value]));

    expect(byName.LCP).toBe(3800);
    expect(byName.CLS).toBe(0.18);
    expect(byName.FCP).toBe(2100);
    expect(byName.TTFB).toBe(720);
    expect(byName.TBT).toBe(480);
    expect(byName.SI).toBe(4100);
    expect(byName.TRANSFER_SIZE).toBe(2_450_000);
  });

  it('体积类指标取 resourceSize（解码后）而不是 transferSize', () => {
    const samples = collect(
      lighthouseFixture({ scriptSize: 486_000, styleSize: 92_000, imageSize: 1_320_000 }),
    );
    const byName = Object.fromEntries(samples.map((s) => [s.name, s.value]));

    expect(byName.JS_SIZE).toBe(486_000);
    expect(byName.CSS_SIZE).toBe(92_000);
    expect(byName.IMAGE_SIZE).toBe(1_320_000);
  });

  it('请求数取 resource-summary 的 total 行', () => {
    const samples = collect(lighthouseFixture({ requests: 68 }));
    expect(samples.find((s) => s.name === 'REQUEST_COUNT')?.value).toBe(68);
  });

  it('INP 缺失时不产出该样本，而不是报 0', () => {
    const samples = collect(lighthouseFixture({ inp: null }));
    expect(samples.some((s) => s.name === 'INP')).toBe(false);
    // 其余指标不受影响
    expect(samples.some((s) => s.name === 'LCP')).toBe(true);
  });

  it('实验性 INP 审计存在时会被采集（Lighthouse 12+）', () => {
    const samples = collect(lighthouseFixture({ inp: 260 }));
    expect(samples.find((s) => s.name === 'INP')?.value).toBe(260);
  });

  it('旧版审计名 interaction-to-next-paint 同样识别', () => {
    const fixture = lighthouseFixture({ inp: null }) as { audits: Record<string, unknown> };
    fixture.audits['interaction-to-next-paint'] = { numericValue: 310 };
    const samples = collect(fixture);

    expect(samples.find((s) => s.name === 'INP')?.value).toBe(310);
  });

  it('审计项存在但 numericValue 非有限值时跳过', () => {
    const fixture = lighthouseFixture() as { audits: Record<string, unknown> };
    fixture.audits['largest-contentful-paint'] = { numericValue: Number.NaN };
    const samples = collect(fixture);

    expect(samples.some((s) => s.name === 'LCP')).toBe(false);
  });

  it('resource-summary 缺失时体积类指标全部不产出（而不是 0）', () => {
    const samples = collect(lighthouseFixture({ omitResourceSummary: true }));
    for (const name of ['JS_SIZE', 'CSS_SIZE', 'IMAGE_SIZE', 'REQUEST_COUNT']) {
      expect(samples.some((s) => s.name === name)).toBe(false);
    }
    expect(samples.some((s) => s.name === 'LCP')).toBe(true);
  });

  it('同一资源类型的多个条目会被累加而不是只取首项', () => {
    const fixture = lighthouseFixture() as { audits: Record<string, unknown> };
    (fixture.audits['resource-summary'] as { details: { items: unknown[] } }).details.items = [
      { resourceType: 'script', resourceSize: 100_000, requestCount: 2 },
      { resourceType: 'script', resourceSize: 250_000, requestCount: 5 },
      { resourceType: 'total', resourceSize: 350_000, requestCount: 7 },
    ];
    const samples = collect(fixture);

    expect(samples.find((s) => s.name === 'JS_SIZE')?.value).toBe(350_000);
  });

  it('total 行缺失时请求数退回逐行累加', () => {
    const fixture = lighthouseFixture() as { audits: Record<string, unknown> };
    (fixture.audits['resource-summary'] as { details: { items: unknown[] } }).details.items = [
      { resourceType: 'script', resourceSize: 100_000, requestCount: 2 },
      { resourceType: 'image', resourceSize: 50_000, requestCount: 5 },
    ];
    const samples = collect(fixture);

    expect(samples.find((s) => s.name === 'REQUEST_COUNT')?.value).toBe(7);
  });

  it('体积条目既无 resourceSize 也无 transferSize 时不产出该指标', () => {
    const fixture = lighthouseFixture() as { audits: Record<string, unknown> };
    (fixture.audits['resource-summary'] as { details: { items: unknown[] } }).details.items = [
      { resourceType: 'script', requestCount: 3 },
      { resourceType: 'total', requestCount: 3 },
    ];
    const samples = collect(fixture);

    expect(samples.some((s) => s.name === 'JS_SIZE')).toBe(false);
    expect(samples.find((s) => s.name === 'REQUEST_COUNT')?.value).toBe(3);
  });
});

describe('parseLighthouse — 输入校验与多产物', () => {
  it('完全无法识别的输出抛 ValidationError（code=ADAPTER_OUTPUT_INVALID）', () => {
    try {
      collect({ not: 'lighthouse' });
      throw new Error('应当抛出');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).code).toBe('ADAPTER_OUTPUT_INVALID');
      expect((err as ValidationError).stage).toBe('collect');
    }
  });

  it('非对象输入同样被拒绝', () => {
    expect(() => collect('a string')).toThrow(ValidationError);
    expect(() => collect(null)).toThrow(ValidationError);
  });

  it('忽略其它 adapter 的产物', () => {
    const samples = parseLighthouse([
      artifact('web-vitals', 'web-vitals', { metrics: { LCP: 1 } }),
      artifact('lighthouse', 'lighthouse-result', lighthouseFixture()),
    ]);
    expect(samples.length).toBeGreaterThan(0);
  });

  it('忽略 kind 不匹配的产物', () => {
    const samples = parseLighthouse([
      artifact('lighthouse', 'something-else', lighthouseFixture()),
    ]);
    expect(samples).toEqual([]);
  });

  it('多份产物会合并', () => {
    const samples = parseLighthouse([
      artifact('lighthouse', 'lighthouse-result', lighthouseFixture()),
      artifact('lighthouse', 'lighthouse-result', lighthouseFixture({ lcp: 1200 })),
    ]);
    expect(samples.filter((s) => s.name === 'LCP')).toHaveLength(2);
  });
});

describe('samplesFromResult / lighthouseVersionOf', () => {
  it('未被识别的额外审计项不影响解析', () => {
    const fixture = lighthouseFixture() as { audits: Record<string, unknown> };
    fixture.audits['unused-javascript'] = { numericValue: 999, details: { items: [] } };
    const samples = samplesFromResult(asResult(fixture));

    expect(samples.find((s) => s.name === 'LCP')?.value).toBe(3800);
  });

  it('能读出 Lighthouse 版本，用于解释跨次分数变化', () => {
    expect(lighthouseVersionOf([artifact('lighthouse', 'lighthouse-result', lighthouseFixture())]))
      .toBe('12.2.1');
  });

  it('无产物时版本为 null', () => {
    expect(lighthouseVersionOf([])).toBeNull();
  });
});
