import type { VerifiableCheckKind } from '@yuki-byte18/shared';

/**
 * `perfpilot init` 的检测层。
 *
 * 设计原则：**能检测的一律不问用户，检测不到的绝不瞎猜。**
 *
 * 手写一个 `.perfpilot.yml` 最难的地方不是语法，而是十几项"你其实能从项目里
 * 问出来"的信息（包管理器、已有脚本、git 远端）。让用户抄一遍这些，
 * 既容易写错（`typecheck` vs `type-check`），又会因为写错而让整条链路静默失效。
 *
 * 反过来，`target.url` 是**问不出来**的：本机 dev 地址、预发地址、线上地址
 * 都是合法选择，而它们测出来的数字含义完全不同。这一项必须由人回答，
 * 并且要顺带把"别指向 dev server"这个坑说清楚。
 */

/** 一次检测到的项目事实 */
export interface ProjectFacts {
  name: string;
  framework: string | null;
  buildTool: string | null;
  packageManager: 'pnpm' | 'npm' | 'yarn' | 'bun';
  /** 只包含**真实存在**的检查脚本：不存在的项不进配置，也就不会被当成"失败" */
  scripts: Partial<Record<VerifiableCheckKind, string>>;
  repo: string;
  branch: string;
  isGitRepo: boolean;
  /** `.gitignore` 里已经有 `.perfpilot/` */
  gitignoreCovered: boolean;
  /** 建议的测量地址（来自构建工具的默认端口）；判断不出来时为 null */
  suggestedUrl: string | null;
  /** 建议地址的来源说明（写进注释，让人知道这个默认值是怎么来的） */
  suggestedUrlReason: string | null;
  /**
   * 起本地服务的脚本名（优先 `preview`，退回 `dev`）。
   *
   * CI 里测量本机地址时必须有人把服务起起来 —— 生成的流水线要用它。
   * 没有预览脚本时**不编**：那样生成的流水线会在采集阶段以"页面打不开"告终。
   */
  previewScript: string | null;
}

/** 各检查项在 package.json 里常见的脚本名，按优先级排列 */
const SCRIPT_CANDIDATES: Record<VerifiableCheckKind, readonly string[]> = {
  build: ['build'],
  'unit-test': ['test', 'test:unit', 'vitest', 'jest'],
  'type-check': ['typecheck', 'type-check', 'tsc', 'types:check'],
  lint: ['lint', 'eslint', 'lint:check'],
  e2e: ['e2e', 'test:e2e', 'cypress', 'playwright', 'test:integration'],
};

/** 框架 / 构建工具识别表（顺序即优先级：next 内含 react） */
const FRAMEWORKS: readonly { name: string; deps: readonly string[] }[] = [
  { name: 'next', deps: ['next'] },
  { name: 'nuxt', deps: ['nuxt'] },
  { name: 'remix', deps: ['@remix-run/react'] },
  { name: 'sveltekit', deps: ['@sveltejs/kit'] },
  { name: 'vue', deps: ['vue'] },
  { name: 'svelte', deps: ['svelte'] },
  { name: 'solid', deps: ['solid-js'] },
  { name: 'react', deps: ['react'] },
  { name: 'angular', deps: ['@angular/core'] },
];

const BUILD_TOOLS: readonly { name: string; deps: readonly string[] }[] = [
  { name: 'next', deps: ['next'] },
  { name: 'nuxt', deps: ['nuxt'] },
  { name: 'vite', deps: ['vite'] },
  { name: 'webpack', deps: ['webpack'] },
  { name: 'rspack', deps: ['@rspack/core'] },
  { name: 'parcel', deps: ['parcel'] },
];

/** init 需要的最小 package.json 形状（外部输入，逐字段判类型） */
export interface PackageJsonLike {
  name?: unknown;
  scripts?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
}

export function scriptNamesOf(pkg: PackageJsonLike): Record<string, string> {
  const scripts = pkg.scripts;
  if (typeof scripts !== 'object' || scripts === null) return {};

  const out: Record<string, string> = {};
  for (const [name, command] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof command === 'string' && command !== '') out[name] = command;
  }
  return out;
}

function depNamesOf(pkg: PackageJsonLike): Set<string> {
  const names = new Set<string>();
  for (const table of [pkg.dependencies, pkg.devDependencies]) {
    if (typeof table !== 'object' || table === null) continue;
    for (const name of Object.keys(table as Record<string, unknown>)) names.add(name);
  }
  return names;
}

function matchFirst(
  table: readonly { name: string; deps: readonly string[] }[],
  deps: Set<string>,
): string | null {
  for (const entry of table) {
    if (entry.deps.some((dep) => deps.has(dep))) return entry.name;
  }
  return null;
}

/**
 * 从 `package.json` 与 git 信息推断出项目事实。
 *
 * **纯函数**：所有外部信息由调用方读好传进来（文件、git 命令的输出），
 * 因此这一层可以被直接测，不需要造临时仓库。
 */
export function detectFacts(input: {
  packageJson: PackageJsonLike | null;
  dirName: string;
  packageManager: 'pnpm' | 'npm' | 'yarn' | 'bun';
  gitRemote: string | null;
  gitBranch: string | null;
  gitignore: string | null;
}): ProjectFacts {
  const pkg = input.packageJson;
  const scripts = pkg === null ? {} : scriptNamesOf(pkg);
  const deps = pkg === null ? new Set<string>() : depNamesOf(pkg);

  // 只收真实存在的脚本：不存在的检查项不进配置，也就不会被记成"未通过"
  const picked: Partial<Record<VerifiableCheckKind, string>> = {};
  for (const [kind, candidates] of Object.entries(SCRIPT_CANDIDATES)) {
    const hit = candidates.find((name) => scripts[name] !== undefined);
    if (hit !== undefined) picked[kind as VerifiableCheckKind] = hit;
  }

  const rawName = typeof pkg?.name === 'string' && pkg.name !== '' ? pkg.name : input.dirName;
  // npm 包名可能带 scope（`@acme/web`）——取后一段当项目名更像人话
  const name = rawName.includes('/') ? (rawName.split('/').pop() ?? rawName) : rawName;

  const buildTool = matchFirst(BUILD_TOOLS, deps);
  const framework = matchFirst(FRAMEWORKS, deps);
  const suggestion = suggestUrl(buildTool, scripts);

  return {
    name,
    framework,
    buildTool,
    packageManager: input.packageManager,
    scripts: picked,
    repo: input.gitRemote ?? '',
    branch: input.gitBranch ?? 'main',
    isGitRepo: input.gitRemote !== null || input.gitBranch !== null,
    gitignoreCovered: (input.gitignore ?? '').split(/\r?\n/).some((line) => {
      const trimmed = line.trim();
      return trimmed === '.perfpilot/' || trimmed === '.perfpilot';
    }),
    suggestedUrl: suggestion?.url ?? null,
    suggestedUrlReason: suggestion?.reason ?? null,
    previewScript: scripts['preview'] !== undefined ? 'preview' : scripts['dev'] !== undefined ? 'dev' : null,
  };
}

/**
 * 猜一个可以开始测量的地址。
 *
 * **只作为建议**，而且必须带上理由：`vite preview` 的 4173 与 `vite dev` 的 5173
 * 都是"能跑起来"的地址，但前者发的是构建产物、后者发的是未打包源码 ——
 * 同一份代码测出来的 LCP 能差十倍。所以默认建议 **preview**（构建产物），
 * 并在交互提示里把这件事说明白。
 */
function suggestUrl(
  buildTool: string | null,
  scripts: Record<string, string>,
): { url: string; reason: string } | null {
  if (buildTool === 'next') {
    return { url: 'http://127.0.0.1:3000/', reason: 'Next.js 的默认端口' };
  }
  if (buildTool === 'nuxt') {
    return { url: 'http://127.0.0.1:3000/', reason: 'Nuxt 的默认端口' };
  }
  if (buildTool === 'vite') {
    // 有 preview 脚本就优先建议它：它发的是构建产物，数字才有意义
    if (scripts['preview'] !== undefined) {
      return { url: 'http://127.0.0.1:4173/', reason: 'Vite preview 的默认端口（发的是构建产物）' };
    }
    return { url: 'http://127.0.0.1:5173/', reason: 'Vite dev 的默认端口' };
  }
  return null;
}

const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1', '0.0.0.0'];

/** 是不是**本机**地址（与端口无关）。CI 里测量本机地址必须自己起服务 */
export function isLocalUrl(url: string): boolean {
  try {
    return LOCAL_HOSTS.includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** 供调用方判断：这个建议地址是不是 dev server（要在提示里警告） */
export function isLikelyDevServer(url: string): boolean {
  if (!isLocalUrl(url)) return false;
  try {
    // Vite dev 是 5173；其它 dev server 常用 3000 / 8080
    return ['5173', '3000', '8080', '5174'].includes(new URL(url).port);
  } catch {
    return false;
  }
}
