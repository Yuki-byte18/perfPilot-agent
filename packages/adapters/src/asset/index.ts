import type { AssetProcessInput, AssetProcessResult, AssetProcessorPort } from '@yuki-byte18/shared';

/**
 * 资产处理适配器（sharp）。
 *
 * 硬约束 5：所有外部工具调用经过 adapter。这里封装 sharp 的三类操作。
 *
 * **默认参数刻意保守**：转 WebP 用 quality 80，压缩用 quality 75 ——
 * 都是"肉眼看不出差别、体积明显下降"的常见档位。
 * 激进到 quality 50 确实省得更多，但那样产出的图会被人工确认环节直接驳回，
 * 反而浪费一轮验证。要更激进通过 `params` 显式传。
 *
 * ## sharp 为什么是可选依赖 + 懒加载
 *
 * sharp 带平台相关的原生二进制（解包后好几 MB），在 musl、非常见架构、
 * `--no-optional`、或公司镜像源缺该平台包时都会装不上。
 * 而全项目**只有图片优化**这一条路需要它 —— 一个只想跑 `perfpilot init`
 * 或 `history` 的用户，不该因为装不上 sharp 而整个 CLI 用不了。
 *
 * 因此三件事一起做：
 *
 * 1. `package.json` 里放 `optionalDependencies`（装失败不阻断安装）；
 * 2. 顶层不再 `import sharp from 'sharp'` —— 那等于"加载本模块就要求它存在"，
 *    而本模块被 `executor/registry` 间接引用，于是所有命令都会在启动时崩；
 *    改成第一次真要处理图片时才 `await import()`；
 * 3. 装不上时返回 `null`（"这张图没处理"）而不是抛错，由上层如实报告。
 *
 * 类型也不从 sharp 引：写成字面量 `import('sharp')` 时 TypeScript 会去解析它的
 * 类型，装不上的机器上会以 TS2307 的形式把"可选依赖"变回硬依赖
 * （`memory/postgres` 的 `pg`、`core/llm` 的 `ai` 都是同一个理由）。
 * 下面只声明我们真正用到的那一小块契约。
 */

/** sharp 里我们用到的那部分：链式图像操作 */
interface SharpImage {
  webp(options: { quality: number }): SharpImage;
  png(options: { quality: number; compressionLevel: number }): SharpImage;
  jpeg(options: { quality: number; mozjpeg: boolean }): SharpImage;
  resize(options: { width: number; withoutEnlargement: boolean }): SharpImage;
  metadata(): Promise<{ format?: string | undefined; width?: number | undefined; height?: number | undefined }>;
  toBuffer(): Promise<Buffer>;
}

/** `sharp(buffer)` 本身 */
type SharpFactory = (input: Buffer) => SharpImage;

/**
 * 模块说明符**刻意是变量**。
 *
 * 写成字面量 `import('sharp')` 会被 TypeScript 与打包器当作硬依赖去解析，
 * 懒加载就白做了；用变量表达"这是运行期才决定要不要的东西"。
 */
const SHARP_SPECIFIER = 'sharp';

let cachedSharp: SharpFactory | null | undefined;

/**
 * 探测本机有没有可用的 sharp。结果缓存 —— 一次失败不必每个文件重试一次，
 * 一次成功也不必每个文件重新解析一遍模块。
 */
export async function loadSharp(): Promise<SharpFactory | null> {
  if (cachedSharp !== undefined) return cachedSharp;

  try {
    const mod: unknown = await import(SHARP_SPECIFIER);
    // sharp 是 CJS，ESM 下拿到的是 { default: sharp, ...命名导出 }
    const candidate =
      typeof mod === 'object' && mod !== null && 'default' in mod
        ? (mod as { default: unknown }).default
        : mod;

    cachedSharp = typeof candidate === 'function' ? (candidate as SharpFactory) : null;
  } catch {
    // 没装 / 平台不匹配 / 原生二进制加载失败，都归到"这台机器上没有 sharp"
    cachedSharp = null;
  }

  return cachedSharp;
}

export interface SharpAssetOptions {
  /** 超过这个边长的图会被等比缩到该边长（仅 resize 操作使用） */
  defaultMaxWidth?: number;
}

export function createSharpAssetProcessor(options: SharpAssetOptions = {}): AssetProcessorPort {
  const defaultMaxWidth = options.defaultMaxWidth ?? 1920;

  return {
    async process(input: AssetProcessInput): Promise<AssetProcessResult | null> {
      const sharp = await loadSharp();
      // 没装 sharp：这张图不处理。返回 null 而不是抛错 ——
      // 一张图处理不了，不该让整条流水线失败。
      if (sharp === null) return null;

      const { file, buffer, operation, params } = input;

      try {
        switch (operation) {
          case 'convert-webp': {
            const quality = normalizeQuality(params['quality'], 80);
            const output = await sharp(Buffer.from(buffer)).webp({ quality }).toBuffer();
            return {
              outputFile: file.replace(/\.[^.]+$/, '.webp'),
              buffer: new Uint8Array(output),
              note: `webp q=${quality}`,
            };
          }

          case 'compress': {
            const quality = normalizeQuality(params['quality'], 75);
            const image = sharp(Buffer.from(buffer));
            const format = (await image.metadata()).format;

            // 按原格式压缩，避免"压缩"偷偷把格式也换了 —— 那会让体积对比失真
            const output =
              format === 'png'
                ? await image.png({ quality, compressionLevel: 9 }).toBuffer()
                : format === 'webp'
                  ? await image.webp({ quality }).toBuffer()
                  : await image.jpeg({ quality, mozjpeg: true }).toBuffer();

            return {
              outputFile: file,
              buffer: new Uint8Array(output),
              note: `${format ?? 'unknown'} q=${quality}`,
            };
          }

          case 'resize': {
            const width = numberParam(params, 'width', defaultMaxWidth);
            const output = await sharp(Buffer.from(buffer))
              .resize({ width, withoutEnlargement: true })
              .toBuffer();
            return {
              outputFile: file,
              buffer: new Uint8Array(output),
              note: `resize to width=${width}`,
            };
          }

          default:
            return null;
        }
      } catch (err) {
        // 处理失败返回 null（"这张图没法优化"）而不是抛错：
        // 一张损坏的图不该让整个候选失败。
        void err;
        return null;
      }
    },
  };
}

export function numberParam(params: Record<string, unknown>, key: string, fallback: number): number {
  const value = params[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * 画质参数归一化到 sharp 要求的 **0-100**。
 *
 * ## 这里踩过一次真实的坑
 *
 * 规划器最初传的是 `quality: 0.8`（小数，像在写百分比），而 sharp 要的是 0-100。
 * 结果 `quality: 0.8` 被 sharp 夹到 **1** —— 图片确实变得极小，
 * 画质也彻底毁了。而这件事在报告里**完全看不出来**：
 * 体积确实降了、门禁确实过了、图确实糊了。只有人打开页面才发现。
 *
 * 两种写法在代码里都很自然，因此这里两种都接受：
 * 0 < q ≤ 1 视为小数比例（×100），其余按 0-100 直接用。
 * 越界值一律夹到合法区间，而不是交给 sharp 去猜。
 */
export function normalizeQuality(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback;

  // 小数比例（0 < q ≤ 1）视为百分比，其余按 0-100 直接用
  const scaled = value <= 1 ? value * 100 : value;
  return Math.min(100, Math.max(1, Math.round(scaled)));
}

/** 探测图片尺寸，供「加 width/height 防 CLS」这类规则使用 */
export async function probeImageSize(
  buffer: Uint8Array,
): Promise<{ width: number; height: number } | null> {
  const sharp = await loadSharp();
  if (sharp === null) return null;

  try {
    const meta = await sharp(Buffer.from(buffer)).metadata();
    if (meta.width === undefined || meta.height === undefined) return null;
    return { width: meta.width, height: meta.height };
  } catch {
    return null;
  }
}
