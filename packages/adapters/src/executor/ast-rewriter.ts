import { Project, SyntaxKind, type SourceFile } from 'ts-morph';
import type { ExecutionContext, PlannedChange } from '@yuki-byte18/shared';
import { createExecutor, resolveExistingFile, type FileEdit } from './common.js';
import { splitRouteComponents } from './route-splitter.js';

/**
 * AST 改写执行器（ts-morph）。
 *
 * ## 为什么需要「变换表」而不是直接用 description
 *
 * 规划器（M3）产出的是**意图**：
 *
 * ```ts
 * { type: 'ast', file: 'index.html', node: 'script-or-link-tag',
 *   description: '为 https://.../index.js 添加 defer 或 media="print" onload 切换' }
 * ```
 *
 * `description` 是给人看的自然语言，不能拿来执行。执行器需要一个**稳定的变换标识**
 * 才能知道「到底改什么」，因此规定：**`node` 字段就是变换 id**。
 *
 * 这也解释了为什么变换表里只有三个条目：**只收录真正能安全自动化的变换**。
 * 「为长列表引入虚拟滚动」这类改动语义风险太高，列出 id 只会诱使别人去实现一个
 * 半可靠的版本 —— 它应该留在 C 类只出建议。不认识 id 时返回 null，
 * 由上层记为「需要人工」，而不是产出一个半成品补丁。
 */

// ─────────────────────────────────────────────────────────────────────
// HTML 变换
// ─────────────────────────────────────────────────────────────────────

/**
 * 给 `<img>` 加 `loading="lazy"`。
 *
 * 只改**没有** loading 属性的 img；已有 `loading="eager"` 的不动 ——
 * 那是开发者显式声明「这张图在首屏，必须立刻加载」。
 * 带 `fetchpriority="high"` 的同样跳过，那是显式提权的信号。
 */
export function addLoadingLazy(html: string): { html: string; changed: number } {
  let changed = 0;

  const next = html.replace(/<img\b([^>]*)>/gi, (match, attrs: string) => {
    if (/\bloading\s*=/i.test(attrs)) return match;
    if (/\bfetchpriority\s*=\s*["']?high/i.test(attrs)) return match;
    // 自闭合形式保持原样：`<img ... />`
    changed += 1;
    return `<img${attrs} loading="lazy">`.replace(/\s+\/>$/, ' />');
  });

  return { html: next, changed };
}

/**
 * 给阻塞解析的 `<script src>` 加 `defer`。
 *
 * 跳过：已有 `defer` / `async` / `type="module"` 的（module 默认 deferred）、
 * 以及内联脚本（内联脚本没有 src，加 defer 无意义）。
 */
export function addDeferScript(html: string): { html: string; changed: number } {
  let changed = 0;

  const next = html.replace(/<script\b([^>]*)>/gi, (match, attrs: string) => {
    if (!/\bsrc\s*=/i.test(attrs)) return match;
    if (/\b(defer|async)\b/i.test(attrs)) return match;
    if (/\btype\s*=\s*["']?module/i.test(attrs)) return match;
    changed += 1;
    return `<script${attrs} defer>`;
  });

  return { html: next, changed };
}

// ─────────────────────────────────────────────────────────────────────
// React 变换（用 ts-morph 做真正的语法树改写）
// ─────────────────────────────────────────────────────────────────────

/** 匹配 `export default function Foo(` 或 `const Foo = (` 这类可 memo 化的组件 */
const MEMO_TARGET = /^[A-Z]/;

/**
 * 用 `React.memo` 包裹默认导出的函数组件。
 *
 * 用 ts-morph 而不是正则：需要判断
 * - 目标是不是函数组件（首字母大写、是函数声明或箭头函数）
 * - 是否**已经**被 memo 包过（避免二次包裹）
 * - import 语句怎么加（已有 react import 就改它，没有就新增）
 *
 * 这些判断用正则会写出一个看起来能跑、遇到边界就错的版本。
 */
export function wrapWithMemo(source: string): { source: string; changed: boolean; reason?: string } {
  const project = new Project({ useInMemoryFileSystem: true });
  const file: SourceFile = project.createSourceFile('component.tsx', source);

  // 已 memo 过就不再包
  if (source.includes('React.memo') || source.includes('memo(')) {
    return { source, changed: false, reason: '已经是 memo 组件' };
  }

  const exported = file.getDefaultExportSymbol();
  if (exported === undefined) {
    return { source, changed: false, reason: '没有默认导出，无法确定要 memo 化的组件' };
  }

  // 找到默认导出的函数声明 / 箭头函数变量
  let target: string | null = null;

  for (const fn of file.getFunctions()) {
    if (!fn.isDefaultExport()) continue;
    const name = fn.getName();
    if (name === undefined || !MEMO_TARGET.test(name)) {
      return { source, changed: false, reason: '默认导出不是首字母大写的组件' };
    }
    target = name;
  }

  if (target === null) {
    for (const decl of file.getVariableDeclarations()) {
      const name = decl.getName();
      const init = decl.getInitializer();
      if (init === undefined || !MEMO_TARGET.test(name)) continue;
      const kind = init.getKind();
      if (kind !== SyntaxKind.ArrowFunction && kind !== SyntaxKind.FunctionExpression) continue;
      const statement = decl.getVariableStatement();
      if (statement?.isDefaultExport() !== true) continue;
      target = name;
    }
  }

  if (target === null) {
    return { source, changed: false, reason: '未找到可 memo 化的默认导出组件' };
  }

  // 确保有 React 的具名导入
  const reactImport = file.getImportDeclaration(
    (d) => d.getModuleSpecifierValue() === 'react',
  );

  if (reactImport === undefined) {
    file.addImportDeclaration({ moduleSpecifier: 'react', namedImports: ['memo'] });
  } else if (!reactImport.getNamedImports().some((n) => n.getName() === 'memo')) {
    reactImport.addNamedImport('memo');
  }

  // 把默认导出改成对 memo(Component) 的默认导出
  for (const fn of file.getFunctions()) {
    if (fn.getName() !== target || !fn.isDefaultExport()) continue;
    fn.setIsDefaultExport(false);
    file.addStatements(`export default memo(${target});`);
    return { source: file.getFullText(), changed: true };
  }

  for (const decl of file.getVariableDeclarations()) {
    if (decl.getName() !== target) continue;
    const statement = decl.getVariableStatement();
    if (statement === undefined) continue;
    statement.setIsDefaultExport(false);
    file.addStatements(`export default memo(${target});`);
    return { source: file.getFullText(), changed: true };
  }

  return { source, changed: false, reason: '未找到可改写的组件声明' };
}

// ─────────────────────────────────────────────────────────────────────
// 变换表
// ─────────────────────────────────────────────────────────────────────

export interface AstTransformation {
  id: string;
  description: string;
  /** 目标文件扩展名约束；不匹配则拒绝，避免把 HTML 规则套到 tsx 上 */
  extensions: readonly string[];
  /**
   * 声明路径不存在时，按这些**约定名**再找一遍。
   *
   * 只给"位置有明确约定"的产物用（路由表就是典型）。这不是"猜路径"：
   * 规划阶段拿不到文件系统，只能给一个最可能的路径，而真实项目里这个名字
   * 五花八门。约定名全都找不到时如实记为"需要人工"，**绝不改一个碰巧存在的文件**。
   */
  fallbacks?: readonly string[];
  transform: (content: string) => { content: string; changed: boolean; reason?: string };
}

/**
 * 路由表的常见位置。
 *
 * 顺序即优先级；每个名字都会再试一遍同名换扩展名（`.js` / `.tsx` 之类），
 * 因此不必把所有组合都列出来。
 */
const ROUTE_TABLE_FALLBACKS = [
  'src/router/index.ts',
  'src/router.ts',
  'src/routes.ts',
  'src/router/routes.ts',
  'src/app/routes.ts',
] as const;

/** `<img>` 加懒加载的变换 id —— 规划规则通过 `node` 引用它 */
export const AST_TRANSFORMATIONS: readonly AstTransformation[] = [
  {
    id: 'add-loading-lazy',
    description: '给未声明的 <img> 添加 loading="lazy"',
    extensions: ['.html', '.htm', '.tsx', '.jsx', '.vue'],
    transform: (content) => {
      const { html, changed } = addLoadingLazy(content);
      return changed > 0
        ? { content: html, changed: true }
        : { content, changed: false, reason: '没有可加 loading 的 <img>' };
    },
  },
  {
    id: 'add-defer-script',
    description: '给阻塞解析的 <script src> 添加 defer',
    extensions: ['.html', '.htm'],
    transform: (content) => {
      const { html, changed } = addDeferScript(content);
      return changed > 0
        ? { content: html, changed: true }
        : { content, changed: false, reason: '没有可加 defer 的外链脚本' };
    },
  },
  {
    id: 'react-memo',
    description: '用 React.memo 包裹默认导出的函数组件',
    extensions: ['.tsx', '.jsx'],
    transform: (content) => {
      const result = wrapWithMemo(content);
      return result.changed
        ? { content: result.source, changed: true }
        : { content, changed: false, reason: result.reason ?? '无需 memo 化' };
    },
  },
  {
    /**
     * 路由级代码分割。
     *
     * 这条变换曾经**只存在于规划器一侧**（规划器声明 `node: 'route-config'`，
     * 而变换表里没有这个 id），于是那条 B 类候选永远只会产出
     * "未知的 AST 变换，需人工处理" —— 一条看起来合理、实际从不生效的规则。
     */
    id: 'lazy-route-component',
    description: '把路由表里的静态组件引用改成动态 import（路由级代码分割）',
    extensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
    fallbacks: ROUTE_TABLE_FALLBACKS,
    transform: (content) => {
      const result = splitRouteComponents(content);
      return result.changed
        ? { content: result.source, changed: true }
        : { content, changed: false, reason: result.reason ?? '无需改动' };
    },
  },
];

const byId = new Map(AST_TRANSFORMATIONS.map((t) => [t.id, t]));

export function findTransformation(id: string): AstTransformation | null {
  return byId.get(id) ?? null;
}

/** 契约：`PlannedChange.node` 携带变换 id */
export function astChangeId(change: PlannedChange): string | null {
  return change.type === 'ast' ? change.node : null;
}

async function applyAst(
  change: PlannedChange,
  readFile: ExecutionContext['readFile'],
): Promise<FileEdit | { error: string } | null> {
  if (change.type !== 'ast') return null;

  const transformation = findTransformation(change.node);
  if (transformation === null) {
    // 不是已知变换：说明这条改动需要人工，而不是「执行器坏了」
    return { error: `未知的 AST 变换 "${change.node}"，需人工处理` };
  }

  const extension = change.file.slice(change.file.lastIndexOf('.')).toLowerCase();
  if (!transformation.extensions.includes(extension)) {
    return { error: `变换 ${transformation.id} 不支持 ${extension} 文件` };
  }

  const before = await readFile(change.file);
  if (before === null) return { error: `文件不存在：${change.file}` };

  const result = transformation.transform(before);
  if (!result.changed) return { error: `${change.file}：${result.reason ?? '无需改动'}` };

  return { file: change.file, before, after: result.content };
}

/**
 * 解析 AST 改动的目标文件。
 *
 * 先按声明路径找（同名换扩展名兜底），找不到再试这个变换自带的**约定名**。
 * 路由表是最典型的例子：规划器只能声明 `src/router/index.ts`，而真实项目里
 * 它可能叫 `src/routes.ts`、`src/router/routes.ts`……
 */
async function resolveAstTarget(
  change: PlannedChange,
  readFile: ExecutionContext['readFile'],
): Promise<string | null> {
  // 这个解析器只被 ast 执行器使用；先收窄，顺便满足类型（`dependency` 类没有 file）
  if (change.type !== 'ast') return null;

  const declared = await resolveExistingFile(change.file, readFile);
  if (declared !== null) return declared;

  const transformation = findTransformation(change.node);
  for (const candidate of transformation?.fallbacks ?? []) {
    const hit = await resolveExistingFile(candidate, readFile);
    if (hit !== null) return hit;
  }
  return null;
}

export function createAstRewriterExecutor() {
  return createExecutor({
    route: 'ast-rewriter',
    accepts: (change) => change.type === 'ast',
    apply: applyAst,
    resolveFile: resolveAstTarget,
  });
}
