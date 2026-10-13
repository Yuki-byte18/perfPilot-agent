import type { ExecutionContext, PlannedChange } from '@yuki-byte18/shared';
import { createExecutor, type FileEdit } from './common.js';

/**
 * 依赖改写执行器。
 *
 * 只动 `package.json`，且**只动 `dependencies` / `devDependencies` 两张表**：
 * 改 `peerDependencies` 会改变对外契约，改 `optionalDependencies` 会影响安装行为，
 * 这两类都不该由自动工具擅自决定。
 *
 * 所有改动都保持键的**原有顺序**（删掉即删掉，替换在原位改名），
 * 因为这决定了 patch 是否可读、是否会产生无谓的 diff 噪音。
 */

export interface PackageJsonLike {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

export interface MutationResult {
  pkg: PackageJsonLike;
  /** 实际发生的改动描述 */
  applied: string[];
  /** 未能执行的改动及原因 */
  skipped: string[];
}

const DEP_TABLES = ['dependencies', 'devDependencies'] as const;

/** 在两张依赖表里查找某个包，返回它在哪张表 */
export function findDependency(
  pkg: PackageJsonLike,
  name: string,
): { table: (typeof DEP_TABLES)[number]; version: string } | null {
  for (const table of DEP_TABLES) {
    const version = pkg[table]?.[name];
    if (version !== undefined) return { table, version };
  }
  return null;
}

/**
 * 移除依赖。
 *
 * `remove` 里列出但实际不存在的包记为 skipped 而不是报错 ——
 * 「本来就没有」和「没删成功」是两件事，前者不该让整个候选失败。
 */
export function removeDependencies(pkg: PackageJsonLike, names: readonly string[]): MutationResult {
  const next: PackageJsonLike = { ...pkg };
  const applied: string[] = [];
  const skipped: string[] = [];

  for (const name of names) {
    const found = findDependency(next, name);
    if (found === null) {
      skipped.push(`${name} 不在依赖表中`);
      continue;
    }

    const table = { ...(next[found.table] as Record<string, string>) };
    delete table[name];
    next[found.table] = table;
    applied.push(`移除 ${name}@${found.version}（${found.table}）`);
  }

  return { pkg: next, applied, skipped };
}

/**
 * 替换依赖：删旧、加新，**并保留原版本号的位置**。
 *
 * 直接 `delete old; pkg.dependencies[new] = version` 会把新包排到表尾，
 * 产出的 diff 看起来像"删一个加一个"；而按原位改名产出的 diff 是"改一行"。
 * 后者在 review 时明显更好读。
 */
export function replaceDependency(
  pkg: PackageJsonLike,
  from: string,
  to: string,
): MutationResult {
  const found = findDependency(pkg, from);
  if (found === null) {
    return { pkg, applied: [], skipped: [`${from} 不在依赖表中，无法替换`] };
  }

  if (findDependency(pkg, to) !== null) {
    return {
      pkg,
      applied: [],
      skipped: [`${to} 已存在，替换会造成重复声明`],
    };
  }

  const table = pkg[found.table] as Record<string, string>;
  const renamed: Record<string, string> = {};
  for (const [name, version] of Object.entries(table)) {
    // 原位改名：保持键的顺序
    renamed[name === from ? to : name] = version;
  }

  return {
    pkg: { ...pkg, [found.table]: renamed },
    applied: [`${from} → ${to}（${found.table}，保留 ${found.version}）`],
    skipped: [],
  };
}

/** 把 `PlannedChange` 应用到一个 package.json 对象上 */
export function applyDependencyChange(
  pkg: PackageJsonLike,
  change: Extract<PlannedChange, { type: 'dependency' }>,
): MutationResult {
  let current = pkg;
  const applied: string[] = [];
  const skipped: string[] = [];

  if (change.remove !== undefined && change.remove.length > 0) {
    const result = removeDependencies(current, change.remove);
    current = result.pkg;
    applied.push(...result.applied);
    skipped.push(...result.skipped);
  }

  if (change.replace !== undefined) {
    const result = replaceDependency(current, change.replace.from, change.replace.to);
    current = result.pkg;
    applied.push(...result.applied);
    skipped.push(...result.skipped);
  }

  return { pkg: current, applied, skipped };
}

async function applyDependency(
  change: PlannedChange,
  readFile: ExecutionContext['readFile'],
): Promise<FileEdit | { error: string } | null> {
  if (change.type !== 'dependency') return null;

  const file = 'package.json';
  const before = await readFile(file);
  if (before === null) return { error: '找不到 package.json' };

  let parsed: PackageJsonLike;
  try {
    parsed = JSON.parse(before) as PackageJsonLike;
  } catch (err) {
    return { error: `package.json 不是合法 JSON：${err instanceof Error ? err.message : String(err)}` };
  }

  const result = applyDependencyChange(parsed, change);
  if (result.applied.length === 0) {
    return { error: result.skipped.join('；') || '没有可执行的依赖改动' };
  }

  const indent = detectIndent(before);
  const trailing = before.endsWith('\n') ? '\n' : '';

  return {
    file,
    before,
    after: `${JSON.stringify(result.pkg, null, indent)}${trailing}`,
  };
}

/**
 * 探测原文件的缩进。
 *
 * 统一用 2 空格会把 4 空格缩进的项目改得满屏 diff，
 * 让"改了一行"看起来像"重写了整个文件"。
 */
function detectIndent(source: string): number | string {
  const match = /^([ \t]+)"/m.exec(source);
  if (match?.[1] === undefined) return 2;
  return match[1].includes('\t') ? '\t' : match[1].length;
}

export function createDependencyEditorExecutor() {
  return createExecutor({
    route: 'dependency-editor',
    accepts: (change) => change.type === 'dependency',
    apply: applyDependency,
  });
}
