import type { AdapterId, AdapterRegistry, CollectorPort, RawRunner } from '@yuki-byte18/shared';
import { createBundleAnalyzerCollector } from './bundle-analyzer/index.js';
import { createLighthouseCollector } from './lighthouse/index.js';
import { createWebVitalsCollector } from './web-vitals/index.js';
import { createHarCollector } from './har/index.js';
import { createTraceCollector } from './trace/index.js';

export interface AdapterRegistryOptions {
  /** 项目根目录，用于解析 dist / vitals / har / trace 等相对路径 */
  root?: string;
  /** 构建产物目录，默认 `dist` */
  distDir?: string;
  /** Web Vitals 上报文件，默认 `.perfpilot/vitals.json` */
  vitalsFile?: string;
  /** HAR 文件，默认 `.perfpilot/network.har` */
  harFile?: string;
  /** Chrome trace 文件，默认 `.perfpilot/trace.json` */
  traceFile?: string;
  /**
   * 按 adapter 覆盖采集实现（测试注入 fixture runner 的入口）。
   * 生产环境不传，走各自的真实 runner。
   */
  runners?: Partial<Record<AdapterId, RawRunner>>;
  /** 按 adapter 覆盖探活实现 */
  probes?: Partial<Record<AdapterId, () => Promise<boolean>>>;
  /** lighthouse 可执行文件覆盖 */
  lighthouseBin?: string;
}

/**
 * 适配器层的组合根 —— **这是唯一允许 `new` 出具体 adapter 的地方**。
 *
 * 交给 cli / server 调用，然后把结果注入 core。因此 core 的构造函数签名里
 * 只有 `CollectorPort[]`，永远不知道 lighthouse 或 sharp 的存在（硬约束 4）。
 * 单测里把 `runners` 换成读取 fixture 的实现，整条链路就不再需要网络与浏览器。
 */
export function createAdapterRegistry(options: AdapterRegistryOptions = {}): AdapterRegistry {
  const root = options.root ?? process.cwd();

  const collectors: CollectorPort[] = [
    createLighthouseCollector({
      ...(options.lighthouseBin !== undefined ? { bin: options.lighthouseBin } : {}),
      ...(options.runners?.lighthouse !== undefined
        ? { runner: options.runners.lighthouse }
        : {}),
      ...(options.probes?.lighthouse !== undefined ? { probe: options.probes.lighthouse } : {}),
    }),
    createWebVitalsCollector({
      root,
      ...(options.vitalsFile !== undefined ? { file: options.vitalsFile } : {}),
      ...(options.runners?.['web-vitals'] !== undefined
        ? { runner: options.runners['web-vitals'] }
        : {}),
      ...(options.probes?.['web-vitals'] !== undefined
        ? { probe: options.probes['web-vitals'] }
        : {}),
    }),
    createBundleAnalyzerCollector({
      root,
      ...(options.distDir !== undefined ? { distDir: options.distDir } : {}),
      ...(options.runners?.['bundle-analyzer'] !== undefined
        ? { runner: options.runners['bundle-analyzer'] }
        : {}),
      ...(options.probes?.['bundle-analyzer'] !== undefined
        ? { probe: options.probes['bundle-analyzer'] }
        : {}),
    }),
    createHarCollector({
      root,
      ...(options.harFile !== undefined ? { file: options.harFile } : {}),
      ...(options.runners?.har !== undefined ? { runner: options.runners.har } : {}),
      ...(options.probes?.har !== undefined ? { probe: options.probes.har } : {}),
    }),
    createTraceCollector({
      root,
      ...(options.traceFile !== undefined ? { file: options.traceFile } : {}),
      ...(options.runners?.trace !== undefined ? { runner: options.runners.trace } : {}),
      ...(options.probes?.trace !== undefined ? { probe: options.probes.trace } : {}),
    }),
  ];

  const byId = new Map<AdapterId, CollectorPort>(collectors.map((c) => [c.id, c]));

  return {
    all: () => [...collectors],
    get: (id) => byId.get(id) ?? null,
  };
}
