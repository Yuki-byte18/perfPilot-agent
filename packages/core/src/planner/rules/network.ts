import type {
  Attribution,
  Bottleneck,
  Candidate,
  MetricName,
  PlannedChange,
} from '@yuki-byte18/shared';
import { buildRuleCandidate, suggestionChange, type PlannerContext, type PlannerRule } from '../types.js';

/**
 * 网络与加载类规划规则。
 *
 * RENDER_BLOCKING_RESOURCE → 加 preload / async（A 类）
 * MISSING_PRELOAD → 加 preload（A 类）
 * WEBFONT_BLOCKING / FONT_FLASH → font-display: swap（A 类）
 * NO_COMPRESSION → 开启 gzip/brotli（A 类，config-editor）
 * CACHE_MISS → 配置缓存头（A 类，config-editor）
 * EXCESSIVE_REQUESTS → 仅建议（C 类，涉及架构调整）
 */

function configFile(attribution: Attribution): string | null {
  if (attribution.level === 'config') return attribution.file;
  if (attribution.level === 'resource') {
    // 资源类问题通常改构建配置
    return 'vite.config.ts';
  }
  return null;
}

/**
 * 预加载提示的 `as` 必须和资源真实类型一致。
 *
 * 猜错的代价是**比不加更慢**：用 `as="fetch"` 去预加载一个模块脚本，浏览器先按
 * fetch 预取一份，等解析到 `<script type="module">` 时发现目的地不符，
 * 会把预取的那份丢掉、再按 script 请求一次 —— 等于白下载一遍。
 *
 * 判断不出来时返回 `null`，由调用方**不发候选**：宁可少给一条建议，
 * 也不要给一条会拖慢页面的。
 */
export function preloadAs(
  contentType: string | null | undefined,
  url: string,
): 'script' | 'style' | 'image' | 'font' | 'fetch' | null {
  const type = (contentType ?? '').toLowerCase();
  if (type.includes('javascript') || type.includes('ecmascript')) return 'script';
  if (type.includes('text/css')) return 'style';
  if (type.startsWith('image/')) return 'image';
  if (type.includes('font') || type.includes('woff')) return 'font';
  if (type.includes('json')) return 'fetch';

  // contentType 缺失时按扩展名兜底
  const path = url.split('?')[0] ?? url;
  if (/\.m?js$/i.test(path)) return 'script';
  if (/\.css$/i.test(path)) return 'style';
  if (/\.(png|jpe?g|gif|webp|avif|svg)$/i.test(path)) return 'image';
  if (/\.(woff2?|ttf|otf|eot)$/i.test(path)) return 'font';
  if (/\.(json|har)$/i.test(path)) return 'fetch';

  return null;
}

export const addPreloadRule: PlannerRule = {
  id: 'add-preload',
  kind: 'MISSING_PRELOAD',
  description: '为关键资源添加 preload',

  plan(bottleneck, ctx): Candidate[] {
    if (bottleneck.attribution.level !== 'resource') return [];
    const url = bottleneck.attribution.url;

    const as = preloadAs(bottleneck.attribution.contentType, url);
    // 类型判断不出来就不发候选：as 猜错会让浏览器重复下载（见 preloadAs 的说明）
    if (as === null) return [];

    // 字体必须带 crossorigin：否则浏览器把它当成另一个请求，
    // 预加载的那份用不上，等于白下一遍
    const crossOrigin = as === 'font' ? ' crossorigin' : '';

    const change: PlannedChange = {
      type: 'config',
      file: 'index.html',
      key: `preload:${url}`,
      before: null,
      after: `<link rel="preload" href="${url}" as="${as}"${crossOrigin}>`,
    };

    const expectedGain: Partial<Record<MetricName, number>> = {
      LCP: bottleneck.impact.LCP ?? 100,
      FCP: bottleneck.impact.FCP ?? 80,
    };

    return [
      buildRuleCandidate({
        id: `cand_${bottleneck.id}_preload`,
        runId: ctx.runId,
        bottleneck,
        ruleId: 'add-preload',
        class: 'A',
        title: `预加载关键资源 ${url}`,
        description: '该资源阻塞首屏渲染，添加 preload 可提前加载',
        changes: [change],
        expectedGain,
        risk: 'low',
        effort: 'low',
        reversible: true,
      }),
    ];
  },
};

export const deferRenderBlockingRule: PlannerRule = {
  id: 'defer-render-blocking',
  kind: 'RENDER_BLOCKING_RESOURCE',
  description: '延迟加载非关键的渲染阻塞资源',

  plan(bottleneck, ctx): Candidate[] {
    if (bottleneck.attribution.level !== 'resource') return [];
    const url = bottleneck.attribution.url;

    const change: PlannedChange = {
      type: 'ast',
      file: 'index.html',
      node: 'script-or-link-tag',
      description: `为 ${url} 添加 defer 或 media="print" onload 切换`,
    };

    return [
      buildRuleCandidate({
        id: `cand_${bottleneck.id}_defer`,
        runId: ctx.runId,
        bottleneck,
        ruleId: 'defer-render-blocking',
        class: 'A',
        title: `延迟加载阻塞资源 ${url}`,
        description: '非关键资源不应阻塞首屏渲染，添加 defer 或异步加载',
        changes: [change],
        expectedGain: { FCP: bottleneck.impact.FCP ?? 100, LCP: bottleneck.impact.LCP ?? 100 },
        risk: 'low',
        effort: 'low',
        reversible: true,
      }),
    ];
  },
};

/**
 * font-display: swap 的实现体。
 *
 * 抽出来是因为它同时治两种瓶颈：`WEBFONT_BLOCKING`（字体阻塞文本渲染）
 * 与 `FONT_FLASH`（字体切换导致闪烁 / 布局抖动）。
 * 一个 `font-display: swap` 同时解决两者 —— 拆成两份代码迟早会改漏一边。
 */
function planFontDisplaySwap(bottleneck: Bottleneck, ctx: PlannerContext): Candidate[] {
  const file = configFile(bottleneck.attribution) ?? 'src/styles/fonts.css';

  const change: PlannedChange = {
    type: 'config',
    file,
    key: 'font-display',
    before: 'auto',
    after: 'swap',
  };

  return [
    buildRuleCandidate({
      id: `cand_${bottleneck.id}_fontswap`,
      runId: ctx.runId,
      bottleneck,
      ruleId: 'font-display-swap',
      class: 'A',
      title: '设置 font-display: swap',
      description: '字体加载期间先显示系统字体，避免不可见文本闪烁（FOIT）与字体切换抖动',
      changes: [change],
      expectedGain: { FCP: bottleneck.impact.FCP ?? 50, CLS: bottleneck.impact.CLS ?? 0.02 },
      risk: 'low',
      effort: 'low',
      reversible: true,
    }),
  ];
}

export const fontDisplaySwapRule: PlannerRule = {
  id: 'font-display-swap',
  kind: 'WEBFONT_BLOCKING',
  description: '为 webfont 添加 font-display: swap',
  plan: planFontDisplaySwap,
};

export const fontFlashSwapRule: PlannerRule = {
  id: 'font-flash-swap',
  kind: 'FONT_FLASH',
  description: '用 font-display: swap 消除字体闪烁与切换抖动',
  plan: planFontDisplaySwap,
};

export const enableCompressionRule: PlannerRule = {
  id: 'enable-compression',
  kind: 'NO_COMPRESSION',
  description: '开启 gzip/brotli 压缩',

  plan(bottleneck, ctx): Candidate[] {
    const file = configFile(bottleneck.attribution) ?? 'vite.config.ts';

    const change: PlannedChange = {
      type: 'config',
      file,
      key: 'build.compress',
      before: false,
      after: 'brotli',
    };

    const expectedGain: Partial<Record<MetricName, number>> = {
      TRANSFER_SIZE: Math.round((bottleneck.impact.TRANSFER_SIZE ?? 0) * 0.6),
    };

    return [
      buildRuleCandidate({
        id: `cand_${bottleneck.id}_compress`,
        runId: ctx.runId,
        bottleneck,
        ruleId: 'enable-compression',
        class: 'A',
        title: '开启 Brotli 压缩',
        description: '文本资源压缩后通常减少 60%-80% 传输体积',
        changes: [change],
        expectedGain,
        risk: 'low',
        effort: 'low',
        reversible: true,
      }),
    ];
  },
};

export const setCacheHeadersRule: PlannerRule = {
  id: 'set-cache-headers',
  kind: 'CACHE_MISS',
  description: '为静态资源配置长缓存',

  plan(bottleneck, ctx): Candidate[] {
    const file = configFile(bottleneck.attribution) ?? 'vite.config.ts';

    const change: PlannedChange = {
      type: 'config',
      file,
      key: 'build.cacheControl',
      before: 'no-cache',
      after: 'public, max-age=31536000, immutable',
    };

    return [
      buildRuleCandidate({
        id: `cand_${bottleneck.id}_cache`,
        runId: ctx.runId,
        bottleneck,
        ruleId: 'set-cache-headers',
        class: 'A',
        title: '配置静态资源长缓存',
        description: '带 hash 的静态资源应设置一年期 immutable 缓存',
        changes: [change],
        expectedGain: { TRANSFER_SIZE: bottleneck.impact.TRANSFER_SIZE ?? 0 },
        risk: 'low',
        effort: 'low',
        reversible: true,
      }),
    ];
  },
};

export const excessiveRequestsSuggestionRule: PlannerRule = {
  id: 'excessive-requests-suggestion',
  kind: 'EXCESSIVE_REQUESTS',
  description: '请求过多，建议合并或拆分（仅建议）',

  plan(bottleneck, ctx): Candidate[] {
    return [
      buildRuleCandidate({
        id: `cand_${bottleneck.id}_reqs`,
        runId: ctx.runId,
        bottleneck,
        ruleId: 'excessive-requests-suggestion',
        class: 'C',
        title: '请求数量过多',
        description: '当前请求数超过阈值，建议：合并接口、雪碧图、代码分割后按需加载。此为架构级调整，需人工评估。',
        changes: [suggestionChange('request-budget', bottleneck.title)],
        expectedGain: { REQUEST_COUNT: bottleneck.impact.REQUEST_COUNT ?? 10 },
        risk: 'high',
        effort: 'high',
        reversible: false,
      }),
    ];
  },
};
