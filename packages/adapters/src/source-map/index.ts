import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { FlattenMap, TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import {
  parseJsonText,
  tryParseExternal,
  type GeneratedLocation,
  type OriginalLocation,
  type SourceMapPort,
} from '@yuki-byte18/shared';
import { SourceMapSchema } from './schema.js';

export interface SourceMapAdapterOptions {
  /** 项目根目录；返回的 source 相对它 */
  root: string;
  /**
   * 查找 .map 文件的搜索根，按顺序尝试。
   *
   * 需要多个是因为**两边的路径基准不同**：trace / HAR 记录的是部署后的 URL
   * （`https://host/assets/index.js`），去掉 origin 只剩 `assets/index.js`；
   * 而磁盘上的 .map 通常在构建产物目录里（`dist/assets/index.js.map`）。
   * 只用一个根的话，生产环境里这条归因链永远断在「找不到 map」。
   */
  searchRoots?: readonly string[];
  /** map 文件候选后缀，按顺序尝试 */
  suffixes?: readonly string[];
}

const DEFAULT_SUFFIXES = ['.map'] as const;

/** 载入结果：映射表 + 它所在目录（sources 相对该目录解析） */
interface LoadedMap {
  map: TraceMap;
  dir: string;
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

/** node_modules 里的源码：值得知道，但归因到它通常没法直接改 */
function isDependencySource(source: string): boolean {
  return source.split(/[\\/]/).includes('node_modules');
}

/**
 * 构造映射表。
 *
 * 分段 map（index map，多 chunk 拼接时由构建工具产出）必须走 `FlattenMap`：
 * `TraceMap` 会直接抛 "passed sectioned source map, please use FlattenMap export instead"。
 * 这两种形态在上层是同一个东西，所以在这里统一掉，端口只暴露 `resolve`。
 */
function buildMap(parsed: unknown): TraceMap {
  const hasSections =
    typeof parsed === 'object' &&
    parsed !== null &&
    Array.isArray((parsed as { sections?: unknown }).sections) &&
    (parsed as { sections: unknown[] }).sections.length > 0;

  const AnyMap = parsed as Parameters<typeof FlattenMap>[0];
  return hasSections ? new FlattenMap(AnyMap) : new TraceMap(AnyMap as never);
}

/**
 * 把 map 里的 source 路径规范成相对项目根的路径。
 *
 * 三种前缀要分开处理，它们语义完全不同：
 * - `webpack:///./src/a.ts` —— 虚拟协议，约定相对**项目根**，不能拿 map 目录去拼
 * - `file:///abs/path` —— 绝对路径，去掉协议即可
 * - `./src/a.ts` —— **相对 map 文件所在目录**（source map 规范），这是最常被写错的一条：
 *   拿项目根去拼，`./src/a.ts` 恰好对，`../src/a.ts` 就错了
 *
 * 落在项目外的源码保留绝对路径，不制造 `../../../` 这种没法读的归因。
 */
function normalizeSource(raw: string, mapDir: string, root: string): string {
  const webpack = /^webpack:\/\/\/?\.?\/?/.exec(raw);
  if (webpack !== null) {
    return toPosix(raw.slice(webpack[0].length).replace(/^\.\//, ''));
  }

  const withoutProtocol = raw.startsWith('file://') ? raw.slice('file://'.length) : raw;
  const absolute = isAbsolute(withoutProtocol)
    ? withoutProtocol
    : resolve(mapDir, withoutProtocol);

  const rel = relative(root, absolute);
  return rel.startsWith('..') ? toPosix(absolute) : toPosix(rel);
}

/**
 * 基于 `@jridgewell/trace-mapping` 的 Source Map 解析。
 *
 * **为什么不自己解 VLQ。** mapping 段是 Base64 VLQ 编码的变长字段，还要处理
 * sourceRoot 拼接、index map 的 sections、`originalPositionFor` 的
 * 「不大于给定列号的最近一段」语义。手写一版能把 fixture 跑绿，
 * 却很容易在真实产物上给出**错位的行号** —— 而错位的行号比没有行号更糟：
 * 它会让开发者去改一行完全无关的代码。
 *
 * 这个库零依赖、几十 KB，Vite / Rollup 用的就是它。
 */
export function createSourceMapAdapter(options: SourceMapAdapterOptions): SourceMapPort {
  const root = resolve(options.root);
  const searchRoots = (options.searchRoots ?? [root]).map((r) => resolve(r));
  const suffixes = options.suffixes ?? DEFAULT_SUFFIXES;

  /** generatedFile → 载入结果（null = 查过了，确实没有） */
  const cache = new Map<string, LoadedMap | null>();

  const loadMap = async (generatedFile: string): Promise<LoadedMap | null> => {
    const key = toPosix(generatedFile);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    // 相对路径按每个搜索根各试一次：项目根 / 构建产物目录
    const bases = isAbsolute(generatedFile)
      ? [generatedFile]
      : searchRoots.map((searchRoot) => join(searchRoot, generatedFile));

    let loaded: LoadedMap | null = null;

    for (const base of bases) {
      for (const suffix of suffixes) {
        for (const candidate of [`${base}${suffix}`, `${base}.js${suffix}`]) {
          try {
            const raw = parseJsonText(await readFile(candidate, 'utf8'));
            const parsed = tryParseExternal(SourceMapSchema, raw);
            if (parsed === null) continue;
            // 记住 map 的**实际所在目录**：sources 是相对它解析的，不是相对项目根
            loaded = { map: buildMap(parsed), dir: dirname(candidate) };
            break;
          } catch {
            // 该候选不存在或不可解析，继续试下一个
          }
        }
        if (loaded !== null) break;
      }
      if (loaded !== null) break;
    }

    cache.set(key, loaded);
    return loaded;
  };

  return {
    async resolve(generated: GeneratedLocation): Promise<OriginalLocation | null> {
      const loaded = await loadMap(generated.file);
      if (loaded === null) return null;

      let original;
      try {
        original = originalPositionFor(loaded.map, {
          line: generated.line,
          column: generated.column,
        });
      } catch {
        // 损坏的 mappings：宁可不归因，也不能让整条诊断失败
        return null;
      }

      if (original.source === null || original.line === null) return null;

      const source = normalizeSource(original.source, loaded.dir, root);

      return {
        source,
        line: original.line,
        column: original.column ?? 0,
        name: original.name ?? null,
        fromDependency: isDependencySource(source),
      };
    },

    async warmup(files: readonly string[]): Promise<void> {
      await Promise.all(files.map((file) => loadMap(file)));
    },
  };
}

/** 纯内存实现已挪到 `@yuki-byte18/shared`（端口在哪，替身就在哪）；此处转出以保持导入路径稳定 */
export { createInMemorySourceMap } from '@yuki-byte18/shared';
