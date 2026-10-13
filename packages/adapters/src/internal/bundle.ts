import type { BundleFile, BundleModule, MetricName } from '@yuki-byte18/shared';
import { samples } from './samples.js';

export type { BundleFile, BundleModule };

const EXTENSION_METRIC: ReadonlyArray<readonly [readonly string[], MetricName]> = [
  [['.js', '.mjs', '.cjs'], 'JS_SIZE'],
  [['.css'], 'CSS_SIZE'],
  [['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.ico'], 'IMAGE_SIZE'],
];

export function extensionOf(filePath: string): string {
  const base = filePath.split(/[?#]/)[0] ?? filePath;
  const dot = base.lastIndexOf('.');
  if (dot < 0) return '';
  return base.slice(dot).toLowerCase();
}

/** 按扩展名汇总构建产物体积 */
export function computeBundleSizes(files: readonly BundleFile[]): ReturnType<typeof samples> {
  const totals = new Map<MetricName, number>();

  for (const file of files) {
    if (!Number.isFinite(file.size)) continue;
    const ext = extensionOf(file.path);
    for (const [extensions, metric] of EXTENSION_METRIC) {
      if (extensions.includes(ext)) {
        totals.set(metric, (totals.get(metric) ?? 0) + file.size);
        break;
      }
    }
  }

  return samples([
    ['JS_SIZE', totals.get('JS_SIZE') ?? null],
    ['CSS_SIZE', totals.get('CSS_SIZE') ?? null],
    ['IMAGE_SIZE', totals.get('IMAGE_SIZE') ?? null],
  ]);
}

export interface PackageLocation {
  /** 包名，含 scope（如 `@scope/name`） */
  name: string;
  /** 版本；无法从路径判断时为 null */
  version: string | null;
  /** node_modules 中的安装位置，用于区分「同一版本的多次安装」 */
  location: string;
}

const PNPM_RE =
  /(?:^|\/)node_modules\/\.pnpm\/([^/]+)\/node_modules\/((?:@[^/]+\/)?[^/]+)\//;

/**
 * 注意用 **lookbehind** 而不是 `(?:^|\/)`。
 *
 * 写成 `(?:^|\/)` 时，前一个匹配会把 `node_modules/a/` 末尾的 `/` 一起吃掉，
 * 于是嵌套路径 `node_modules/a/node_modules/lodash/` 里的第二段永远匹配不到 ——
 * 结果为外层宿主包 `a`，重复依赖检测会整体失效。lookbehind 不消耗分隔符，
 * 相邻的 `node_modules/` 段才能逐个被识别。
 */
const PLAIN_RE = /(?<=^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//g;

/**
 * pnpm 目录名形如 `lodash@4.17.21` 或 `@scope+name@1.0.0`（scope 里的 `/` 被换成 `+`）。
 * 返回 pnpm key 所描述的包名与版本。
 */
function parsePnpmKey(key: string): { name: string; version: string | null } {
  const at = key.lastIndexOf('@');
  const bare = at > 0 ? key.slice(0, at) : key;
  return {
    // pnpm 的 `+` 对应包名里的 `/`
    name: bare.replace('+', '/'),
    version: at > 0 ? key.slice(at + 1) || null : null,
  };
}

/**
 * 从模块路径里还原出「这是哪个包的哪一份安装」。
 *
 * 支持两种布局：
 * - pnpm：`node_modules/.pnpm/lodash@4.17.21/node_modules/lodash/index.js`
 * - npm/yarn 嵌套：`node_modules/a/node_modules/lodash/index.js`
 *
 * 嵌套布局下必须取**最后一个** `node_modules/` 匹配：`node_modules/a/node_modules/lodash/`
 * 里真正被打包的包是 lodash，取第一个匹配会得到 a，重复依赖检测就全错了。
 * 正则用 lookbehind 而非 `(?:^|\/)`，否则前一个匹配会吃掉分隔符、
 * 导致相邻的 `node_modules/` 段匹配不到。
 *
 * 返回 null 表示这是项目自身源码（如 `./src/App.tsx`），不参与依赖统计。
 */
export function extractPackage(moduleName: string): PackageLocation | null {
  const normalized = moduleName.replace(/\\/g, '/');

  const pnpm = PNPM_RE.exec(normalized);
  if (pnpm?.[1] !== undefined && pnpm[2] !== undefined && pnpm.index !== undefined) {
    const name = pnpm[2];
    const key = parsePnpmKey(pnpm[1]);

    return {
      name,
      // 只有当 pnpm key 描述的包与目录里的包是同一个时，版本号才是它的。
      // `.pnpm/lib@1.0.0/node_modules/lodash/` 这种不一致的布局确实会出现
      // （软链、手工构造的路径），此时 key 里的 1.0.0 是 lib 的版本，
    // 记到 lodash 头上会污染「重复依赖」的版本报告。
      version: key.name === name ? key.version : null,
      // 截到 `node_modules/<name>/` 为止，即这一次安装的唯一位置
      location: normalized.slice(0, pnpm.index + pnpm[0].length),
    };
  }

  // 嵌套安装要取最内层：全局匹配后取最后一项
  const matches = [...normalized.matchAll(PLAIN_RE)];
  const last = matches.at(-1);
  if (last?.[1] === undefined || last.index === undefined) return null;

  return {
    name: last[1],
    version: null,
    location: normalized.slice(0, last.index + last[0].length),
  };
}

export interface DuplicateReport {
  /** 出现了多份安装的包数量 */
  count: number;
  /** 包名 → 安装份数，供报告下钻 */
  details: Array<{ name: string; copies: number; versions: string[] }>;
}

/**
 * 重复依赖检测。
 *
 * 判据是**安装位置**而非版本号：同一个 lodash@4.17.21 被装进两处
 * `node_modules`，同样是重复打包，一样会进用户下载的 bundle。
 * 只按版本号去重会漏掉这一类，而那恰恰是 monorepo 里最常见的情况。
 */
export function findDuplicatePackages(modules: readonly BundleModule[]): DuplicateReport {
  const locations = new Map<string, Set<string>>();
  const versions = new Map<string, Set<string>>();

  for (const module of modules) {
    const pkg = extractPackage(module.name);
    if (!pkg) continue;
    if (!locations.has(pkg.name)) locations.set(pkg.name, new Set());
    locations.get(pkg.name)?.add(pkg.location);
    if (pkg.version !== null) {
      if (!versions.has(pkg.name)) versions.set(pkg.name, new Set());
      versions.get(pkg.name)?.add(pkg.version);
    }
  }

  const details: DuplicateReport['details'] = [];
  for (const [name, set] of locations) {
    if (set.size > 1) {
      details.push({
        name,
        copies: set.size,
        versions: [...(versions.get(name) ?? [])].sort(),
      });
    }
  }

  details.sort((a, b) => b.copies - a.copies || a.name.localeCompare(b.name));
  return { count: details.length, details };
}
