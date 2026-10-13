import { describe, expect, it } from 'vitest';
import { ValidationError } from '@yuki-byte18/shared';
import { artifact, bundleFixture, DEFAULT_DUPLICATE_MODULES } from '../fixtures/index.js';
import { parseBundleScan, samplesFromScan, duplicateDetailsOf } from './parse.js';
import type { BundleScanPayload } from './schema.js';

const asScan = (raw: unknown): BundleScanPayload => raw as BundleScanPayload;

const collect = (raw: unknown) => parseBundleScan([artifact('bundle-analyzer', 'bundle-scan', raw)]);

describe('parseBundleScan — 体积统计', () => {
  it('按扩展名汇总 JS / CSS / 图片体积', () => {
    const samples = collect(bundleFixture({ jsSize: 512_000, cssSize: 84_000, imageSize: 1_180_000 }));
    const byName = Object.fromEntries(samples.map((s) => [s.name, s.value]));

    expect(byName.JS_SIZE).toBeCloseTo(512_000, 0);
    expect(byName.CSS_SIZE).toBe(84_000);
    expect(byName.IMAGE_SIZE).toBeCloseTo(1_180_000, 0);
  });

  it('.mjs / .cjs 计入 JS，.svg 计入图片', () => {
    const samples = samplesFromScan(
      asScan({
        distDir: 'dist',
        source: 'scan',
        files: [
          { path: 'a.mjs', size: 100 },
          { path: 'b.cjs', size: 200 },
          { path: 'c.svg', size: 300 },
        ],
        modules: [],
      }),
    );
    const byName = Object.fromEntries(samples.map((s) => [s.name, s.value]));

    expect(byName.JS_SIZE).toBe(300);
    expect(byName.IMAGE_SIZE).toBe(300);
  });

  it('无匹配文件时不产出该指标，而不是报 0', () => {
    const samples = samplesFromScan(
      asScan({ distDir: 'dist', source: 'scan', files: [{ path: 'index.html', size: 100 }], modules: [] }),
    );
    expect(samples).toEqual([]);
  });

  it('查询串不影响扩展名识别', () => {
    const samples = samplesFromScan(
      asScan({ distDir: 'd', source: 'scan', files: [{ path: 'a.js?v=1', size: 500 }], modules: [] }),
    );
    expect(samples.find((s) => s.name === 'JS_SIZE')?.value).toBe(500);
  });
});

describe('parseBundleScan — 重复依赖', () => {
  it('stats 来源时统计重复安装的包数量', () => {
    const samples = collect(bundleFixture());
    // fixtures 里 lodash 被两处安装
    expect(samples.find((s) => s.name === 'DUPLICATE_DEPS')?.value).toBe(1);
  });

  it('scan 来源时不产出 DUPLICATE_DEPS（拿不到模块图）', () => {
    const samples = collect(bundleFixture({ source: 'scan', modules: DEFAULT_DUPLICATE_MODULES }));
    expect(samples.some((s) => s.name === 'DUPLICATE_DEPS')).toBe(false);
  });

  it('无重复时空数组模块图产出 0（这是「确实没有重复」而非「没测」）', () => {
    const samples = collect(
      bundleFixture({
        source: 'stats',
        modules: [{ name: './node_modules/.pnpm/react@18.3.1/node_modules/react/index.js', size: 100 }],
      }),
    );
    expect(samples.find((s) => s.name === 'DUPLICATE_DEPS')?.value).toBe(0);
  });

  it('duplicateDetailsOf 给出具体包名与份数，供 M2 归因', () => {
    const details = duplicateDetailsOf([
      artifact('bundle-analyzer', 'bundle-scan', bundleFixture()),
    ]);
    expect(details).toHaveLength(1);
    expect(details[0]?.name).toBe('lodash');
    expect(details[0]?.copies).toBe(2);
    expect(details[0]?.versions).toEqual(['4.17.21']); // 嵌套安装那处无版本号，不贡献版本
  });
});

describe('parseBundleScan — 校验', () => {
  it('负载结构非法时抛 ValidationError', () => {
    expect(() => collect({ distDir: 'dist' })).toThrow(ValidationError);
  });

  it('source 取值非法时抛 ValidationError', () => {
    expect(() =>
      collect({ distDir: 'dist', source: 'guess', files: [], modules: [] }),
    ).toThrow(ValidationError);
  });

  it('负体积被拒绝', () => {
    expect(() =>
      collect({
        distDir: 'dist',
        source: 'scan',
        files: [{ path: 'a.js', size: -1 }],
        modules: [],
      }),
    ).toThrow(ValidationError);
  });

  it('modules 缺失时默认为空数组（stats.json 可能只给了文件列表）', () => {
    const samples = collect({ distDir: 'dist', source: 'stats', files: [{ path: 'a.js', size: 10 }] });
    expect(samples.find((s) => s.name === 'JS_SIZE')?.value).toBe(10);
  });
});
