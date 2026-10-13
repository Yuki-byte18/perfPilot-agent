import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';
import { parseJsonText } from '@yuki-byte18/shared';

/**
 * 把"构建产物里的资源路径"映射回**源文件**。
 *
 * ## 为什么需要这一层
 *
 * 构建产物里的文件名带哈希：`assets/promo-autumn-BjZS4kAo.png`；而源文件叫
 * `promo-autumn.png`，躺在 `public/` 或 `src/assets/` 里。于是"按产物路径去改
 * 这张图"必然找不到文件 —— 实测过一次，三条图片候选全部
 * `跳过：文件不存在：assets/promo-…-BjZS4kAo.png`，**图片优化从来没真正执行过**。
 *
 * ## 三条路，按可靠性排序
 *
 * 1. **构建清单**（Vite 的 `dist/.vite/manifest.json`）：`file` → `src` 是权威映射；
 * 2. **路径本身就存在**（没有构建步骤的资源，或 `public/` 被原样拷贝）；
 * 3. **去哈希 + 按文件名找**：先查常见资源目录，再退回有上限的全项目搜索。
 *
 * ## 认不出来就不认
 *
 * 第 3 条只在**唯一命中**时才返回。多个同名文件（`src/a/hero.png` 与
 * `src/b/hero.png`）时返回 null —— 改错文件的代价是静默改坏一张无关的图，
 * 而这个项目的一贯原则是：给不出来的就说给不出来。
 */

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|svg)$/i;

/** 构建哈希：`hero-BjZS4kAo.png` 里的 `-BjZS4kAo` */
const BUILD_HASH = /^(.*)-[A-Za-z0-9_-]{6,12}$/;

/** 常见资源目录（相对项目根），按命中概率排序 */
const COMMON_ROOTS = [
  '',
  'public',
  'src/assets',
  'src/images',
  'src/static',
  'src',
  'assets',
  'static',
  'images',
];

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.output',
  '.perfpilot',
  '.turbo',
  '.cache',
]);

/** 全项目搜索的上限：够找资源，又不至于在大仓库上卡住 */
const MAX_SCAN_FILES = 5000;

export interface SourceAssetResolver {
  /** 传产物相对路径（`assets/hero-BjZS4kAo.png`），返回项目根相对的源文件路径 */
  resolve(assetPath: string): Promise<string | null>;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function toPosix(path: string): string {
  return path.split('\\').join('/');
}

/** 去掉构建哈希：`hero-BjZS4kAo.png` → `hero.png`；没有哈希时返回原名 */
function withoutHash(path: string): string {
  const ext = extname(path);
  const stem = basename(path, ext);
  const matched = BUILD_HASH.exec(stem);
  const stripped = matched?.[1];
  return stripped === undefined || stripped === '' ? basename(path) : `${stripped}${ext}`;
}

export async function createSourceAssetResolver(options: {
  projectRoot: string;
  distDir: string;
}): Promise<SourceAssetResolver> {
  const { projectRoot, distDir } = options;

  const fromManifest = new Map<string, string>();
  for (const candidate of [
    join(distDir, '.vite', 'manifest.json'),
    join(projectRoot, 'dist', '.vite', 'manifest.json'),
  ]) {
    try {
      const manifest = parseJsonText(await readFile(candidate, 'utf8')) as Record<
        string,
        { file?: unknown; src?: unknown }
      >;
      for (const entry of Object.values(manifest)) {
        if (typeof entry?.file === 'string' && typeof entry?.src === 'string') {
          fromManifest.set(toPosix(entry.file), toPosix(entry.src));
        }
      }
      if (fromManifest.size > 0) break;
    } catch {
      // 没有清单是常态：走下面的启发式
    }
  }

  const cache = new Map<string, string | null>();

  const compute = async (assetPath: string): Promise<string | null> => {
    const normalized = toPosix(assetPath).replace(/^\/+/, '');

    // 1) 构建清单里的权威映射
    const mapped = fromManifest.get(normalized);
    if (mapped !== undefined && (await isFile(join(projectRoot, mapped)))) return mapped;

    // 2) 这个路径本身就是源文件
    if (await isFile(join(projectRoot, normalized))) return normalized;
    if (await isFile(join(projectRoot, 'public', normalized))) return `public/${normalized}`;

    // 3) 去哈希后按文件名找，**唯一命中才认**
    const wanted = withoutHash(normalized);
    const hits = new Set<string>();

    for (const root of COMMON_ROOTS) {
      const candidate = root === '' ? wanted : toPosix(join(root, wanted));
      if (await isFile(join(projectRoot, candidate))) hits.add(candidate);
      if (hits.size > 1) return null;
    }

    if (hits.size === 0) {
      for (const found of await findByBasename(projectRoot, wanted)) hits.add(found);
    }

    return hits.size === 1 ? ([...hits][0] ?? null) : null;
  };

  return {
    async resolve(assetPath: string): Promise<string | null> {
      const cached = cache.get(assetPath);
      if (cached !== undefined) return cached;

      const resolved = await compute(assetPath);
      cache.set(assetPath, resolved);
      return resolved;
    },
  };
}

/** 有上限的全项目搜索：只看图片文件名，命中 2 个就停（多命中即放弃） */
async function findByBasename(root: string, wanted: string): Promise<string[]> {
  const found: string[] = [];
  const queue: string[] = [root];
  let visited = 0;
  const target = wanted.toLowerCase();

  while (queue.length > 0 && visited < MAX_SCAN_FILES && found.length < 2) {
    const dir = queue.shift();
    if (dir === undefined) break;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (visited >= MAX_SCAN_FILES || found.length >= 2) break;

      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) queue.push(join(dir, entry.name));
        continue;
      }

      visited += 1;
      if (!IMAGE_EXT.test(entry.name) || entry.name.toLowerCase() !== target) continue;
      found.push(toPosix(relative(root, join(dir, entry.name))));
    }
  }

  return found;
}

/**
 * 给产物清单里的**图片**补上源文件路径。
 *
 * 非图片一律不动：`index.html`、`assets/index-*.js` 这些路径对规则是有意义的
 * 产物路径（渲染阻塞、体积汇总都按它们判断），映射成 `src/index.html` 反而会把
 * 判断弄坏。
 */
export async function attachSourcePaths(
  files: readonly { path: string; size: number }[],
  options: { projectRoot: string; distDir: string },
): Promise<Array<{ path: string; size: number; sourcePath: string | null }>> {
  const resolver = await createSourceAssetResolver(options);
  const out: Array<{ path: string; size: number; sourcePath: string | null }> = [];

  for (const file of files) {
    out.push({
      ...file,
      sourcePath: IMAGE_EXT.test(file.path) ? await resolver.resolve(file.path) : null,
    });
  }

  return out;
}
