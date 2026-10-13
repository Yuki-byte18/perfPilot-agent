import { readFile, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  AdapterError,
  PackageJsonSnapshotSchema,
  parseJsonText,
  tryParseExternal,
  type RawArtifact,
  type RawRunner,
} from '@yuki-byte18/shared';
import { BUNDLE_SCAN_KIND } from './parse.js';
import type { BundleScanPayload } from './schema.js';

export const DEFAULT_DIST_DIR = 'dist';
export const STATS_FILE = 'stats.json';

export interface BundleAnalyzerRunnerOptions {
  /** 构建产物目录，相对路径按 `root` 解析 */
  distDir?: string;
  root?: string;
  /** 单次扫描的文件数上限，防止误指向 node_modules 时卡死 */
  maxFiles?: number;
  /** 是否读取 package.json 快照（供 tree shaking 之类的配置类规则归因） */
  readPackageJson?: boolean;
}

export function resolveDistDir(options: BundleAnalyzerRunnerOptions = {}): string {
  const distDir = options.distDir ?? process.env.PERFPILOT_DIST_DIR ?? DEFAULT_DIST_DIR;
  if (isAbsolute(distDir)) return distDir;
  return resolve(options.root ?? process.cwd(), distDir);
}

export async function probeBundleAnalyzer(
  options: BundleAnalyzerRunnerOptions = {},
): Promise<boolean> {
  try {
    const info = await stat(resolveDistDir(options));
    return info.isDirectory();
  } catch {
    return false;
  }
}

async function walk(dir: string, root: string, limit: number): Promise<Array<{ path: string; size: number }>> {
  const out: Array<{ path: string; size: number }> = [];
  const queue: string[] = [dir];

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;

    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
        continue;
      }
      if (!entry.isFile()) continue;

      const info = await stat(full);
      out.push({ path: relative(root, full).split(sep).join('/'), size: info.size });
      if (out.length >= limit) return out;
    }
  }

  return out;
}

/**
 * stats.json 的形态随构建工具而异，这里只认最小公约数：
 * `{ modules: [{ name, size }] }`（webpack / rspack / vite-plugin 均可产出）。
 * 认不出来就退回目录扫描 —— 少一个指标，好过报一个错的。
 */
function readStatsModules(stats: unknown): BundleScanPayload['modules'] {
  if (typeof stats !== 'object' || stats === null) return [];
  const modules = (stats as { modules?: unknown }).modules;
  if (!Array.isArray(modules)) return [];

  const out: BundleScanPayload['modules'] = [];
  for (const entry of modules) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { name, size } = entry as { name?: unknown; size?: unknown };
    if (typeof name === 'string' && typeof size === 'number' && Number.isFinite(size)) {
      out.push({ name, size });
    }
  }
  return out;
}

/**
 * 读取 package.json 快照。
 *
 * 只取诊断用得上的三个字段：`sideEffects`（关掉它等于关掉 tree shaking）、
 * 以及依赖表（用于识别 moment / lodash 这类「有更轻替代品」的库）。
 * 读不到就返回 null —— 少一条配置类规则，好过整轮采集失败。
 */
async function readPackageJson(root: string): Promise<BundleScanPayload['packageJson']> {
  try {
    const raw = parseJsonText(await readFile(join(root, 'package.json'), 'utf8'));
    const parsed = tryParseExternal(PackageJsonSnapshotSchema, raw);
    return parsed;
  } catch {
    return null;
  }
}

export function createBundleAnalyzerRunner(
  options: BundleAnalyzerRunnerOptions = {},
): RawRunner {
  const maxFiles = options.maxFiles ?? 20_000;
  const readPkg = options.readPackageJson ?? true;

  return async (ctx): Promise<RawArtifact[]> => {
    const distDir = resolveDistDir(options);

    let files: BundleScanPayload['files'];
    try {
      files = await walk(distDir, distDir, maxFiles);
    } catch (err) {
      throw new AdapterError(`构建产物目录不可读: ${distDir}`, {
        code: 'ADAPTER_FAILED',
        stage: 'collect',
        retryable: false,
        details: { distDir },
        cause: err,
      });
    }

    let modules: BundleScanPayload['modules'] = [];
    let source: BundleScanPayload['source'] = 'scan';
    try {
      const stats = parseJsonText(await readFile(join(distDir, STATS_FILE), 'utf8'));
      modules = readStatsModules(stats);
      if (modules.length > 0) source = 'stats';
    } catch {
      // stats.json 不存在或不可解析：静默退回目录扫描，这是预期路径而非错误
    }

    // package.json 在项目根，不在 dist 里
    const projectRoot = options.root ?? process.cwd();
    const packageJson = readPkg ? await readPackageJson(projectRoot) : null;

    const payload: BundleScanPayload = { distDir, source, files, modules, packageJson };

    return [
      {
        adapter: 'bundle-analyzer',
        kind: BUNDLE_SCAN_KIND,
        payload,
        collectedAt: new Date().toISOString(),
        route: ctx.route,
        device: ctx.device,
        file: null,
      },
    ];
  };
}
