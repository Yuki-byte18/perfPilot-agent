import type { HarEntry, HarHeader } from '@yuki-byte18/shared';
import type { HarRawEntry } from './schema.js';

/**
 * 原始 HAR entry → 规范化 entry。
 *
 * 这里是 HAR 适配器真正的价值所在：不同抓包工具的字段名和缺失情况都不一样，
 * 归一化做在这一层，诊断规则就只需要面对一种稳定的形状。
 *
 * 归一化的三条原则：
 * 1. **未知就是 null，不是 0**。「传输体积未知」和「传输了 0 字节」在诊断里
 *    结论完全相反，用 0 兜底会造出「图片体积为 0」这种假瓶颈。
 * 2. **缺失字段靠推断补**，并让推断规则可读：`_resourceType` 缺失时看 mimeType，
 *    `_transferSize` 缺失时看 bodySize。
 * 3. **丢掉响应体**（`content.text`）。它是整个 HAR 体积的主要来源，
 *    对性能诊断毫无用处。
 */

function headerValue(headers: readonly HarHeader[] | undefined, name: string): string | null {
  if (headers === undefined) return null;
  const lower = name.toLowerCase();
  for (const header of headers) {
    if (header.name.toLowerCase() === lower) return header.value;
  }
  return null;
}

/** mimeType → 资源类型。与 Chrome 的 `_resourceType` 取值对齐 */
export function resourceTypeFromMime(mimeType: string): string {
  const mime = mimeType.toLowerCase();
  if (mime === '') return 'other';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('font/') || mime.includes('font-')) return 'font';
  if (mime.startsWith('audio/')) return 'media';
  if (mime.startsWith('video/')) return 'media';
  if (mime.includes('javascript') || mime.includes('ecmascript')) return 'script';
  if (mime.includes('css')) return 'stylesheet';
  if (mime.includes('html')) return 'document';
  if (mime.includes('json') || mime.includes('xml')) return 'xhr';
  return 'other';
}

function resourceTypeOf(entry: HarRawEntry): string {
  const explicit = entry._resourceType;
  if (typeof explicit === 'string' && explicit !== '') return explicit;
  return resourceTypeFromMime(entry.response?.content?.mimeType ?? '');
}

/** 传输字节：优先 Chrome 的 `_transferSize`（含头开销），退回 bodySize */
function transferSizeOf(entry: HarRawEntry): number | null {
  const transfer = entry.response?._transferSize;
  if (typeof transfer === 'number' && Number.isFinite(transfer)) return transfer;

  const body = entry.response?.bodySize;
  if (typeof body === 'number' && Number.isFinite(body) && body >= 0) return body;

  return null;
}

/** 解码后体积：content.size 是资源本身大小（未压缩） */
function resourceSizeOf(entry: HarRawEntry): number | null {
  const size = entry.response?.content?.size;
  if (typeof size === 'number' && Number.isFinite(size) && size >= 0) return size;
  return null;
}

/**
 * 是否命中缓存。
 *
 * 304 是最明确的信号；Chrome 对内存/磁盘缓存命中会直接写 `from disk cache`
 * 到 statusText 且不产生网络请求（`_transferSize` 为 0 或缺失）。
 */
function fromCacheOf(entry: HarRawEntry): boolean {
  const status = entry.response?.status;
  if (status === 304) return true;

  const statusText = (entry.response?.statusText ?? '').toLowerCase();
  if (statusText.includes('from cache') || statusText.includes('from disk cache')) return true;
  if (statusText.includes('from memory cache')) return true;

  return false;
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** 以主文档为基准判断同源 */
function sameOriginOf(url: string, documentUrl: string | null): boolean {
  if (documentUrl === null) return true;
  const a = originOf(url);
  const b = originOf(documentUrl);
  if (a === null || b === null) return true;
  return a === b;
}

/**
 * 请求发起时间（相对页面开始，ms）。
 *
 * HAR 没有直接给出这个值：`startedDateTime` 是绝对时间戳。
 * 用 `startedDateTime - 主文档 startedDateTime` 得到相对偏移 ——
 * 「字体请求在 1.8s 才发出」这类判断全依赖它。
 */
function startOffsetMs(entry: HarRawEntry, documentStartMs: number | null): number {
  const raw = entry.startedDateTime;
  if (raw === undefined || documentStartMs === null) return 0;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, parsed - documentStartMs);
}

function toHarEntry(entry: HarRawEntry, documentUrl: string | null, documentStartMs: number | null): HarEntry {
  const url = entry.request?.url ?? '';
  const headers = entry.response?.headers;

  return {
    url,
    resourceType: resourceTypeOf(entry),
    mimeType: entry.response?.content?.mimeType ?? '',
    status: entry.response?.status ?? 0,
    transferSize: transferSizeOf(entry),
    resourceSize: resourceSizeOf(entry),
    timeMs: typeof entry.time === 'number' && Number.isFinite(entry.time) ? Math.max(0, entry.time) : 0,
    startMs: startOffsetMs(entry, documentStartMs),
    contentEncoding: headerValue(headers, 'content-encoding'),
    cacheControl: headerValue(headers, 'cache-control'),
    initiatorType: entry._initiator?.type ?? null,
    fromCache: fromCacheOf(entry),
    sameOriginAsDocument: sameOriginOf(url, documentUrl),
    priority: entry._priority ?? null,
  };
}

export interface NormalizeResult {
  pageUrl: string | null;
  entries: HarEntry[];
}

/**
 * HAR entries → 规范化 entries。
 *
 * 主文档通过与 `resourceType === 'document'` 匹配来确定；找不到时退回第一条 entry
 * （抓包工具几乎总是把文档放在第一条）。
 */
export function normalizeHarEntries(rawEntries: readonly HarRawEntry[]): NormalizeResult {
  const document =
    rawEntries.find((e) => resourceTypeOf(e) === 'document') ?? rawEntries[0] ?? null;

  const pageUrl = document?.request?.url ?? null;
  const documentStartMs = document?.startedDateTime ? Date.parse(document.startedDateTime) : null;

  const entries = rawEntries
    .filter((e) => (e.request?.url ?? '') !== '')
    .map((e) =>
      toHarEntry(e, pageUrl, Number.isFinite(documentStartMs) ? documentStartMs : null),
    );

  return { pageUrl, entries };
}
