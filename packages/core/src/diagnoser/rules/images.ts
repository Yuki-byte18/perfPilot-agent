import { attributionMergeKey, type BottleneckKind, type MetricName } from '@yuki-byte18/shared';
import { harEntriesOf, bundleScansOf } from '../artifacts.js';
import { severityBetween, type Detection, type DiagnosticRule, type RuleContext } from '../types.js';

/** 单张图片超过这个体积就值得处理 */
export const OVERSIZED_IMAGE_BYTES = 200 * 1024;
/** 「确实很糟」的参照点：超过它就算满分严重度 */
const OVERSIZED_IMAGE_SEVERE_BYTES = 2 * 1024 * 1024;
/** 未压缩图片的判定下限：小图不值得折腾 */
const UNCOMPRESSED_MIN_BYTES = 50 * 1024;
/** 「确实很糟」的参照点 */
const UNCOMPRESSED_SEVERE_BYTES = 2 * 1024 * 1024;
/** 现代图片格式；不在此列且体积可观 → 有转换收益 */
const MODERN_IMAGE_MIME = ['image/webp', 'image/avif'];

/** 去掉查询串，让同一张图的不同版本归到一组 */
function normalizeUrl(url: string): string {
  return url.split(/[?#]/)[0] ?? url;
}

/**
 * 跨来源的**身份键**。
 *
 * HAR 记录的是部署后的 URL（`https://host/assets/hero.png`），
 * 构建产物记录的是磁盘路径（`assets/hero.png`）—— 它们是同一张图，
 * 但字符串不相等。只用 URL 去重会导致同一张图被报两次
 * （一次来自 HAR 的传输观测、一次来自产物扫描），报告里出现两条一模一样的瓶颈。
 *
 * 因此身份键取**路径部分**：剥掉协议与主机，再统一去掉前导斜杠。
 */
function identityKey(url: string): string {
  const clean = normalizeUrl(url);
  try {
    return new URL(clean).pathname.replace(/^\/+/, '');
  } catch {
    return clean.replace(/^\.?\/+/, '');
  }
}

function isImageMime(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

interface ImageCandidate {
  url: string;
  size: number;
  transferSize: number;
  mimeType: string;
  /** 证据来源：HAR 的传输观测，或构建产物里的文件 */
  origin: 'har' | 'bundle';
}

/**
 * 收集候选图片。
 *
 * 两个来源合并考虑：
 * - **HAR** 给的是「这次实际加载了哪些图、多大」，包含 CDN 上的图
 * - **构建产物** 给的是「产物目录里有哪些图」，包含没被这次访问触发的图
 *
 * 只取 HAR 会漏掉产物里的死图，只取产物会漏掉外链图，因此两边都要。
 * 同一张图在两边都出现时以 HAR 为准（那是真实的传输观测）。
 */
function collectImages(ctx: RuleContext): ImageCandidate[] {
  const byKey = new Map<string, ImageCandidate>();

  for (const scan of bundleScansOf(ctx.artifacts)) {
    for (const file of scan.files) {
      if (!/\.(png|jpe?g|gif|webp|avif|svg)$/i.test(normalizeUrl(file.path))) continue;
      const key = identityKey(file.path);
      byKey.set(key, {
        url: normalizeUrl(file.path),
        size: file.size,
        transferSize: file.size,
        mimeType: mimeTypeFromPath(file.path),
        origin: 'bundle',
      });
    }
  }

  for (const entry of harEntriesOf(ctx.artifacts)) {
    if (entry.resourceType !== 'image' && !isImageMime(entry.mimeType)) continue;
    const key = identityKey(entry.url);
    // HAR 是真实的传输观测，覆盖同名的构建产物记录
    byKey.set(key, {
      url: normalizeUrl(entry.url),
      size: entry.resourceSize ?? entry.transferSize ?? 0,
      transferSize: entry.transferSize ?? entry.resourceSize ?? 0,
      mimeType: entry.mimeType,
      origin: 'har',
    });
  }

  return [...byKey.values()];
}

function mimeTypeFromPath(path: string): string {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.avif':
      return 'image/avif';
    case '.svg':
      return 'image/svg+xml';
    default:
      return 'application/octet-stream';
  }
}

/**
 * OVERSIZED_IMAGE —— 图片体积超标。
 *
 * 合并策略：按「同目录 + 同类型」分组（由 `attributionMergeKey` 决定）。
 * 一个页面十几张 `assets/*.png` 全部超标时，应该合成一条 `occurrences: 12`，
 * 而不是 12 条各占一行的噪音 —— 它们本来就是同一次修复
 * （接入图片压缩 / 转 WebP）。
 */
export const oversizedImageRule: DiagnosticRule = {
  id: 'oversized-image',
  kind: 'OVERSIZED_IMAGE' satisfies BottleneckKind,
  description: `单张图片解码体积超过 ${Math.round(OVERSIZED_IMAGE_BYTES / 1024)}KB`,

  detect(ctx: RuleContext): Detection[] {
    const detections: Detection[] = [];

    for (const image of collectImages(ctx)) {
      if (image.size <= OVERSIZED_IMAGE_BYTES) continue;

      const attribution = {
        level: 'resource' as const,
        url: image.url,
        size: image.size,
        contentType: image.mimeType,
      };

      const impact: Partial<Record<MetricName, number>> = {
        IMAGE_SIZE: image.size - OVERSIZED_IMAGE_BYTES,
      };
      if (image.origin === 'har') {
        impact.TRANSFER_SIZE = Math.max(0, image.transferSize - OVERSIZED_IMAGE_BYTES);
      }

      detections.push({
        mergeKey: attributionMergeKey(attribution),
        title: `图片 ${basename(image.url)} 达 ${formatKb(image.size)}，超过 ${formatKb(OVERSIZED_IMAGE_BYTES)}`,
        severity: severityBetween(image.size, OVERSIZED_IMAGE_BYTES, OVERSIZED_IMAGE_SEVERE_BYTES),
        impact,
        attribution,
        evidence: [
          {
            kind: image.origin === 'har' ? 'har-entry' : 'bundle-chunk',
            payload: image,
            description:
              image.origin === 'har'
                ? `HAR 记录该图片解码后 ${image.size} 字节、传输 ${image.transferSize} 字节`
                : `构建产物中该文件 ${image.size} 字节`,
          },
        ],
        // HAR 量到的是真实传输，比产物文件更接近用户体感
        confidence: image.origin === 'har' ? 0.95 : 0.9,
      });
    }

    return detections;
  },
};

/**
 * UNCOMPRESSED_IMAGE —— 图片没有用现代格式。
 *
 * 判据是 mimeType，不是「体积大」：JPEG 压到很小仍然是 JPEG，
 * 转 WebP/AVIF 通常还能再省 25%-50%。用 mimeType 判断才是可行动的结论
 * （「把它转成 WebP」），而不是「它有点大」。
 */
export const uncompressedImageRule: DiagnosticRule = {
  id: 'uncompressed-image',
  kind: 'UNCOMPRESSED_IMAGE' satisfies BottleneckKind,
  description: `体积超过 ${Math.round(UNCOMPRESSED_MIN_BYTES / 1024)}KB 且不是 WebP/AVIF 的位图`,

  detect(ctx: RuleContext): Detection[] {
    const detections: Detection[] = [];

    for (const image of collectImages(ctx)) {
      if (image.size <= UNCOMPRESSED_MIN_BYTES) continue;
      if (MODERN_IMAGE_MIME.includes(image.mimeType)) continue;
      // SVG 是矢量，转位图格式反而更大
      if (image.mimeType === 'image/svg+xml') continue;
      if (!isImageMime(image.mimeType)) continue;

      const attribution = {
        level: 'resource' as const,
        url: image.url,
        size: image.size,
        contentType: image.mimeType,
      };

      detections.push({
        mergeKey: attributionMergeKey(attribution),
        title: `${basename(image.url)} 是 ${shortMime(image.mimeType)}，未使用现代图片格式`,
        // 转换收益与体积正相关，但格式转换不是「越线」型问题，用 2x 作为「值得做」的基准
        severity: severityBetween(image.size, UNCOMPRESSED_MIN_BYTES, UNCOMPRESSED_SEVERE_BYTES),
        impact: {
          // 保守估计：转 WebP 通常省 25%~50%，取 30%
          IMAGE_SIZE: Math.round(image.size * 0.3),
          ...(image.origin === 'har'
            ? { TRANSFER_SIZE: Math.round(image.transferSize * 0.3) }
            : {}),
        },
        attribution,
        evidence: [
          {
            kind: 'har-entry',
            payload: image,
            description: `${shortMime(image.mimeType)} 格式，体积 ${image.size} 字节`,
          },
        ],
        confidence: 0.85,
      });
    }

    return detections;
  },
};

function basename(url: string): string {
  const clean = normalizeUrl(url);
  const slash = clean.lastIndexOf('/');
  return slash >= 0 ? clean.slice(slash + 1) : clean;
}

function shortMime(mimeType: string): string {
  return mimeType.replace('image/', '').toUpperCase();
}

function formatKb(bytes: number): string {
  return `${(bytes / 1024).toFixed(0)}KB`;
}
