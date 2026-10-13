import {
  parseExternal,
  type MetricName,
  type MetricSample,
  type RawArtifact,
} from '@yuki-byte18/shared';
import { samples } from '../internal/samples.js';
import { artifactsOf } from '../define-collector.js';
import { LighthouseResultSchema } from './schema.js';
import type { LighthouseAudits, LighthouseResult, ResourceSummaryItem } from './schema.js';

export const LIGHTHOUSE_KIND = 'lighthouse-result';

/**
 * 只取「有 numericValue 的审计项」这一部分键。
 *
 * 不直接用 `keyof LighthouseAudits`：那样 `resource-summary` 会进入联合类型，
 * 而它是结构性审计、值类型完全不同，会逼着 `in` 操作符去做无意义的分支收窄。
 */
type NumericAuditKey = Exclude<keyof LighthouseAudits, 'resource-summary'>;

/**
 * 审计项名 → 指标名。
 *
 * INP 在 Lighthouse 12+ 是实验性审计，且字段名跨版本变动过，两种都认，
 * 先命中的生效（数组顺序即优先级）。
 */
const AUDIT_TO_METRIC: ReadonlyArray<readonly [NumericAuditKey, MetricName]> = [
  ['largest-contentful-paint', 'LCP'],
  ['cumulative-layout-shift', 'CLS'],
  ['first-contentful-paint', 'FCP'],
  ['server-response-time', 'TTFB'],
  ['total-blocking-time', 'TBT'],
  ['speed-index', 'SI'],
  ['experimental-interaction-to-next-paint', 'INP'],
  ['interaction-to-next-paint', 'INP'],
  ['total-byte-weight', 'TRANSFER_SIZE'],
];

function auditValue(audits: LighthouseAudits, key: NumericAuditKey): number | null {
  const audit: unknown = audits[key];
  if (typeof audit !== 'object' || audit === null) return null;

  const value = (audit as { numericValue?: unknown }).numericValue;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function resourceItems(audits: LighthouseAudits): ResourceSummaryItem[] {
  return audits['resource-summary']?.details?.items ?? [];
}

/**
 * 按资源类型汇总体积。
 *
 * 用 `filter` + 累加而不是 `find`：一个页面可能有多个 script 条目，
 * 取首项会漏统计。体积优先取 `resourceSize`（解码后）—— 这才是 bundle 的真实大小；
 * 压缩后体积另有 TRANSFER_SIZE 上报，两者混用会让「开启 gzip」这类优化无法被验证。
 */
function sumResourceSize(items: readonly ResourceSummaryItem[], type: string): number | null {
  const matched = items.filter((item) => item.resourceType === type);
  if (matched.length === 0) return null;

  let total = 0;
  let found = false;
  for (const item of matched) {
    const size = item.resourceSize ?? item.transferSize;
    if (typeof size === 'number' && Number.isFinite(size)) {
      total += size;
      found = true;
    }
  }
  return found ? total : null;
}

/** 请求数优先取 resource-summary 的 total 行，缺失时退回逐行累加 */
function resourceRequestCount(items: readonly ResourceSummaryItem[]): number | null {
  const totalItem = items.find((item) => item.resourceType === 'total');
  if (totalItem?.requestCount !== undefined && Number.isFinite(totalItem.requestCount)) {
    return totalItem.requestCount;
  }
  const sum = items.reduce((acc, item) => acc + (item.requestCount ?? 0), 0);
  return sum > 0 ? sum : null;
}

/**
 * Lighthouse 结果 → 未打分样本。
 *
 * 抛 `ValidationError`（code `ADAPTER_OUTPUT_INVALID`）而不是静默返回空数组：
 * 输出不可解析是一个**必须被看见**的故障，由 core 的 collector 统一降级为 warning，
 * 而不是在这里悄悄吞掉。
 */
export function parseLighthouse(artifacts: readonly RawArtifact[]): MetricSample[] {
  const out: MetricSample[] = [];

  for (const artifact of artifactsOf(artifacts, 'lighthouse', LIGHTHOUSE_KIND)) {
    const result: LighthouseResult = parseExternal(LighthouseResultSchema, artifact.payload, {
      what: 'lighthouse 采集结果',
      code: 'ADAPTER_OUTPUT_INVALID',
      stage: 'collect',
    });
    out.push(...samplesFromResult(result));
  }

  return out;
}

/** 供单测直接使用：单份 Lighthouse 结果 → 样本 */
export function samplesFromResult(result: LighthouseResult): MetricSample[] {
  const entries: Array<readonly [MetricName, number | null]> = [];
  const seen = new Set<MetricName>();

  for (const [auditKey, metricName] of AUDIT_TO_METRIC) {
    if (seen.has(metricName)) continue;
    const value = auditValue(result.audits, auditKey);
    if (value === null) continue;
    entries.push([metricName, value]);
    seen.add(metricName);
  }

  const items = resourceItems(result.audits);
  entries.push(['JS_SIZE', sumResourceSize(items, 'script')]);
  entries.push(['CSS_SIZE', sumResourceSize(items, 'stylesheet')]);
  entries.push(['IMAGE_SIZE', sumResourceSize(items, 'image')]);
  entries.push(['REQUEST_COUNT', resourceRequestCount(items)]);

  return samples(entries);
}

/** 采集到的 Lighthouse 版本，写进产物便于追溯「同一页面为什么这次分数变了」 */
export function lighthouseVersionOf(artifacts: readonly RawArtifact[]): string | null {
  for (const artifact of artifactsOf(artifacts, 'lighthouse', LIGHTHOUSE_KIND)) {
    const version = (artifact.payload as { lighthouseVersion?: unknown } | null)?.lighthouseVersion;
    if (typeof version === 'string') return version;
  }
  return null;
}
