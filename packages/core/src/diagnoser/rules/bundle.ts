import { attributionMergeKey, type BottleneckKind } from '@yuki-byte18/shared';
import { bundleScansOf } from '../artifacts.js';
import { severityBetween, type Detection, type DiagnosticRule, type RuleContext } from '../types.js';

/** 单个 JS chunk 超过这个体积就该拆 */
export const LARGE_CHUNK_BYTES = 250 * 1024;
/** 「确实很糟」的参照点 */
const LARGE_CHUNK_SEVERE_BYTES = 2 * 1024 * 1024;
/** 体积超过这个值的包会被检查「有没有更轻的替代品」 */
const LEGACY_LIBRARY_MIN_BYTES = 50 * 1024;
const LEGACY_SEVERE_BYTES = 500 * 1024;
/** 重复到这么多份就算最糟 */
const DUPLICATE_SEVERE_COPIES = 6;
/** 全部 JS 挤在一两个 chunk 里、总量又大 → 没配代码分割 */
const NO_SPLITTING_TOTAL_BYTES = 500 * 1024;
const NO_SPLITTING_SEVERE_BYTES = 2 * 1024 * 1024;

/**
 * 已知「有更轻替代品」的库。
 *
 * 只列**替换路径明确**的：列一个「这个包很大」的清单很容易，
 * 但如果没有公认的更优替代，报出来只会制造焦虑。
 */
const LEGACY_LIBRARIES: ReadonlyArray<{
  match: RegExp;
  name: string;
  replacement: string;
}> = [
  { match: /(^|\/)moment(\/|$)/, name: 'moment', replacement: 'dayjs（体积约为 1/10，API 基本兼容）' },
  { match: /(^|\/)lodash(\/|$)/, name: 'lodash', replacement: 'lodash-es + 按需导入，或改用原生方法' },
  { match: /(^|\/)core-js(\/|$)/, name: 'core-js', replacement: '按 browserslist 精确配置 polyfill，避免全量引入' },
  { match: /(^|\/)rxjs(\/|$)/, name: 'rxjs', replacement: '按需导入操作符，或用原生 Promise/事件替代' },
  {
    match: /(^|\/)@material-ui\/core(\/|$)/,
    name: '@material-ui/core',
    replacement: '@mui/material（v5+ 支持 tree shaking）',
  },
];

function basename(path: string): string {
  const clean = path.split(/[?#]/)[0] ?? path;
  const slash = clean.lastIndexOf('/');
  return slash >= 0 ? clean.slice(slash + 1) : clean;
}

function packageNameFromModule(moduleName: string): string | null {
  const normalized = moduleName.replace(/\\/g, '/');
  // 取最内层 node_modules 之后的包名
  const matches = [...normalized.matchAll(/(?<=^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//g)];
  const last = matches.at(-1);
  return last?.[1] ?? null;
}

/** 按 package.json 依赖推断构建配置文件的位置，用于配置级归因 */
export function inferBuildConfigFile(ctx: RuleContext): string {
  for (const scan of bundleScansOf(ctx.artifacts)) {
    const deps = {
      ...(scan.packageJson?.dependencies ?? {}),
      ...(scan.packageJson?.devDependencies ?? {}),
    };
    const names = Object.keys(deps);

    if (names.includes('next')) return 'next.config.js';
    if (names.includes('nuxt')) return 'nuxt.config.ts';
    if (names.includes('vite') || names.includes('@vitejs/plugin-react')) return 'vite.config.ts';
    if (names.includes('webpack') || names.includes('webpack-cli')) return 'webpack.config.js';
    if (names.includes('@rspack/core')) return 'rspack.config.js';
    if (names.includes('rollup')) return 'rollup.config.js';
    if (names.includes('parcel')) return '.parcelrc';
    if (names.includes('esbuild')) return 'build.mjs';
  }
  // 认不出来时给一个最可能的位置，并在证据里说明这是推断
  return 'vite.config.ts';
}

/**
 * LARGE_JS_BUNDLE —— 单个 chunk 体积过大。
 *
 * 按 chunk 而不是按总量判断：总量 800KB 拆成 8 个 100KB 的 chunk 是健康的，
 * 总量 300KB 挤在一个 chunk 里则会让所有路由都付这份代价。
 */
export const largeJsBundleRule: DiagnosticRule = {
  id: 'large-js-bundle',
  kind: 'LARGE_JS_BUNDLE' satisfies BottleneckKind,
  description: `单个 JS chunk 超过 ${Math.round(LARGE_CHUNK_BYTES / 1024)}KB`,

  detect(ctx: RuleContext): Detection[] {
    const detections: Detection[] = [];

    for (const scan of bundleScansOf(ctx.artifacts)) {
      for (const file of scan.files) {
        if (!/\.(js|mjs|cjs)$/i.test(file.path)) continue;
        if (file.size <= LARGE_CHUNK_BYTES) continue;

        const attribution = {
          level: 'resource' as const,
          url: file.path,
          size: file.size,
          contentType: 'application/javascript',
        };

        detections.push({
          mergeKey: attributionMergeKey(attribution),
          title: `${basename(file.path)} 达 ${(file.size / 1024).toFixed(0)}KB`,
          severity: severityBetween(file.size, LARGE_CHUNK_BYTES, LARGE_CHUNK_SEVERE_BYTES),
          impact: {
            JS_SIZE: file.size - LARGE_CHUNK_BYTES,
            // 大 chunk 直接拖慢主线程解析与执行；具体多少取决于设备，给一个保守估计
            TBT: Math.round((file.size - LARGE_CHUNK_BYTES) / 20_000),
          },
          attribution,
          evidence: [
            {
              kind: 'bundle-chunk',
              payload: file,
              description: `构建产物 ${file.path} 为 ${file.size} 字节`,
            },
          ],
          confidence: 0.9,
        });
      }
    }

    return detections;
  },
};

/**
 * DUPLICATE_DEPENDENCY —— 同一个包被打进多份。
 *
 * 判据是**安装位置**而非版本号：同一个 lodash@4.17.21 被装进两处
 * `node_modules`，同样会被打进 bundle 让用户下载两次。
 * 只按版本去重会漏掉这类，而那恰恰是 monorepo 里最常见的情况。
 */
export const duplicateDependencyRule: DiagnosticRule = {
  id: 'duplicate-dependency',
  kind: 'DUPLICATE_DEPENDENCY' satisfies BottleneckKind,
  description: '同一个包在构建产物中出现多份安装',

  detect(ctx: RuleContext): Detection[] {
    const detections: Detection[] = [];

    for (const scan of bundleScansOf(ctx.artifacts)) {
      // 没有模块图就没法判断，「没测」不等于「没有」
      if (scan.source !== 'stats') continue;

      const locations = new Map<string, Set<string>>();
      const sizes = new Map<string, number>();

      for (const module of scan.modules) {
        const pkg = packageNameFromModule(module.name);
        if (pkg === null) continue;
        if (!locations.has(pkg)) locations.set(pkg, new Set());
        locations.get(pkg)?.add(module.name);
        // 取最大的一份作为「重复浪费」的下界估计
        sizes.set(pkg, Math.max(sizes.get(pkg) ?? 0, module.size));
      }

      for (const [pkg, moduleNames] of locations) {
        if (moduleNames.size < 2) continue;

        const copies = moduleNames.size;
        const wasted = (sizes.get(pkg) ?? 0) * (copies - 1);
        const attribution = {
          level: 'dependency' as const,
          name: pkg,
          version: null,
          size: wasted,
        };

        detections.push({
          mergeKey: attributionMergeKey(attribution),
          title: `${pkg} 被重复打包 ${copies} 份`,
          severity: severityBetween(copies, 1, DUPLICATE_SEVERE_COPIES),
          impact: wasted > 0 ? { JS_SIZE: wasted } : {},
          attribution,
          evidence: [
            {
              kind: 'bundle-chunk',
              payload: { package: pkg, copies, modules: [...moduleNames] },
              description: `${copies} 份安装：${[...moduleNames].slice(0, 3).join(' / ')}`,
            },
          ],
          confidence: 0.9,
        });
      }
    }

    return detections;
  },
};

/**
 * LEGACY_LIBRARY —— 引入了有更轻替代品的库。
 *
 * 只在体积可观时报：一个被 tree shaking 掉的 moment 不值得提醒，
 * 一个 288KB 的 moment 才是。
 */
export const legacyLibraryRule: DiagnosticRule = {
  id: 'legacy-library',
  kind: 'LEGACY_LIBRARY' satisfies BottleneckKind,
  description: `体积超过 ${Math.round(LEGACY_LIBRARY_MIN_BYTES / 1024)}KB 且存在更轻替代品的库`,

  detect(ctx: RuleContext): Detection[] {
    const detections: Detection[] = [];

    for (const scan of bundleScansOf(ctx.artifacts)) {
      // 同一个库的多个模块合并统计
      const totals = new Map<string, { size: number; replacement: string; modules: string[] }>();

      for (const module of scan.modules) {
        for (const legacy of LEGACY_LIBRARIES) {
          if (!legacy.match.test(module.name)) continue;
          const existing = totals.get(legacy.name) ?? {
            size: 0,
            replacement: legacy.replacement,
            modules: [],
          };
          existing.size += module.size;
          if (existing.modules.length < 3) existing.modules.push(module.name);
          totals.set(legacy.name, existing);
          break;
        }
      }

      for (const [name, info] of totals) {
        // 与其它规则统一用「严格超过」：阈值本身不算超标，
        // 否则「刚好卡在阈值上」的资源会在不同规则间给出不一致的结论
        if (info.size <= LEGACY_LIBRARY_MIN_BYTES) continue;

        const attribution = {
          level: 'dependency' as const,
          name,
          version: null,
          size: info.size,
        };

        detections.push({
          mergeKey: attributionMergeKey(attribution),
          title: `${name} 占 ${(info.size / 1024).toFixed(0)}KB，有更轻的替代方案`,
          severity: severityBetween(info.size, LEGACY_LIBRARY_MIN_BYTES, LEGACY_SEVERE_BYTES),
          impact: { JS_SIZE: info.size },
          attribution,
          evidence: [
            {
              kind: 'bundle-chunk',
              payload: { package: name, size: info.size, modules: info.modules },
              description: `建议：${info.replacement}`,
            },
          ],
          confidence: 0.85,
        });
      }
    }

    return detections;
  },
};

/**
 * NO_CODE_SPLITTING —— 构建配置里没有启用代码分割。
 *
 * 判据是「JS 文件数很少且总量很大」：只要配了 `manualChunks` 或路由懒加载，
 * 产物必然是多个 chunk。反过来，一个 600KB 的 `index.js` 独占全部 JS，
 * 基本可以断定没配 —— 这比去读构建配置本身更可靠（配置可能来自预设、CLI 参数或环境变量）。
 *
 * 归因落在**构建配置**上，因为要改的就是配置，而不是某个具体文件。
 */
export const noCodeSplittingRule: DiagnosticRule = {
  id: 'no-code-splitting',
  kind: 'NO_CODE_SPLITTING' satisfies BottleneckKind,
  description: '全部 JS 集中在一两个 chunk 且总量偏大，说明未启用代码分割',

  detect(ctx: RuleContext): Detection[] {
    const detections: Detection[] = [];

    for (const scan of bundleScansOf(ctx.artifacts)) {
      const jsFiles = scan.files.filter((f) => /\.(js|mjs|cjs)$/i.test(f.path));
      if (jsFiles.length === 0 || jsFiles.length > 2) continue;

      const total = jsFiles.reduce((sum, f) => sum + f.size, 0);
      if (total <= NO_SPLITTING_TOTAL_BYTES) continue;

      const configFile = inferBuildConfigFile(ctx);
      const attribution = {
        level: 'config' as const,
        file: configFile,
        key: 'build.rollupOptions.output.manualChunks',
      };

      detections.push({
        mergeKey: attributionMergeKey(attribution),
        title: `${jsFiles.length} 个 chunk 承载全部 ${(total / 1024).toFixed(0)}KB JS`,
        severity: severityBetween(total, NO_SPLITTING_TOTAL_BYTES, NO_SPLITTING_SEVERE_BYTES),
        impact: { JS_SIZE: Math.round(total * 0.4) },
        attribution,
        evidence: [
          {
            kind: 'project-config',
            payload: { jsFiles: jsFiles.map((f) => f.path), total, configFile },
            description: `构建配置推断为 ${configFile}（依据 package.json 依赖），建议开启路由级代码分割与 vendor 分包`,
          },
        ],
        confidence: 0.7,
      });
    }

    return detections;
  },
};
