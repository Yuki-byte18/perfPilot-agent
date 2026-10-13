import type { AdapterId, Device, RawArtifact } from '@yuki-byte18/shared';

/** 造一个原始产物信封，省去每个测试重复写 6 个字段 */
export function artifact(
  adapter: AdapterId,
  kind: string,
  payload: unknown,
  options: { route?: string; device?: Device; collectedAt?: string; file?: string | null } = {},
): RawArtifact {
  return {
    adapter,
    kind,
    payload,
    collectedAt: options.collectedAt ?? '2026-01-17T14:25:30.000Z',
    route: options.route ?? '/',
    device: options.device ?? 'mobile',
    file: options.file ?? null,
  };
}

export interface LighthouseFixtureOptions {
  lcp?: number | null;
  cls?: number | null;
  fcp?: number | null;
  ttfb?: number | null;
  tbt?: number | null;
  si?: number | null;
  /** null 表示该审计项缺失（Lighthouse 12 以下没有实验性 INP） */
  inp?: number | null;
  transferSize?: number | null;
  scriptSize?: number;
  styleSize?: number;
  imageSize?: number;
  requests?: number;
  version?: string;
  /** true 时省略 resource-summary，模拟旧的/裁剪过的报告 */
  omitResourceSummary?: boolean;
}

/**
 * Lighthouse 结果 fixture。
 *
 * 做成工厂而非固定文件，是为了让「本次变慢 / 变快」这类对比测试
 * 只改一个数字就能构造出来 —— 手改大 JSON 迟早会改错一处。
 */
export function lighthouseFixture(options: LighthouseFixtureOptions = {}): Record<string, unknown> {
  const {
    lcp = 3800,
    cls = 0.18,
    fcp = 2100,
    ttfb = 720,
    tbt = 480,
    si = 4100,
    inp = null,
    transferSize = 2_450_000,
    scriptSize = 486_000,
    styleSize = 92_000,
    imageSize = 1_320_000,
    requests = 68,
    version = '12.2.1',
    omitResourceSummary = false,
  } = options;

  const audit = (value: number | null): Record<string, unknown> | undefined =>
    value === null ? undefined : { numericValue: value };

  const audits: Record<string, unknown> = {
    'largest-contentful-paint': audit(lcp),
    'cumulative-layout-shift': audit(cls),
    'first-contentful-paint': audit(fcp),
    'server-response-time': audit(ttfb),
    'total-blocking-time': audit(tbt),
    'speed-index': audit(si),
    'experimental-interaction-to-next-paint': audit(inp),
    'total-byte-weight': audit(transferSize),
  };

  if (!omitResourceSummary) {
    audits['resource-summary'] = {
      details: {
        items: [
          { resourceType: 'script', resourceSize: scriptSize, requestCount: 14 },
          { resourceType: 'stylesheet', resourceSize: styleSize, requestCount: 3 },
          { resourceType: 'image', resourceSize: imageSize, requestCount: 22 },
          { resourceType: 'total', resourceSize: 2_100_000, requestCount: requests },
        ],
      },
    };
  }

  return {
    lighthouseVersion: version,
    finalUrl: 'https://staging.example.com/',
    fetchTime: '2026-01-17T14:25:30.000Z',
    configSettings: { formFactor: 'mobile' },
    audits,
  };
}

export interface WebVitalsFixtureOptions {
  lcp?: number | null;
  cls?: number | null;
  inp?: number | null;
  fcp?: number | null;
  ttfb?: number | null;
  /** 额外塞入的键，用来测「不认识的键被忽略」 */
  extra?: Record<string, unknown>;
}

export function webVitalsFixture(options: WebVitalsFixtureOptions = {}): Record<string, unknown> {
  const { lcp = 3100, cls = 0.14, inp = 240, fcp = 1900, ttfb = 690, extra = {} } = options;

  const metrics: Record<string, unknown> = {};
  const put = (name: string, value: number | null, withAttribution = false): void => {
    if (value === null) return;
    metrics[name] = withAttribution
      ? { value, attribution: { element: 'img.hero', url: '/hero.png' } }
      : { value };
  };

  put('LCP', lcp, true);
  put('CLS', cls);
  put('INP', inp, true);
  put('FCP', fcp);
  put('TTFB', ttfb);

  return {
    url: 'https://staging.example.com/',
    route: '/',
    collectedAt: '2026-01-17T14:25:31.000Z',
    device: 'mobile',
    metrics: { ...metrics, ...extra },
  };
}

export interface BundleFixtureOptions {
  jsSize?: number;
  cssSize?: number;
  imageSize?: number;
  source?: 'scan' | 'stats';
  modules?: Array<{ name: string; size: number }>;
}

/**
 * 默认模块图刻意包含两处 lodash：一处是 pnpm 顶层安装（4.17.21），
 * 另一处是某个库自己嵌套安装的副本。这是真实项目里最常见的重复打包形态 ——
 * 版本可能相同，但因为安装位置不同，两份都被打进了 bundle。
 */
export const DEFAULT_DUPLICATE_MODULES: Array<{ name: string; size: number }> = [
  { name: './src/main.tsx', size: 1_200 },
  { name: './src/App.tsx', size: 8_400 },
  { name: './node_modules/.pnpm/lodash@4.17.21/node_modules/lodash/lodash.js', size: 71_000 },
  {
    name: './node_modules/legacy-widget/node_modules/lodash/lodash.js',
    size: 71_000,
  },
  {
    name: './node_modules/.pnpm/moment@2.29.4/node_modules/moment/moment.js',
    size: 288_000,
  },
  { name: './node_modules/.pnpm/react@18.3.1/node_modules/react/index.js', size: 6_900 },
  { name: './node_modules/.pnpm/react@18.3.1/node_modules/react-dom/index.js', size: 130_000 },
];

export function bundleFixture(options: BundleFixtureOptions = {}): Record<string, unknown> {
  const {
    jsSize = 512_000,
    cssSize = 84_000,
    imageSize = 1_180_000,
    source = 'stats',
    modules = DEFAULT_DUPLICATE_MODULES,
  } = options;

  return {
    distDir: '/repo/dist',
    source,
    files: [
      { path: 'assets/index-9f2a1c.js', size: jsSize * 0.62 },
      { path: 'assets/vendor-3b7d4e.js', size: jsSize * 0.38 },
      { path: 'assets/index-1a2b3c.css', size: cssSize },
      { path: 'assets/hero-4d5e6f.png', size: imageSize * 0.7 },
      { path: 'assets/logo-7a8b9c.svg', size: imageSize * 0.3 },
      { path: 'index.html', size: 1_800 },
    ],
    modules,
  };
}
