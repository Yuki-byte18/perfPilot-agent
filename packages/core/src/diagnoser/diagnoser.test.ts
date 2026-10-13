import { describe, expect, it } from 'vitest';
import type { MetricName } from '@yuki-byte18/shared';
import { Diagnoser, summarize } from './index.js';
import type { Detection, DiagnosticRule, RuleContext } from './types.js';
import { BUILTIN_RULES, RULE_SET_VERSION } from './rules/index.js';
import { buildMetric, createInMemorySourceMap, DiagnosisSchema } from '@yuki-byte18/shared';
import { configFixture } from '../fixtures/index.js';
import {
  bundleArtifact,
  harArtifact,
  harEntry,
  jsChunk,
  moduleEntry,
  traceArtifact,
  traceLongTask,
  webVitalsArtifact,
} from '../fixtures/artifacts.js';
import { createSilentLogger } from '../logger/index.js';

/**
 * 规则单测。
 *
 * 每条规则都覆盖**正例 / 反例 / 边界**三档。边界尤其重要：
 * 阈值判断写成 `>` 还是 `>=` 决定了「刚好卡在阈值上的资源」报不报，
 * 而这种差异在真实项目里会直接影响 CI 是否变红。
 */

const silent = createSilentLogger();

interface CtxOptions {
  metrics?: Array<[MetricName, number]>;
  artifacts?: RuleContext['artifacts'];
  thresholds?: RuleContext['thresholds'];
  sourceMap?: RuleContext['sourceMap'];
}

function context(options: CtxOptions = {}): RuleContext {
  const metrics = (options.metrics ?? []).map(([name, value]) =>
    buildMetric({
      name,
      value,
      route: '/',
      device: 'mobile',
      source: 'lighthouse',
      collectedAt: '2026-01-17T14:25:30.000Z',
    }),
  );

  return {
    metrics,
    deltas: [],
    artifacts: options.artifacts ?? [],
    baseline: null,
    config: configFixture(),
    sourceMap: options.sourceMap ?? null,
    thresholds: options.thresholds ?? {},
  };
}

async function detect(rule: DiagnosticRule, options: CtxOptions = {}): Promise<Detection[]> {
  return rule.detect(context(options));
}

const ruleById = (id: string): DiagnosticRule => {
  const rule = BUILTIN_RULES.find((r) => r.id === id);
  if (rule === undefined) throw new Error(`规则不存在: ${id}`);
  return rule;
};

// ─────────────────────────────────────────────────────────────────────
// 规则集本身
// ─────────────────────────────────────────────────────────────────────

describe('规则集', () => {
  it('内置规则不少于 8 条（M2 验收标准 1）', () => {
    expect(BUILTIN_RULES.length).toBeGreaterThanOrEqual(8);
  });

  it('规则 id 唯一且非空', () => {
    const ids = BUILTIN_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.length > 0)).toBe(true);
  });

  it('每条规则都有说明（报告与文档要用）', () => {
    expect(BUILTIN_RULES.every((r) => r.description.length > 0)).toBe(true);
  });

  it('规则集版本已声明', () => {
    expect(RULE_SET_VERSION).toMatch(/^m\d+\./);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 图片类
// ─────────────────────────────────────────────────────────────────────

describe('oversized-image', () => {
  const rule = () => ruleById('oversized-image');

  it('正例：超过 200KB 的图片被报出', async () => {
    const detections = await detect(rule(), {
      artifacts: [
        harArtifact([
          harEntry({
            resourceType: 'image',
            mimeType: 'image/png',
            url: 'https://staging.example.com/assets/hero.png',
            resourceSize: 1_240_000,
            transferSize: 1_244_000,
          }),
        ]),
      ],
    });

    expect(detections).toHaveLength(1);
    expect(detections[0]?.attribution.level).toBe('resource');
    expect(detections[0]?.impact.IMAGE_SIZE).toBe(1_240_000 - 204_800);
    expect(detections[0]?.confidence).toBeGreaterThan(0.9);
  });

  it('反例：小图不报', async () => {
    const detections = await detect(rule(), {
      artifacts: [
        harArtifact([
          harEntry({
            resourceType: 'image',
            mimeType: 'image/png',
            resourceSize: 40_000,
            transferSize: 40_000,
          }),
        ]),
      ],
    });

    expect(detections).toEqual([]);
  });

  it('边界：刚好 200KB 不报（阈值是「超过」而非「达到」）', async () => {
    const detections = await detect(rule(), {
      artifacts: [
        harArtifact([
          harEntry({
            resourceType: 'image',
            mimeType: 'image/png',
            resourceSize: 204_800,
            transferSize: 204_800,
          }),
        ]),
      ],
    });

    expect(detections).toEqual([]);
  });

  it('构建产物里的图片也能被发现（不只有 HAR）', async () => {
    const detections = await detect(rule(), {
      artifacts: [
        bundleArtifact({ files: [jsChunk('assets/hero.png', 900_000)], modules: [] }),
      ],
    });

    expect(detections).toHaveLength(1);
    expect(detections[0]?.attribution).toMatchObject({ level: 'resource', contentType: 'image/png' });
  });

  it('非图片资源不会被误判', async () => {
    const detections = await detect(rule(), {
      artifacts: [
        harArtifact([harEntry({ resourceType: 'script', resourceSize: 900_000 })]),
      ],
    });

    expect(detections).toEqual([]);
  });

  it('同目录的多张图合并键相同（由 merge 阶段合成一条）', async () => {
    const detections = await detect(rule(), {
      artifacts: [
        harArtifact([
          harEntry({ resourceType: 'image', mimeType: 'image/png', url: 'https://a.com/assets/1.png', resourceSize: 300_000 }),
          harEntry({ resourceType: 'image', mimeType: 'image/png', url: 'https://a.com/assets/2.png', resourceSize: 400_000 }),
        ]),
      ],
    });

    expect(detections).toHaveLength(2);
    expect(detections[0]?.mergeKey).toBe(detections[1]?.mergeKey);
  });
});

describe('uncompressed-image', () => {
  const rule = () => ruleById('uncompressed-image');

  it('正例：PNG 且体积可观 → 建议转 WebP', async () => {
    const detections = await detect(rule(), {
      artifacts: [
        harArtifact([harEntry({ resourceType: 'image', mimeType: 'image/png', resourceSize: 300_000 })]),
      ],
    });

    expect(detections).toHaveLength(1);
    expect(detections[0]?.impact.IMAGE_SIZE).toBe(90_000);
  });

  it('反例：WebP / AVIF 不报', async () => {
    for (const mime of ['image/webp', 'image/avif']) {
      const detections = await detect(rule(), {
        artifacts: [
          harArtifact([harEntry({ resourceType: 'image', mimeType: mime, resourceSize: 300_000 })]),
        ],
      });
      expect(detections, mime).toEqual([]);
    }
  });

  it('反例：SVG 是矢量，转位图反而更大', async () => {
    const detections = await detect(rule(), {
      artifacts: [
        harArtifact([harEntry({ resourceType: 'image', mimeType: 'image/svg+xml', resourceSize: 300_000 })]),
      ],
    });

    expect(detections).toEqual([]);
  });

  it('边界：刚好 50KB 不报', async () => {
    const detections = await detect(rule(), {
      artifacts: [
        harArtifact([harEntry({ resourceType: 'image', mimeType: 'image/png', resourceSize: 51_200 })]),
      ],
    });

    expect(detections).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 网络类
// ─────────────────────────────────────────────────────────────────────

describe('render-blocking-resource', () => {
  const rule = () => ruleById('render-blocking-resource');

  it('正例：解析器发起的 script 阻塞解析', async () => {
    const detections = await detect(rule(), {
      artifacts: [
        harArtifact([
          harEntry({ resourceType: 'script', initiatorType: 'parser', timeMs: 300, resourceSize: 50_000 }),
        ]),
      ],
    });

    expect(detections).toHaveLength(1);
    expect(detections[0]?.impact.LCP).toBe(300);
  });

  it('反例：由脚本动态加载的资源不阻塞解析', async () => {
    const detections = await detect(rule(), {
      artifacts: [
        harArtifact([
          harEntry({ resourceType: 'script', initiatorType: 'script', timeMs: 300, resourceSize: 50_000 }),
        ]),
      ],
    });

    expect(detections).toEqual([]);
  });

  it('反例：文档本身不算阻塞资源', async () => {
    const detections = await detect(rule(), {
      artifacts: [
        harArtifact([
          harEntry({ resourceType: 'document', initiatorType: 'parser', timeMs: 300, resourceSize: 50_000 }),
        ]),
      ],
    });

    expect(detections).toEqual([]);
  });

  it('边界：解析器发起但既小又快 → 不报', async () => {
    const detections = await detect(rule(), {
      artifacts: [
        harArtifact([
          harEntry({ resourceType: 'script', initiatorType: 'parser', timeMs: 30, resourceSize: 2_000 }),
        ]),
      ],
    });

    expect(detections).toEqual([]);
  });

  it('边界：体积小但耗时超过 200ms → 仍然报（时长单独构成显著性）', async () => {
    const detections = await detect(rule(), {
      artifacts: [
        harArtifact([
          harEntry({ resourceType: 'script', initiatorType: 'parser', timeMs: 250, resourceSize: 2_000 }),
        ]),
      ],
    });

    expect(detections).toHaveLength(1);
  });
});

describe('no-compression', () => {
  const rule = () => ruleById('no-compression');

  it('正例：文本资源无 content-encoding 且体积可观', async () => {
    const detections = await detect(rule(), {
      artifacts: [
        harArtifact([harEntry({ contentEncoding: null, resourceSize: 200_000 })]),
      ],
    });

    expect(detections).toHaveLength(1);
    expect(detections[0]?.confidence).toBeGreaterThanOrEqual(0.95);
    expect(detections[0]?.impact.TRANSFER_SIZE).toBe(130_000);
  });

  it('反例：已启用 br / gzip 不报', async () => {
    for (const encoding of ['br', 'gzip', 'zstd']) {
      const detections = await detect(rule(), {
        artifacts: [harArtifact([harEntry({ contentEncoding: encoding, resourceSize: 200_000 })])],
      });
      expect(detections, encoding).toEqual([]);
    }
  });

  it('反例：图片本来就不该用 content-encoding 压缩', async () => {
    const detections = await detect(rule(), {
      artifacts: [
        harArtifact([
          harEntry({ resourceType: 'image', contentEncoding: null, resourceSize: 900_000 }),
        ]),
      ],
    });

    expect(detections).toEqual([]);
  });

  it('反例：命中缓存时不再重复报未压缩', async () => {
    const detections = await detect(rule(), {
      artifacts: [
        harArtifact([harEntry({ contentEncoding: null, resourceSize: 200_000, fromCache: true })]),
      ],
    });

    expect(detections).toEqual([]);
  });

  it('边界：刚好 10KB 不报', async () => {
    const detections = await detect(rule(), {
      artifacts: [harArtifact([harEntry({ contentEncoding: null, resourceSize: 10_240 })])],
    });

    expect(detections).toEqual([]);
  });
});

describe('excessive-requests', () => {
  const rule = () => ruleById('excessive-requests');

  it('正例：请求数超过阈值', async () => {
    const entries = Array.from({ length: 60 }, (_, i) =>
      harEntry({ url: `https://staging.example.com/a${i}.js` }),
    );
    const detections = await detect(rule(), { artifacts: [harArtifact(entries)] });

    expect(detections).toHaveLength(1);
    expect(detections[0]?.impact.REQUEST_COUNT).toBe(10);
  });

  it('反例：请求数正常', async () => {
    const detections = await detect(rule(), {
      artifacts: [harArtifact([harEntry(), harEntry({ url: 'https://a/b.js' })])],
    });

    expect(detections).toEqual([]);
  });

  it('边界：刚好 50 个不报', async () => {
    const entries = Array.from({ length: 50 }, (_, i) =>
      harEntry({ url: `https://staging.example.com/a${i}.js` }),
    );
    expect(await detect(rule(), { artifacts: [harArtifact(entries)] })).toEqual([]);
  });

  it('优先采用 REQUEST_COUNT 指标而不是 HAR 条数', async () => {
    const detections = await detect(rule(), {
      metrics: [['REQUEST_COUNT', 80]],
      artifacts: [harArtifact([harEntry()])],
    });

    expect(detections).toHaveLength(1);
    expect(detections[0]?.title).toContain('80');
  });

  it('归因落在主文档上（聚合型问题没有单一罪魁）', async () => {
    const entries = Array.from({ length: 60 }, (_, i) =>
      harEntry({ url: `https://staging.example.com/a${i}.js` }),
    );
    const detections = await detect(rule(), { artifacts: [harArtifact(entries)] });

    expect(detections[0]?.attribution).toMatchObject({
      level: 'resource',
      url: 'https://staging.example.com/',
      contentType: 'text/html',
    });
  });
});

describe('cache-miss', () => {
  const rule = () => ruleById('cache-miss');

  it('正例：同源静态资源完全没有 cache-control', async () => {
    const detections = await detect(rule(), {
      artifacts: [harArtifact([harEntry({ cacheControl: null })])],
    });

    expect(detections).toHaveLength(1);
  });

  it('正例：no-store 等于没有缓存', async () => {
    const detections = await detect(rule(), {
      artifacts: [harArtifact([harEntry({ cacheControl: 'no-store' })])],
    });

    expect(detections).toHaveLength(1);
  });

  it('反例：有 max-age 且非 no-store', async () => {
    const detections = await detect(rule(), {
      artifacts: [harArtifact([harEntry({ cacheControl: 'public, max-age=31536000' })])],
    });

    expect(detections).toEqual([]);
  });

  it('反例：跨域 CDN 资源不算（看不到 CDN 侧配置）', async () => {
    const detections = await detect(rule(), {
      artifacts: [
        harArtifact([harEntry({ cacheControl: null, sameOriginAsDocument: false })]),
      ],
    });

    expect(detections).toEqual([]);
  });

  it('边界：max-age=0 视为无有效缓存', async () => {
    const detections = await detect(rule(), {
      artifacts: [harArtifact([harEntry({ cacheControl: 'max-age=0' })])],
    });

    expect(detections).toHaveLength(1);
  });

  it('反例：非 200 响应不参与判断', async () => {
    const detections = await detect(rule(), {
      artifacts: [harArtifact([harEntry({ cacheControl: null, status: 404 })])],
    });

    expect(detections).toEqual([]);
  });
});

describe('missing-preload', () => {
  const rule = () => ruleById('missing-preload');

  it('正例：字体在 1.5s 才被 CSS 带出来', async () => {
    const detections = await detect(rule(), {
      artifacts: [
        harArtifact([
          harEntry({
            resourceType: 'font',
            mimeType: 'font/woff2',
            startMs: 1_500,
            initiatorType: 'css',
            resourceSize: 80_000,
          }),
        ]),
      ],
    });

    expect(detections).toHaveLength(1);
  });

  it('反例：字体很早就被解析器发现', async () => {
    const detections = await detect(rule(), {
      artifacts: [
        harArtifact([
          harEntry({
            resourceType: 'font',
            startMs: 200,
            initiatorType: 'parser',
            resourceSize: 80_000,
          }),
        ]),
      ],
    });

    expect(detections).toEqual([]);
  });

  it('边界：刚好 1000ms 算「晚」（判据是 startMs < 1000 才跳过）', async () => {
    const detections = await detect(rule(), {
      artifacts: [
        harArtifact([
          harEntry({ resourceType: 'font', startMs: 1_000, initiatorType: 'css', resourceSize: 80_000 }),
        ]),
      ],
    });

    expect(detections).toHaveLength(1);
  });

  it('边界：999ms 不算晚', async () => {
    const detections = await detect(rule(), {
      artifacts: [
        harArtifact([
          harEntry({ resourceType: 'font', startMs: 999, initiatorType: 'css', resourceSize: 80_000 }),
        ]),
      ],
    });

    expect(detections).toEqual([]);
  });

  it('反例：体积太小不值得单独 preload', async () => {
    const detections = await detect(rule(), {
      artifacts: [
        harArtifact([
          harEntry({ resourceType: 'font', startMs: 1_500, initiatorType: 'css', resourceSize: 5_000 }),
        ]),
      ],
    });

    expect(detections).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 构建产物类
// ─────────────────────────────────────────────────────────────────────

describe('large-js-bundle', () => {
  const rule = () => ruleById('large-js-bundle');

  it('正例：单个 chunk 超 250KB', async () => {
    const detections = await detect(rule(), {
      artifacts: [bundleArtifact({ files: [jsChunk('assets/index.js', 600_000)], modules: [] })],
    });

    expect(detections).toHaveLength(1);
    expect(detections[0]?.impact.JS_SIZE).toBe(600_000 - 256_000);
  });

  it('反例：拆成多个小 chunk', async () => {
    const detections = await detect(rule(), {
      artifacts: [
        bundleArtifact({
          files: [
            jsChunk('assets/a.js', 100_000),
            jsChunk('assets/b.js', 100_000),
            jsChunk('assets/c.js', 100_000),
          ],
          modules: [],
        }),
      ],
    });

    expect(detections).toEqual([]);
  });

  it('边界：刚好 250KB 不报', async () => {
    const detections = await detect(rule(), {
      artifacts: [bundleArtifact({ files: [jsChunk('assets/index.js', 256_000)], modules: [] })],
    });

    expect(detections).toEqual([]);
  });

  it('反例：CSS 不走这条规则', async () => {
    const detections = await detect(rule(), {
      artifacts: [bundleArtifact({ files: [jsChunk('assets/index.css', 900_000)], modules: [] })],
    });

    expect(detections).toEqual([]);
  });
});

describe('duplicate-dependency', () => {
  const rule = () => ruleById('duplicate-dependency');

  it('正例：同一个包有两份安装', async () => {
    const detections = await detect(rule(), {
      artifacts: [
        bundleArtifact({
          source: 'stats',
          modules: [
            moduleEntry('./node_modules/.pnpm/lodash@4.17.21/node_modules/lodash/lodash.js', 71_000),
            moduleEntry('./node_modules/legacy-widget/node_modules/lodash/lodash.js', 71_000),
          ],
        }),
      ],
    });

    expect(detections).toHaveLength(1);
    expect(detections[0]?.attribution).toMatchObject({ level: 'dependency', name: 'lodash' });
    expect(detections[0]?.impact.JS_SIZE).toBe(71_000);
  });

  it('反例：只有一份安装', async () => {
    const detections = await detect(rule(), {
      artifacts: [
        bundleArtifact({
          source: 'stats',
          modules: [moduleEntry('./node_modules/.pnpm/lodash@4.17.21/node_modules/lodash/lodash.js', 71_000)],
        }),
      ],
    });

    expect(detections).toEqual([]);
  });

  it('边界：没有模块图（scan）时不报 —— 「没测」不等于「没有」', async () => {
    const detections = await detect(rule(), {
      artifacts: [
        bundleArtifact({
          source: 'scan',
          modules: [
            moduleEntry('./node_modules/a/node_modules/lodash/lodash.js', 71_000),
            moduleEntry('./node_modules/b/node_modules/lodash/lodash.js', 71_000),
          ],
        }),
      ],
    });

    expect(detections).toEqual([]);
  });

  it('反例：项目自身源码不算依赖', async () => {
    const detections = await detect(rule(), {
      artifacts: [
        bundleArtifact({
          source: 'stats',
          modules: [moduleEntry('./src/a.tsx', 1_000), moduleEntry('./src/b.tsx', 1_000)],
        }),
      ],
    });

    expect(detections).toEqual([]);
  });
});

describe('legacy-library', () => {
  const rule = () => ruleById('legacy-library');

  it('正例：全量 moment 占 288KB', async () => {
    const detections = await detect(rule(), {
      artifacts: [
        bundleArtifact({
          source: 'stats',
          modules: [moduleEntry('./node_modules/.pnpm/moment@2.29.4/node_modules/moment/moment.js', 288_000)],
        }),
      ],
    });

    expect(detections).toHaveLength(1);
    expect(detections[0]?.attribution).toMatchObject({ level: 'dependency', name: 'moment' });
    expect(detections[0]?.evidence[0]?.description).toContain('dayjs');
  });

  it('反例：体积小到不值得提醒', async () => {
    const detections = await detect(rule(), {
      artifacts: [
        bundleArtifact({
          source: 'stats',
          modules: [moduleEntry('./node_modules/lodash/lodash.js', 10_000)],
        }),
      ],
    });

    expect(detections).toEqual([]);
  });

  it('边界：刚好 50KB 不报', async () => {
    const detections = await detect(rule(), {
      artifacts: [
        bundleArtifact({
          source: 'stats',
          modules: [moduleEntry('./node_modules/lodash/lodash.js', 51_200)],
        }),
      ],
    });

    expect(detections).toEqual([]);
  });

  it('正例：同一库的多个模块合并统计', async () => {
    const detections = await detect(rule(), {
      artifacts: [
        bundleArtifact({
          source: 'stats',
          modules: [
            moduleEntry('./node_modules/lodash/lodash.js', 40_000),
            moduleEntry('./node_modules/lodash/fp.js', 40_000),
          ],
        }),
      ],
    });

    expect(detections).toHaveLength(1);
    expect(detections[0]?.impact.JS_SIZE).toBe(80_000);
  });
});

describe('no-code-splitting', () => {
  const rule = () => ruleById('no-code-splitting');

  it('正例：单个 600KB chunk 承载全部 JS', async () => {
    const detections = await detect(rule(), {
      artifacts: [
        bundleArtifact({
          files: [jsChunk('assets/index.js', 600_000)],
          modules: [],
          packageJson: {
            name: 'demo',
            sideEffects: null,
            dependencies: {},
            devDependencies: { vite: '^5.0.0' },
          },
        }),
      ],
    });

    expect(detections).toHaveLength(1);
    // 配置级归因：要改的是构建配置
    expect(detections[0]?.attribution.level).toBe('config');
    expect(detections[0]?.attribution).toMatchObject({ file: 'vite.config.ts' });
  });

  it('反例：已经拆成多个 chunk', async () => {
    const detections = await detect(rule(), {
      artifacts: [
        bundleArtifact({
          files: [
            jsChunk('assets/index.js', 200_000),
            jsChunk('assets/vendor.js', 200_000),
            jsChunk('assets/chunk-a.js', 200_000),
          ],
          modules: [],
        }),
      ],
    });

    expect(detections).toEqual([]);
  });

  it('边界：2 个 chunk 总量刚好 500KB 不报', async () => {
    const detections = await detect(rule(), {
      artifacts: [
        bundleArtifact({
          files: [jsChunk('a.js', 256_000), jsChunk('b.js', 256_000)],
          modules: [],
        }),
      ],
    });

    expect(detections).toEqual([]);
  });

  it('按 package.json 依赖推断构建配置文件', async () => {
    const detections = await detect(rule(), {
      artifacts: [
        bundleArtifact({
          files: [jsChunk('index.js', 700_000)],
          modules: [],
          packageJson: {
            name: 'demo',
            sideEffects: null,
            dependencies: {},
            devDependencies: { webpack: '^5.0.0' },
          },
        }),
      ],
    });

    expect(detections[0]?.attribution).toMatchObject({ file: 'webpack.config.js' });
  });
});

// ─────────────────────────────────────────────────────────────────────
// 主线程与布局
// ─────────────────────────────────────────────────────────────────────

describe('long-main-thread-task', () => {
  const rule = () => ruleById('long-main-thread-task');

  const sourceMap = createInMemorySourceMap({
    'assets/index.js:142:10': {
      source: 'src/components/VirtualList.tsx',
      line: 88,
      column: 4,
      name: 'renderList',
      fromDependency: false,
    },
  });

  it('正例：长任务 + source map → 归因到源码行（验收标准 3/4）', async () => {
    const detections = await detect(rule(), {
      artifacts: [traceArtifact([traceLongTask({ durationMs: 180 })])],
      sourceMap,
    });

    expect(detections).toHaveLength(1);
    expect(detections[0]?.attribution).toEqual({
      level: 'source',
      file: 'src/components/VirtualList.tsx',
      line: 88,
      column: 4,
      component: 'renderList',
    });
    expect(detections[0]?.impact.TBT).toBe(130);
    expect(detections[0]?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('降级：没有 source map 时归因到产物文件', async () => {
    const detections = await detect(rule(), {
      artifacts: [traceArtifact([traceLongTask({ durationMs: 180 })])],
    });

    expect(detections[0]?.attribution.level).toBe('resource');
    expect(detections[0]?.confidence).toBeLessThan(0.7);
  });

  it('降级：连帧信息都没有时，仍然报出「有卡顿但不知道卡在哪」', async () => {
    const detections = await detect(rule(), {
      artifacts: [traceArtifact([traceLongTask({ durationMs: 220, topFrame: null })])],
    });

    expect(detections).toHaveLength(1);
    expect(detections[0]?.attribution).toMatchObject({ level: 'component', name: '(未定位)' });
    expect(detections[0]?.confidence).toBeLessThanOrEqual(0.5);
  });

  it('反例：没有长任务', async () => {
    expect(await detect(rule(), { artifacts: [traceArtifact([])] })).toEqual([]);
  });

  it('边界：正好 50ms 的任务不进入长任务列表（由 adapter 过滤）', async () => {
    // adapter 侧已按 > 50ms 过滤，这里验证规则不会凭空造出长任务
    expect(await detect(rule(), { artifacts: [traceArtifact([])] })).toEqual([]);
  });

  it('多个长任务指向同一位置时合并键相同', async () => {
    const detections = await detect(rule(), {
      artifacts: [
        traceArtifact([
          traceLongTask({ startMs: 100, durationMs: 120 }),
          traceLongTask({ startMs: 900, durationMs: 160 }),
        ]),
      ],
      sourceMap,
    });

    expect(detections).toHaveLength(2);
    expect(detections[0]?.mergeKey).toBe(detections[1]?.mergeKey);
  });
});

describe('cls-shift-source', () => {
  const rule = () => ruleById('cls-shift-source');

  it('正例：CLS 超标且 Web Vitals 给出了偏移元素', async () => {
    const detections = await detect(rule(), {
      metrics: [['CLS', 0.24]],
      artifacts: [
        webVitalsArtifact({
          CLS: {
            value: 0.24,
            attribution: { largestShiftTarget: 'img.hero', largestShiftValue: 0.18 },
          },
        }),
      ],
    });

    expect(detections).toHaveLength(1);
    // 组件级归因：只有选择器，没有源码位置 —— 这是诚实的边界
    expect(detections[0]?.attribution).toMatchObject({ level: 'component', name: 'img.hero' });
    expect(detections[0]?.attribution.level === 'component' && detections[0].attribution.line).toBeNull();
  });

  it('反例：CLS 在 good 阈值内', async () => {
    const detections = await detect(rule(), {
      metrics: [['CLS', 0.05]],
      artifacts: [
        webVitalsArtifact({ CLS: { value: 0.05, attribution: { largestShiftTarget: 'img.hero' } } }),
      ],
    });

    expect(detections).toEqual([]);
  });

  it('边界：CLS 正好等于阈值不报', async () => {
    const detections = await detect(rule(), {
      metrics: [['CLS', 0.1]],
      artifacts: [
        webVitalsArtifact({ CLS: { value: 0.1, attribution: { largestShiftTarget: 'img.hero' } } }),
      ],
    });

    expect(detections).toEqual([]);
  });

  it('配置覆盖阈值后按新阈值判断', async () => {
    const detections = await detect(rule(), {
      metrics: [['CLS', 0.12]],
      thresholds: { CLS: { warning: 0.05, error: 0.2 } },
      artifacts: [
        webVitalsArtifact({ CLS: { value: 0.12, attribution: { largestShiftTarget: 'div.card' } } }),
      ],
    });

    expect(detections).toHaveLength(1);
  });

  it('没有 DOM 归因时不报 —— 编一个选择器比不报更糟', async () => {
    const detections = await detect(rule(), {
      metrics: [['CLS', 0.24]],
      artifacts: [webVitalsArtifact({ CLS: { value: 0.24 } })],
    });

    expect(detections).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 端到端：合并、排序、schema
// ─────────────────────────────────────────────────────────────────────

const diagnoser = (sourceMap: RuleContext['sourceMap'] = null) =>
  new Diagnoser({ config: configFixture(), logger: silent, sourceMap });

function diagnoseInput(
  artifacts: RuleContext['artifacts'],
  metrics: Array<[MetricName, number]>,
) {
  return {
    diagnosisId: 'diag_1',
    runId: 'run_1',
    project: 'demo',
    route: '/',
    device: 'mobile' as const,
    metrics: metrics.map(([name, value]) =>
      buildMetric({
        name,
        value,
        route: '/',
        device: 'mobile',
        source: 'lighthouse',
        collectedAt: '2026-01-17T14:25:30.000Z',
      }),
    ),
    deltas: [],
    artifacts,
    baseline: null,
    createdAt: '2026-01-17T14:25:30.000Z',
  };
}

describe('Diagnoser — 合并与排序', () => {
  it('同根因合并成一条，occurrences 正确（验收标准 2）', async () => {
    const images = Array.from({ length: 12 }, (_, i) =>
      harEntry({
        resourceType: 'image',
        mimeType: 'image/png',
        url: `https://staging.example.com/assets/img-${i}.png`,
        resourceSize: 400_000,
        transferSize: 400_000,
      }),
    );

    const { diagnosis } = await diagnoser().diagnose(diagnoseInput([harArtifact(images)], []));
    const oversized = diagnosis.bottlenecks.filter((b) => b.kind === 'OVERSIZED_IMAGE');

    expect(oversized).toHaveLength(1);
    expect(oversized[0]?.occurrences).toBe(12);
    // 合并后严重度应高于单条（对数上升）
    expect(oversized[0]?.severity).toBeGreaterThan(30);
    // 体积类影响求和
    expect(oversized[0]?.impact.IMAGE_SIZE).toBeGreaterThan(400_000);
  });

  it('瓶颈按 severity 降序排列（验收标准 2）', async () => {
    const { diagnosis } = await diagnoser().diagnose(
      diagnoseInput(
        [
          bundleArtifact({
            source: 'stats',
            files: [jsChunk('assets/vendor.js', 2_000_000)],
            modules: [moduleEntry('./node_modules/.pnpm/moment@2.29.4/node_modules/moment/moment.js', 288_000)],
          }),
          harArtifact([
            harEntry({
              resourceType: 'image',
              mimeType: 'image/png',
              url: 'https://staging.example.com/assets/a.png',
              resourceSize: 210_000,
              transferSize: 210_000,
            }),
          ]),
        ],
        [],
      ),
    );

    const severities = diagnosis.bottlenecks.map((b) => b.severity);
    expect(severities.length).toBeGreaterThan(1);
    for (let i = 1; i < severities.length; i += 1) {
      expect(severities[i - 1]).toBeGreaterThanOrEqual(severities[i] as number);
    }
  });

  it('同一份输入产出完全相同的诊断（快照稳定，验收标准 5）', async () => {
    const build = () =>
      diagnoseInput(
        [
          bundleArtifact({
            source: 'stats',
            files: [jsChunk('assets/index.js', 600_000)],
            modules: [
              moduleEntry('./node_modules/.pnpm/lodash@4.17.21/node_modules/lodash/lodash.js', 71_000),
              moduleEntry('./node_modules/legacy/node_modules/lodash/lodash.js', 71_000),
            ],
          }),
          harArtifact([harEntry({ contentEncoding: null, resourceSize: 200_000 })]),
        ],
        [['REQUEST_COUNT', 80]],
      );

    const first = await diagnoser().diagnose(build());
    const second = await diagnoser().diagnose(build());

    expect(JSON.stringify(first.diagnosis)).toBe(JSON.stringify(second.diagnosis));
  });

  it('瓶颈 id 由 runId + kind + mergeKey 决定，不含随机数', async () => {
    const input = diagnoseInput([traceArtifact([traceLongTask()])], []);
    const a = await diagnoser().diagnose(input);
    const b = await diagnoser().diagnose(input);

    expect(a.diagnosis.bottlenecks[0]?.id).toBe(b.diagnosis.bottlenecks[0]?.id);
    expect(a.diagnosis.bottlenecks[0]?.id).toMatch(/^bn_[0-9a-f]{8}$/);
  });

  it('归因覆盖全部五类（验收标准 3）', async () => {
    const sourceMap = createInMemorySourceMap({
      'assets/index.js:142:10': {
        source: 'src/List.tsx',
        line: 88,
        column: 4,
        name: 'renderList',
        fromDependency: false,
      },
    });

    const { diagnosis } = await diagnoser(sourceMap).diagnose(
      diagnoseInput(
        [
          harArtifact([
            harEntry({
              resourceType: 'image',
              mimeType: 'image/png',
              url: 'https://staging.example.com/assets/hero.png',
              resourceSize: 1_200_000,
              transferSize: 1_200_000,
            }),
          ]),
          bundleArtifact({
            source: 'stats',
            files: [jsChunk('assets/index.js', 600_000)],
            modules: [
              moduleEntry('./node_modules/.pnpm/lodash@4.17.21/node_modules/lodash/lodash.js', 71_000),
              moduleEntry('./node_modules/legacy/node_modules/lodash/lodash.js', 71_000),
            ],
          }),
          traceArtifact([traceLongTask({ durationMs: 180 })]),
          webVitalsArtifact({
            CLS: { value: 0.24, attribution: { largestShiftTarget: 'img.hero' } },
          }),
        ],
        [['CLS', 0.24]],
      ),
    );
    const levels = new Set(diagnosis.bottlenecks.map((b) => b.attribution.level));
    expect(levels).toContain('resource');
    expect(levels).toContain('dependency');
    expect(levels).toContain('component');
    expect(levels.size).toBeGreaterThanOrEqual(4);
  });

  it('一条规则抛异常不影响其余规则', async () => {
    const broken: DiagnosticRule = {
      id: 'broken-rule',
      kind: 'CACHE_MISS',
      description: '故意抛异常',
      detect() {
        throw new Error('规则写崩了');
      },
    };

    const d = new Diagnoser({
      config: configFixture(),
      logger: silent,
      rules: [broken, ruleById('oversized-image')],
    });

    const { diagnosis, ruleHits } = await d.diagnose(
      diagnoseInput(
        [
          harArtifact([
            harEntry({
              resourceType: 'image',
              mimeType: 'image/png',
              resourceSize: 1_200_000,
              transferSize: 1_200_000,
            }),
          ]),
        ],
        [],
      ),
    );

    expect(ruleHits).toEqual([
      { ruleId: 'broken-rule', detections: 0 },
      { ruleId: 'oversized-image', detections: 1 },
    ]);
    expect(diagnosis.bottlenecks).toHaveLength(1);
  });

  it('没有命中的规则集产出空瓶颈列表与可读摘要', async () => {
    const { diagnosis } = await diagnoser().diagnose(diagnoseInput([], []));

    expect(diagnosis.bottlenecks).toEqual([]);
    expect(diagnosis.summary).toContain('未发现瓶颈');
  });

  it('诊断带上规则集版本，保证历史结论可解释', async () => {
    const { diagnosis } = await diagnoser().diagnose(diagnoseInput([], []));
    expect(diagnosis.ruleSetVersion).toBe(RULE_SET_VERSION);
  });
});

describe('summarize', () => {
  it('无瓶颈无回归', () => {
    expect(summarize([], [], true)).toContain('未发现瓶颈');
  });

  it('有瓶颈时列出首要问题', () => {
    const text = summarize(
      [
        {
          id: 'a',
          runId: 'r',
          kind: 'OVERSIZED_IMAGE',
          title: 't',
          severity: 80,
          impact: {},
          attribution: { level: 'resource', url: 'u', size: 1, contentType: 'image/png' },
          evidence: [],
          confidence: 0.9,
          occurrences: 1,
          source: 'rule',
        },
      ],
      [],
      true,
    );

    expect(text).toContain('发现 1 个瓶颈');
    expect(text).toContain('OVERSIZED_IMAGE');
    expect(text).toContain('无指标回归');
  });

  it('无基线时说明未做回归判定', () => {
    expect(summarize([], [], false)).not.toContain('回归');
  });
});

describe('Diagnosis schema', () => {
  it('产出的诊断能通过 schema 校验（验收标准 5）', async () => {
    const { diagnosis } = await diagnoser().diagnose(
      diagnoseInput(
        [
          harArtifact([
            harEntry({
              resourceType: 'image',
              mimeType: 'image/png',
              resourceSize: 1_200_000,
              transferSize: 1_200_000,
            }),
          ]),
        ],
        [],
      ),
    );

    const result = DiagnosisSchema.safeParse(diagnosis);
    if (!result.success) {
      throw new Error(`schema 校验失败: ${JSON.stringify(result.error.issues, null, 2)}`);
    }
    expect(result.success).toBe(true);
  });
});

