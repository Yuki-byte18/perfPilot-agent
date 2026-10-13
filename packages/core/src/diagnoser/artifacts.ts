import {
  BundleScanPayloadSchema,
  HarPayloadSchema,
  TracePayloadSchema,
  tryParseExternal,
  type BundleScanPayload,
  type HarEntry,
  type HarPayload,
  type RawArtifact,
  type TraceLongTask,
  type TracePayload,
} from '@yuki-byte18/shared';

/**
 * 产物读取器。
 *
 * 每条规则都自己 `artifacts.find(...)` + `safeParse` 会写很多重复代码，
 * 更重要的是会漏掉「读之前先校验」这一步：`.perfpilot/runs/` 里的产物
 * 可能被手工改过、可能来自旧版本 schema。统一在这里校验，
 * 规则拿到的就是可信数据，解析失败只是「这个来源没有数据」而不是崩溃。
 */

function payloadsOf<T>(
  artifacts: readonly RawArtifact[],
  adapter: string,
  kind: string,
  schema: Parameters<typeof tryParseExternal<T>>[0],
): T[] {
  const out: T[] = [];
  for (const artifact of artifacts) {
    if (artifact.adapter !== adapter || artifact.kind !== kind) continue;
    const parsed = tryParseExternal(schema, artifact.payload);
    if (parsed !== null) out.push(parsed);
  }
  return out;
}

export function harPayloadsOf(artifacts: readonly RawArtifact[]): HarPayload[] {
  return payloadsOf<HarPayload>(artifacts, 'har', 'har', HarPayloadSchema);
}

/** 全部 HAR entry 拉平；规则大多数时候只关心这个 */
export function harEntriesOf(artifacts: readonly RawArtifact[]): HarEntry[] {
  return harPayloadsOf(artifacts).flatMap((p) => p.entries);
}

/** HAR 记录的主文档 URL，用于「聚合类」问题的归因落点 */
export function harPageUrlOf(artifacts: readonly RawArtifact[]): string | null {
  for (const payload of harPayloadsOf(artifacts)) {
    if (payload.pageUrl !== null) return payload.pageUrl;
  }
  return null;
}

export function tracePayloadsOf(artifacts: readonly RawArtifact[]): TracePayload[] {
  return payloadsOf<TracePayload>(artifacts, 'trace', 'trace', TracePayloadSchema);
}

export function longTasksOf(artifacts: readonly RawArtifact[]): TraceLongTask[] {
  return tracePayloadsOf(artifacts).flatMap((p) => p.longTasks);
}

export function bundleScansOf(artifacts: readonly RawArtifact[]): BundleScanPayload[] {
  return payloadsOf<BundleScanPayload>(
    artifacts,
    'bundle-analyzer',
    'bundle-scan',
    BundleScanPayloadSchema,
  );
}

/** Web Vitals 的上报负载形状（只有 attribution 部分是诊断需要的） */
export interface WebVitalsAttribution {
  metric: string;
  value: number;
  /** `attribution` 原始对象：字段随 metric 而异，不强行收窄 */
  data: Record<string, unknown>;
}

export function webVitalsAttributionsOf(
  artifacts: readonly RawArtifact[],
): WebVitalsAttribution[] {
  const out: WebVitalsAttribution[] = [];

  for (const artifact of artifacts) {
    if (artifact.adapter !== 'web-vitals' || artifact.kind !== 'web-vitals') continue;
    const payload = artifact.payload;
    if (typeof payload !== 'object' || payload === null) continue;

    const metrics = (payload as { metrics?: unknown }).metrics;
    if (typeof metrics !== 'object' || metrics === null) continue;

    for (const [metric, raw] of Object.entries(metrics as Record<string, unknown>)) {
      if (typeof raw !== 'object' || raw === null) continue;
      const value = (raw as { value?: unknown }).value;
      const attribution = (raw as { attribution?: unknown }).attribution;
      if (typeof value !== 'number') continue;

      out.push({
        metric,
        value,
        data:
          typeof attribution === 'object' && attribution !== null
            ? (attribution as Record<string, unknown>)
            : {},
      });
    }
  }

  return out;
}

/** 从任意字段里安全取字符串 */
export function str(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** 从任意字段里安全取有限数值 */
export function num(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
