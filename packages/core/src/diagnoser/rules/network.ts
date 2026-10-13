import { attributionMergeKey, type BottleneckKind } from '@yuki-byte18/shared';
import { harEntriesOf, harPageUrlOf } from '../artifacts.js';
import {
  metricValue,
  severityBetween,
  type Detection,
  type DiagnosticRule,
  type RuleContext,
} from '../types.js';

/** 文本类资源的「最低可讨论线」：小于这个体积就没必要计较压缩 */
const COMPRESSION_MIN_BYTES = 10 * 1024;
/** 「确实很糟」的参照点：超过它就算满分严重度 */
const COMPRESSION_SEVERE_BYTES = 500 * 1024;
/** 请求数超过这个值算过多 */
export const EXCESSIVE_REQUESTS_THRESHOLD = 50;
const EXCESSIVE_SEVERE = 200;
/** 阻塞资源的时间口径 */
const BLOCKING_MIN_MS = 200;
const BLOCKING_SEVERE_MS = 1_000;
/** 资源在这个时间点之后才被发现，就算「发现得太晚」 */
const LATE_DISCOVERY_MS = 1_000;
const LATE_SEVERE_MS = 5_000;
/** 值得为它单独 preload 的资源体积下限 */
const PRELOAD_MIN_BYTES = 30 * 1024;

const TEXT_RESOURCE_TYPES = new Set(['script', 'stylesheet', 'document', 'xhr', 'fetch']);
const STATIC_RESOURCE_TYPES = new Set(['script', 'stylesheet', 'image', 'font']);

function normalizeUrl(url: string): string {
  return url.split(/[?#]/)[0] ?? url;
}

function basename(url: string): string {
  const clean = normalizeUrl(url);
  const slash = clean.lastIndexOf('/');
  return slash >= 0 ? clean.slice(slash + 1) : clean;
}

function resourceAttribution(url: string, size: number, contentType: string) {
  return { level: 'resource' as const, url: normalizeUrl(url), size, contentType };
}

/**
 * RENDER_BLOCKING_RESOURCE —— 解析器阻塞资源。
 *
 * 判据是 HAR 的 `initiator.type === 'parser'`：它表示这个资源是**解析 HTML 时
 * 内联发现**的，也就是浏览器必须先停下解析去取它。这正是 render-blocking 的定义。
 * 对比之下，由 `script` / `other` 发起的资源（动态 import、preload 触发）不阻塞解析。
 *
 * 这个信号比「在 head 里的 script 标签」更可靠：后者需要 DOM，而我们没有 DOM。
 */
export const renderBlockingRule: DiagnosticRule = {
  id: 'render-blocking-resource',
  kind: 'RENDER_BLOCKING_RESOURCE' satisfies BottleneckKind,
  description: '解析器内联发现、且体积可观或耗时不短的 script / stylesheet',

  detect(ctx: RuleContext): Detection[] {
    const detections: Detection[] = [];

    for (const entry of harEntriesOf(ctx.artifacts)) {
      // 只有 script / stylesheet 会阻塞解析；document 是解析的对象本身，
      // xhr / fetch 由脚本发起，都不在此列
      if (entry.resourceType !== 'script' && entry.resourceType !== 'stylesheet') continue;
      if (entry.initiatorType !== 'parser') continue;

      const size = entry.resourceSize ?? entry.transferSize ?? 0;
      const significant = size > COMPRESSION_MIN_BYTES || entry.timeMs > BLOCKING_MIN_MS;
      if (!significant) continue;

      const attribution = resourceAttribution(entry.url, size, entry.mimeType);

      detections.push({
        mergeKey: attributionMergeKey(attribution),
        title: `${basename(entry.url)} 阻塞解析（${Math.round(entry.timeMs)}ms，${(size / 1024).toFixed(0)}KB）`,
        // 耗时与体积各按自己的尺度打分，取更严重的一个：
        // 一个 500KB 但走缓存的阻塞脚本依然拖慢首屏
        severity: Math.max(
          severityBetween(entry.timeMs, BLOCKING_MIN_MS, BLOCKING_SEVERE_MS),
          severityBetween(size, COMPRESSION_MIN_BYTES, COMPRESSION_SEVERE_BYTES),
        ),
        impact: {
          LCP: Math.round(entry.timeMs),
          FCP: Math.round(entry.timeMs * 0.6),
          ...(entry.transferSize !== null ? { TRANSFER_SIZE: entry.transferSize } : {}),
        },
        attribution,
        evidence: [
          {
            kind: 'har-entry',
            payload: entry,
            description: `解析器发起，耗时 ${Math.round(entry.timeMs)}ms，启动于 ${Math.round(entry.startMs)}ms`,
          },
        ],
        // 启发式判据（initiator 类型），不是直接观测，置信度适中
        confidence: 0.7,
      });
    }

    return detections;
  },
};

/**
 * NO_COMPRESSION —— 文本资源没有开压缩。
 *
 * 判据是「文本类资源 + 没有 content-encoding + 体积不小」。
 * 这是本项目里最确定的一条规则：没有歧义、没有启发式，
 * 而且修法明确（开 gzip/brotli），因此置信度给到 0.95。
 */
export const noCompressionRule: DiagnosticRule = {
  id: 'no-compression',
  kind: 'NO_COMPRESSION' satisfies BottleneckKind,
  description: `文本类资源超过 ${Math.round(COMPRESSION_MIN_BYTES / 1024)}KB 却没有 content-encoding`,

  detect(ctx: RuleContext): Detection[] {
    const detections: Detection[] = [];

    for (const entry of harEntriesOf(ctx.artifacts)) {
      if (!TEXT_RESOURCE_TYPES.has(entry.resourceType)) continue;
      if (entry.contentEncoding !== null) continue;
      if (entry.fromCache) continue;

      // 用解码后体积判断，避免把「已经很小」和「压缩后很小」混为一谈
      const size = entry.resourceSize ?? 0;
      if (size <= COMPRESSION_MIN_BYTES) continue;

      const attribution = resourceAttribution(entry.url, size, entry.mimeType);
      const savings = Math.round(size * 0.65);

      detections.push({
        mergeKey: attributionMergeKey(attribution),
        title: `${basename(entry.url)} 未启用压缩（${(size / 1024).toFixed(0)}KB 原样传输）`,
        severity: severityBetween(size, COMPRESSION_MIN_BYTES, COMPRESSION_SEVERE_BYTES),
        impact: { TRANSFER_SIZE: savings },
        attribution,
        evidence: [
          {
            kind: 'har-entry',
            payload: entry,
            description: `content-encoding 缺失，传输 ${entry.transferSize ?? '未知'} 字节 / 解码后 ${size} 字节`,
          },
        ],
        confidence: 0.95,
      });
    }

    return detections;
  },
};

/**
 * EXCESSIVE_REQUESTS —— 页面请求数过多。
 *
 * 这是**聚合型**问题：没有哪一条请求是「罪魁」，问题在于数量本身。
 * 因此归因落在主文档上（要改的是这个页面），而不是随便挑一条请求顶罪。
 */
export const excessiveRequestsRule: DiagnosticRule = {
  id: 'excessive-requests',
  kind: 'EXCESSIVE_REQUESTS' satisfies BottleneckKind,
  description: `单页请求数超过 ${EXCESSIVE_REQUESTS_THRESHOLD} 条`,

  detect(ctx: RuleContext): Detection[] {
    // 优先用指标（可能来自 Lighthouse），HAR 条数作为兜底
    const metric = metricValue(ctx, 'REQUEST_COUNT');
    const fromHar = harEntriesOf(ctx.artifacts).length;
    const count = metric ?? (fromHar > 0 ? fromHar : null);
    if (count === null || count <= EXCESSIVE_REQUESTS_THRESHOLD) return [];

    const pageUrl = harPageUrlOf(ctx.artifacts) ?? '/';
    const attribution = {
      level: 'resource' as const,
      url: normalizeUrl(pageUrl),
      size: count,
      contentType: 'text/html',
    };

    return [
      {
        mergeKey: attributionMergeKey(attribution),
        title: `单页 ${count} 个请求，超过 ${EXCESSIVE_REQUESTS_THRESHOLD} 个`,
        severity: severityBetween(count, EXCESSIVE_REQUESTS_THRESHOLD, EXCESSIVE_SEVERE),
        impact: { REQUEST_COUNT: count - EXCESSIVE_REQUESTS_THRESHOLD },
        attribution,
        evidence: [
          {
            kind: 'har-entry',
            payload: { count, source: metric !== null ? 'metric' : 'har' },
            description: `统计到 ${count} 条请求（来源：${metric !== null ? 'REQUEST_COUNT 指标' : 'HAR entries'}）`,
          },
        ],
        confidence: 0.85,
      },
    ];
  },
};

/**
 * CACHE_MISS —— 静态资源没有可用的缓存策略。
 *
 * 只统计**同源静态资源**：跨域 CDN 资源通常自带 CDN 侧缓存，
 * 而 HAR 里看不到 CDN 的缓存头配置，报出来只会是噪音。
 */
export const cacheMissRule: DiagnosticRule = {
  id: 'cache-miss',
  kind: 'CACHE_MISS' satisfies BottleneckKind,
  description: '同源静态资源没有 max-age 或声明了 no-store / no-cache',

  detect(ctx: RuleContext): Detection[] {
    const detections: Detection[] = [];

    for (const entry of harEntriesOf(ctx.artifacts)) {
      if (!STATIC_RESOURCE_TYPES.has(entry.resourceType)) continue;
      if (!entry.sameOriginAsDocument) continue;
      if (entry.status !== 200) continue;

      const cacheControl = entry.cacheControl?.toLowerCase() ?? null;
      if (cacheControl !== null) {
        // 有明确的正向缓存策略就放行
        const hasMaxAge = /max-age\s*=\s*([1-9]\d*)/.test(cacheControl);
        const forbidden = /no-store|no-cache/.test(cacheControl);
        if (hasMaxAge && !forbidden) continue;
        if (!forbidden && cacheControl.includes('immutable')) continue;
      }

      const size = entry.resourceSize ?? entry.transferSize ?? 0;
      if (size <= 0) continue;

      const attribution = resourceAttribution(entry.url, size, entry.mimeType);

      detections.push({
        mergeKey: attributionMergeKey(attribution),
        title: `${basename(entry.url)} 缺少有效缓存策略`,
        severity: severityBetween(size, COMPRESSION_MIN_BYTES, COMPRESSION_SEVERE_BYTES),
        impact: {
          TRANSFER_SIZE: entry.transferSize ?? size,
          REQUEST_COUNT: 1,
        },
        attribution,
        evidence: [
          {
            kind: 'har-entry',
            payload: entry,
            description: `cache-control: ${entry.cacheControl ?? '(缺失)'}`,
          },
        ],
        // 缓存策略可能由 CDN 注入，HAR 看不到配置本身
        confidence: 0.75,
      });
    }

    return detections;
  },
};

/**
 * MISSING_PRELOAD —— 关键资源发现得太晚。
 *
 * 判据：同源、体积可观、**启动时间晚**、且不是解析器直接发现的。
 * 「晚 + 不是解析器发现」说明它是被 CSS 或脚本间接带出来的
 * （最典型的是 `@font-face` 里的字体）——这类资源加 `preload` 收益最大。
 */
export const missingPreloadRule: DiagnosticRule = {
  id: 'missing-preload',
  kind: 'MISSING_PRELOAD' satisfies BottleneckKind,
  description: `同源字体/图片在 ${LATE_DISCOVERY_MS}ms 之后才被发起`,

  detect(ctx: RuleContext): Detection[] {
    const detections: Detection[] = [];

    for (const entry of harEntriesOf(ctx.artifacts)) {
      if (entry.resourceType !== 'font' && entry.resourceType !== 'image') continue;
      if (!entry.sameOriginAsDocument) continue;
      if (entry.startMs < LATE_DISCOVERY_MS) continue;
      // 解析器直接发现的不算「发现得晚」，那是 HTML 里写的位置问题
      if (entry.initiatorType === 'parser') continue;

      const size = entry.resourceSize ?? entry.transferSize ?? 0;
      if (size < PRELOAD_MIN_BYTES) continue;

      const attribution = resourceAttribution(entry.url, size, entry.mimeType);

      detections.push({
        mergeKey: attributionMergeKey(attribution),
        title: `${basename(entry.url)} 直到 ${Math.round(entry.startMs)}ms 才开始加载`,
        severity: severityBetween(entry.startMs, LATE_DISCOVERY_MS, LATE_SEVERE_MS),
        impact: {
          // 资源晚发现主要拖慢首屏渲染，取「等待时长」作为量级估计
          LCP: Math.round(Math.min(entry.startMs, entry.timeMs + 200)),
        },
        attribution,
        evidence: [
          {
            kind: 'har-entry',
            payload: entry,
            description: `${Math.round(entry.startMs)}ms 发起（initiator: ${entry.initiatorType ?? '未知'}），体积 ${size} 字节`,
          },
        ],
        confidence: 0.7,
      });
    }

    return detections;
  },
};
