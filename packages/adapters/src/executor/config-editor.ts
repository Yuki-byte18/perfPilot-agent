import type { ExecutionContext, PlannedChange } from '@yuki-byte18/shared';
import { createExecutor, type FileEdit } from './common.js';

/**
 * 配置改写执行器。
 *
 * 处理的就是规划器已经给出 `before` / `after` 的那类改动 ——
 * 例如「把 `build.compress` 从 false 改成 'brotli'」。
 *
 * 两种改法，按文件类型分派：
 *
 * - **JSON**（`package.json` / `tsconfig.json` 等）：解析 → 改键 → 重新序列化。
 *   用结构化改写而不是文本替换，是因为文本替换会在键名出现在别处（注释、字符串值）
 *   时改错地方。
 * - **其它文本**（`vite.config.ts` / `nginx.conf` 等）：按键名做**精确文本替换**，
 *   且要求命中次数唯一 —— 命中 0 次或多次都拒绝。
 *   在无法解析语义的文件里，"唯一命中"是能给出的最强保证。
 */

/** 把 `a.b.c` 这样的键路径拆开 */
export function splitKeyPath(key: string): string[] {
  return key.split('.').filter((part) => part !== '');
}

/** 读取嵌套键；任一层缺失返回 undefined */
export function getByPath(root: unknown, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const part of path) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** 写入嵌套键，沿途缺失的对象会被创建 */
export function setByPath(root: Record<string, unknown>, path: readonly string[], value: unknown): boolean {
  if (path.length === 0) return false;

  let current: Record<string, unknown> = root;
  for (const part of path.slice(0, -1)) {
    const next = current[part];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }

  const last = path[path.length - 1] as string;
  if (current[last] === value) return false;
  current[last] = value;
  return true;
}

function isJsonFile(file: string): boolean {
  return /\.json$/i.test(file);
}

function isHtmlFile(file: string): boolean {
  return /\.html?$/i.test(file);
}

/**
 * 把片段插到 `</head>` 之前，并让它看起来**本来就属于 head**。
 *
 * 缩进分两步定：优先沿用 head 里最后一个子元素的缩进（那才是子元素的层级），
 * 空 head 时退化成 `</head>` 的缩进 + 一个缩进单位。
 * 直接拿 `</head>` 的缩进会让 link 看起来是 `<head>` 的**兄弟节点** ——
 * 语法上仍在 head 里（HTML 解析器不看缩进），但读代码的人看到的是错的。
 *
 * **只在结束标签独占一行时才动手。** `<head><title>x</title></head>` 这种
 * 一行到底的写法，插进去要么破坏可读性、要么改变空白语义，交给人处理更安全 ——
 * 拒绝并说明原因，比产出一个"看起来能 apply"的可疑补丁好。
 */
export function insertBeforeClosingHead(
  source: string,
  snippet: string,
): { content: string } | { error: string } {
  const match = /^([ \t]*)<\/head\s*>/im.exec(source);
  if (match === null) return { error: '找不到独占一行的 </head>，无法确定插入位置' };

  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const headIndent = match[1] ?? '';
  const at = match.index;

  const lines = source.slice(0, at).split(/\r?\n/);
  const previous = [...lines].reverse().find((line) => line.trim() !== '');
  const previousIndent = previous === undefined ? '' : (/^[ \t]*/.exec(previous)?.[0] ?? '');
  const indent =
    previousIndent.length > headIndent.length ? previousIndent : headIndent + indentUnitOf(source);

  return { content: `${source.slice(0, at)}${indent}${snippet}${eol}${source.slice(at)}` };
}

/** 文件自己的缩进单位：取第一个有缩进的行的前导空白，认不出来时按两个空格 */
function indentUnitOf(source: string): string {
  for (const line of source.split(/\r?\n/)) {
    const indent = /^[ \t]+/.exec(line)?.[0];
    if (indent !== undefined) return indent;
  }
  return '  ';
}

/**
 * 文本文件里的精确替换。
 *
 * 只在**恰好命中一次**时替换：命中 0 次说明配置里根本没有这一项（改了等于没改），
 * 命中多次说明无法确定改哪一处（改错比不改更糟）。两种都返回原因而不是硬改。
 */
export function replaceUnique(
  source: string,
  needle: string,
  replacement: string,
): { content: string } | { error: string } {
  const first = source.indexOf(needle);
  if (first < 0) return { error: `未找到待修改内容：${needle}` };

  const second = source.indexOf(needle, first + needle.length);
  if (second >= 0) return { error: `待修改内容出现多次，无法确定目标：${needle}` };

  return { content: source.slice(0, first) + replacement + source.slice(first + needle.length) };
}

/** 把 before/after 渲染成该文件语法中的字面量 */
function literal(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value);
}

async function applyConfig(
  change: PlannedChange,
  readFile: ExecutionContext['readFile'],
): Promise<FileEdit | { error: string } | null> {
  if (change.type !== 'config') return null;

  const before = await readFile(change.file);
  if (before === null) return { error: `文件不存在：${change.file}` };

  if (isJsonFile(change.file)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(before);
    } catch (err) {
      return { error: `${change.file} 不是合法 JSON：${err instanceof Error ? err.message : String(err)}` };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { error: `${change.file} 的顶层不是对象，无法按键改写` };
    }

    const path = splitKeyPath(change.key);
    const current = getByPath(parsed, path);

    // 现值与预期不符时不改：说明配置结构与规划时的假设不一样，
    // 强行写入可能覆盖掉别人刚做的修改
    if (current !== undefined && JSON.stringify(current) !== JSON.stringify(change.before)) {
      return {
        error: `${change.file} 中 ${change.key} 当前值为 ${JSON.stringify(current)}，与预期 ${JSON.stringify(change.before)} 不符`,
      };
    }

    const changed = setByPath(parsed as Record<string, unknown>, path, change.after);
    if (!changed) return { error: `${change.file} 中 ${change.key} 已是目标值` };

    // 保持结尾换行，避免产出 `\ No newline at end of file` 噪音
    const trailing = before.endsWith('\n') ? '\n' : '';
    return { file: change.file, before, after: `${JSON.stringify(parsed, null, 2)}${trailing}` };
  }

  /**
   * 非 JSON 且 `before` 为空 —— 它的意思是「这个键还不存在」，要做的是**插入**。
   *
   * 只支持 HTML：把片段插到 `</head>` 之前（`add-preload` 那条 A 类规则就是它）。
   * 在 JS/TS 配置文件里新建一个键**刻意不做**：那等于往用户的配置里插代码，
   * 需要解析对象字面量的结构、判断同名顶层键是否已存在、还要猜缩进风格，
   * 改错的代价远高于不做。拒绝并说清原因，让人手动加一行更负责任。
   */
  if (change.before === null || change.before === undefined) {
    if (!isHtmlFile(change.file)) {
      return {
        error:
          `${change.file} 不是 JSON，也没有可定位的 before：在配置文件里新建一个键` +
          `本执行器刻意不支持，请手动添加（或在 issue 里说明需要的键）`,
      };
    }

    if (typeof change.after !== 'string') {
      return { error: `${change.file} 的 after 不是字符串，无法作为 HTML 片段插入` };
    }

    const inserted = insertBeforeClosingHead(before, change.after);
    if ('error' in inserted) return { error: `${change.file}：${inserted.error}` };

    return { file: change.file, before, after: inserted.content };
  }

  if (typeof change.before !== 'string') {
    return { error: `${change.file} 的 before 不是字符串，无法在非 JSON 文件中定位` };
  }

  const replaced = replaceUnique(before, change.before, literal(change.after));
  if ('error' in replaced) return { error: `${change.file}：${replaced.error}` };

  return { file: change.file, before, after: replaced.content };
}

export function createConfigEditorExecutor() {
  return createExecutor({
    route: 'config-editor',
    accepts: (change) => change.type === 'config',
    apply: applyConfig,
  });
}
