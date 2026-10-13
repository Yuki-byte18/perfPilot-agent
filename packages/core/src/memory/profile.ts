import {
  BundleScanPayloadSchema,
  tryParseExternal,
  type Metric,
  type MetricName,
  type PackageJsonSnapshot,
  type ProjectProfile,
  type RawArtifact,
} from '@yuki-byte18/shared';

/**
 * 项目画像推断（README §10「项目画像」）。
 *
 * 画像回答一个问题：**这个项目是什么技术栈**。它决定了三条召回路径里
 * 「按技术栈召回」能不能用 —— 在 M6 之前 `techStack` 恒为 `'unknown'`，
 * 那条路径实际上是死的（永远召不回任何东西）。
 *
 * ## 为什么从采集产物里推断，而不是去读 package.json
 *
 * `bundle-analyzer` 采集时已经把 package.json 快照放进了产物
 * （`BundleScanPayload.packageJson`）。再让 core 去读一次文件，等于
 * 让 core 碰文件系统（硬约束 5），还得处理路径、编码、BOM 这一堆事 ——
 * 而那些都已经在 adapter 里解决过了。
 *
 * 顺带的代价是：**没跑 bundle-analyzer 的项目推断不出画像**。
 * 这不是缺陷，是诚实 —— 拿不到 package.json 时返回 null，
 * 而不是编一个 `'unknown'` 的画像存进库里污染召回。
 */

/** 框架识别表：命中即停，顺序即优先级（next 内含 react，必须先判 next） */
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

/** 构建工具识别表，同样顺序即优先级 */
const BUILD_TOOLS: readonly { name: string; deps: readonly string[] }[] = [
  { name: 'next', deps: ['next'] },
  { name: 'nuxt', deps: ['nuxt'] },
  { name: 'vite', deps: ['vite'] },
  { name: 'webpack', deps: ['webpack'] },
  { name: 'rspack', deps: ['@rspack/core'] },
  { name: 'parcel', deps: ['parcel'] },
  { name: 'rollup', deps: ['rollup'] },
  { name: 'esbuild', deps: ['esbuild'] },
];

export interface InferProfileInput {
  project: string;
  /** 采集到的全部原始产物；没有 bundle-scan 时推断不出画像 */
  artifacts: readonly RawArtifact[];
  /** 本次指标，写进画像作为基线参考 */
  metrics: readonly Metric[];
  /** 覆盖推断出的技术栈（配置或测试指定时） */
  techStack?: string;
  now?: () => Date;
}

/**
 * 从采集产物推断项目画像。推断不出来时返回 `null` —— **不编造**。
 */
export function inferProjectProfile(input: InferProfileInput): ProjectProfile | null {
  const snapshot = findPackageJson(input.artifacts);
  if (snapshot === null && input.techStack === undefined) return null;

  const deps = collectDeps(snapshot);
  const framework = matchFirst(FRAMEWORKS, deps);
  const buildTool = matchFirst(BUILD_TOOLS, deps);

  const baselineMetrics: Record<string, number> = {};
  for (const metric of input.metrics) baselineMetrics[metric.name] = metric.value;

  return {
    project: input.project,
    // 显式指定优先；否则用「框架+构建工具」，这正是召回时想匹配的粒度
    techStack: input.techStack ?? joinStack(framework, buildTool),
    buildTool: buildTool ?? '',
    framework: framework ?? '',
    baselineMetrics,
    updatedAt: (input.now ?? (() => new Date()))().toISOString(),
  };
}

/** package.json 快照按 `snapshot.techStack` 用不到，只取依赖；名字进不了画像（画像按项目名索引） */
function findPackageJson(artifacts: readonly RawArtifact[]): PackageJsonSnapshot | null {
  for (const artifact of artifacts) {
    if (artifact.adapter !== 'bundle-analyzer') continue;
    const scan = tryParseExternal(BundleScanPayloadSchema, artifact.payload);
    if (scan !== null && scan.packageJson !== null) return scan.packageJson;
  }
  return null;
}

function collectDeps(snapshot: PackageJsonSnapshot | null): Set<string> {
  const deps = new Set<string>();
  for (const table of [snapshot?.dependencies, snapshot?.devDependencies]) {
    if (table === null || table === undefined) continue;
    for (const name of Object.keys(table)) deps.add(name);
  }
  return deps;
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

function joinStack(framework: string | null, buildTool: string | null): string {
  const parts = [buildTool, framework].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join('+') : 'unknown';
}

/**
 * 基线漂移检测（接在画像之后）。
 *
 * ## 为什么需要它
 *
 * 门禁判的是**这一次改动相对上一次**的差值。如果整个项目在缓慢劣化，
 * 每次只坏一点点，差值永远在阈值内 —— 门禁一路绿灯，而三个月后回头看，
 * LCP 已经翻了一倍。**基线自己会漂**，这件事必须被说出来。
 *
 * 判据是画像里的 `baselineMetrics`（上一次运行写进去的）与本次实测的对比，
 * 而不是与 `run.json` 里的基线比：后者可能被显式指定成很久以前的某个 run，
 * 那样算出来的"漂移"是历史总账，不是近期趋势。
 *
 * ## 阈值为什么是 10%
 *
 * 低于这个量级基本是测量抖动（同一份代码两次跑差 3%-5% 很常见），
 * 报出来只会稀释真正重要的告警。**因此这是 info 级、不进报告告警区顶部、
 * 也不影响门禁** —— 它是一条"你可能想知道"的信息，不是判决。
 */
export const DRIFT_THRESHOLD_PERCENT = 10;

export interface BaselineDrift {
  name: MetricName;
  previous: number;
  current: number;
  changePercent: number;
}

/**
 * 比较上一次画像与本次实测，找出漂移超过阈值的指标。
 *
 * 只对**两边都有**的指标比较：新出现的指标没有"漂移"可言。
 */
export function detectBaselineDrift(
  previous: ProjectProfile | null,
  current: readonly Metric[],
  thresholdPercent = DRIFT_THRESHOLD_PERCENT,
): BaselineDrift[] {
  if (previous === null) return [];

  const drifts: BaselineDrift[] = [];

  for (const metric of current) {
    const before = previous.baselineMetrics[metric.name];
    if (typeof before !== 'number' || before === 0) continue;

    const changePercent = ((metric.value - before) / Math.abs(before)) * 100;
    if (Math.abs(changePercent) < thresholdPercent) continue;

    drifts.push({
      name: metric.name,
      previous: before,
      current: metric.value,
      changePercent: Math.round(changePercent * 10) / 10,
    });
  }

  // 漂移最大的排前面：报告里只显示前几条时，先看到最严重的
  return drifts.sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));
}

/** 漂移的告警文案（进报告与日志，因此措辞要能独立看懂） */
export function describeDrift(drifts: readonly BaselineDrift[]): string {
  const parts = drifts.map(
    (d) => `${d.name} ${d.previous} → ${d.current}（${d.changePercent > 0 ? '+' : ''}${d.changePercent}%）`,
  );
  return `基线漂移：${parts.join('、')}。这是相对上次运行的变化，与本次改动的收益无关 —— 门禁判的是后者`;
}

/**
 * 技术栈标签。
 *
 * 粒度选「框架+构建工具」而不是把依赖全列上：召回要的是
 * "同类项目上这个改法管不管用"，而 React+Vite 与 React+Webpack 的
 * 优化手段差别很大，再把版本号算进来只会让标签几乎无法匹配。
 */
