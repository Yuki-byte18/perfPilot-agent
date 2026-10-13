import type {
  BundleScanPayload,
  HarEntry,
  HarPayload,
  RawArtifact,
  TraceLongTask,
  TracePayload,
} from '@yuki-byte18/shared';

/**
 * 产物 fixture。
 *
 * 在 core 里手写而不是从 `@yuki-byte18/adapters` 引：硬约束 4 禁止 core import 具体
 * adapter（由 eslint 边界规则强制）。诊断规则读的是**数据契约**，
 * 契约定义在 shared，因此按契约造数据既不违规，也顺带验证了「规则只依赖契约」。
 */

function artifact(adapter: RawArtifact['adapter'], kind: string, payload: unknown): RawArtifact {
  return {
    adapter,
    kind,
    payload,
    collectedAt: '2026-01-17T14:25:30.000Z',
    route: '/',
    device: 'mobile',
    file: null,
  };
}

export function harEntry(overrides: Partial<HarEntry> = {}): HarEntry {
  return {
    url: 'https://staging.example.com/assets/app.js',
    resourceType: 'script',
    mimeType: 'application/javascript',
    status: 200,
    transferSize: 140_000,
    resourceSize: 486_000,
    timeMs: 180,
    startMs: 120,
    contentEncoding: 'br',
    cacheControl: 'max-age=31536000, immutable',
    initiatorType: 'parser',
    fromCache: false,
    sameOriginAsDocument: true,
    priority: 'High',
    ...overrides,
  };
}

export function harArtifact(
  entries: HarEntry[],
  pageUrl: string | null = 'https://staging.example.com/',
): RawArtifact {
  const payload: HarPayload = { source: 'har', pageUrl, entryCount: entries.length, entries };
  return artifact('har', 'har', payload);
}

export function traceLongTask(overrides: Partial<TraceLongTask> = {}): TraceLongTask {
  return {
    startMs: 1_000,
    durationMs: 180,
    topFrame: {
      functionName: 'renderList',
      url: 'https://staging.example.com/assets/index.js',
      line: 142,
      column: 10,
    },
    scriptingMs: 150,
    layoutMs: 20,
    styleMs: 10,
    ...overrides,
  };
}

export function traceArtifact(longTasks: TraceLongTask[]): RawArtifact {
  const payload: TracePayload = {
    source: 'trace',
    totalMs: 5_000,
    eventCount: longTasks.length * 3,
    longTasks,
    totals: { scriptingMs: 1_200, layoutMs: 300, styleMs: 200 },
  };
  return artifact('trace', 'trace', payload);
}

export function bundleArtifact(overrides: Partial<BundleScanPayload> = {}): RawArtifact {
  const payload: BundleScanPayload = {
    distDir: '/repo/dist',
    source: 'stats',
    files: [{ path: 'assets/index.js', size: 120_000 }],
    modules: [],
    packageJson: null,
    ...overrides,
  };
  return artifact('bundle-analyzer', 'bundle-scan', payload);
}

/** 一个 JS chunk 文件 */
export function jsChunk(path: string, size: number): { path: string; size: number } {
  return { path, size };
}

/** 一个模块条目 */
export function moduleEntry(name: string, size: number): { name: string; size: number } {
  return { name, size };
}

export function webVitalsArtifact(
  metrics: Record<string, { value: number; attribution?: Record<string, unknown> }>,
): RawArtifact {
  return artifact('web-vitals', 'web-vitals', {
    url: 'https://staging.example.com/',
    route: '/',
    collectedAt: '2026-01-17T14:25:31.000Z',
    device: 'mobile',
    metrics,
  });
}
