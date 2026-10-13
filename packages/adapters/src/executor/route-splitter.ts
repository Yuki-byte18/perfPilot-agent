import { Project, SyntaxKind, type ImportDeclaration, type Node } from 'ts-morph';

/**
 * 路由级代码分割：把路由表里的**静态组件引用**换成动态 import。
 *
 * ```
 * import Settings from './views/Settings.vue'
 * const routes = [{ path: '/settings', component: Settings }]
 * ```
 * ↓
 * ```
 * const routes = [{ path: '/settings', component: () => import('./views/Settings.vue') }]
 * ```
 *
 * ## 两个容易做错的地方
 *
 * 1. **静态 import 必须一并删掉。** 只把 `component: X` 改成动态 import，
 *    而文件顶部还留着 `import X from './x'`，打包器仍然会把 x 打进首屏 chunk ——
 *    改动看起来生效了（补丁是真的），收益却是零。这是这个变换里最容易漏的一步。
 * 2. **删 import 前必须确认这个名字没被别处用到。** 删错就是编译不过。
 *    这里的判据是**文本级**的：拿不到项目里其它文件（只有这段源码），
 *    而文本级判断在拿不准时偏保守 —— 宁可留着 import（收益少一点），
 *    不可删错（代码直接坏掉）。
 *
 * ## 刻意不做的
 *
 * - 不改 `components: { default: X }`（命名视图）：出现频率低，多一种形状就多一份出错面
 * - 不碰 `element: <X />`（React Router 的 JSX 写法）：那要连带引入 `lazy` + `Suspense`，
 *   改变的是渲染语义而不只是加载时机。它应该留在人工处理
 * - 不拆 node_modules 里的包：把某个第三方库懒加载出去不是"路由分割"，是另一件事
 */

export interface SplitResult {
  source: string;
  changed: boolean;
  /** 被拆成动态 import 的组件名（进补丁说明与日志） */
  splitNames: string[];
  /** 未改动的原因 */
  reason?: string;
}

export function splitRouteComponents(source: string): SplitResult {
  const project = new Project({ useInMemoryFileSystem: true });
  // 用 .tsx 文件名：它在语法上是最宽松的（能容纳类型标注与 JSX），
  // 而这里的改动只涉及属性初始化器，与具体扩展名无关
  const file = project.createSourceFile('routes.tsx', source);

  // ── 1. 收集**项目内**的默认导入 ────────────────────────────────
  const componentImports = new Map<string, ImportDeclaration>();
  for (const declaration of file.getImportDeclarations()) {
    const name = declaration.getDefaultImport()?.getText();
    if (name === undefined) continue;

    const specifier = declaration.getModuleSpecifierValue();
    // 只处理项目内的组件（相对路径或 `@/` 别名）。懒加载一个 node_modules
    // 里的包不在这个变换的语义里
    if (!specifier.startsWith('.') && !specifier.startsWith('@/')) continue;

    componentImports.set(name, declaration);
  }

  if (componentImports.size === 0) {
    return { source, changed: false, splitNames: [], reason: '没有项目内的组件默认导入' };
  }

  // ── 2. 找 `component: 静态标识符` ──────────────────────────────
  const targets: Array<{ node: Node; name: string; specifier: string }> = [];

  for (const assignment of file.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
    if (assignment.getName() !== 'component') continue;

    const initializer = assignment.getInitializer();
    // 已经是 `() => import(...)` 时，初始化器是箭头函数而不是标识符 → 自然跳过
    if (initializer === undefined || initializer.getKind() !== SyntaxKind.Identifier) continue;

    const name = initializer.getText();
    const declaration = componentImports.get(name);
    if (declaration === undefined) continue;

    targets.push({ node: initializer, name, specifier: declaration.getModuleSpecifierValue() });
  }

  if (targets.length === 0) {
    return {
      source,
      changed: false,
      splitNames: [],
      reason: '没有 `component: 静态组件` 形式的路由（可能已经懒加载，或用的是命名视图 / JSX 写法）',
    };
  }

  // ── 3. 替换成动态 import ───────────────────────────────────────
  const splitNames: string[] = [];
  for (const target of targets) {
    target.node.replaceWithText(`() => import('${target.specifier}')`);
    splitNames.push(target.name);
  }

  /**
   * ── 4. 判断哪些 import 可以安全删除 ────────────────────────────
   *
   * 判据必须是**AST 级**的，不能拿文本去搜名字：模块路径里往往就含组件名
   * （`import Home from './views/Home.vue'`），文本搜索会把路径里的 `Home`
   * 当成"还在用"，于是 import 一个都删不掉 —— 改动看起来生效了，
   * 而模块仍然被打进首屏 chunk。
   *
   * 先**全部判定、再统一删除**：边判定边删会让后一个名字的判定结果
   * 依赖遍历顺序。
   */
  const removable: ImportDeclaration[] = [];

  for (const name of new Set(splitNames)) {
    const declaration = componentImports.get(name);
    if (declaration === undefined) continue;

    const stillUsed = file.getDescendantsOfKind(SyntaxKind.Identifier).some((node) => {
      if (node.getText() !== name) return false;
      // import 子句里的那个名字就是我们要删的，不算"被用到"
      return node.getFirstAncestorByKind(SyntaxKind.ImportDeclaration) === undefined;
    });
    if (stillUsed) continue;

    removable.push(declaration);
  }

  for (const declaration of removable) declaration.remove();

  return { source: file.getFullText(), changed: true, splitNames };
}
