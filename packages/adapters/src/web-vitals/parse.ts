import {
  METRIC_NAMES,
  parseExternal,
  type MetricName,
  type MetricSample,
  type RawArtifact,
} from '@yuki-byte18/shared';
import { artifactsOf } from '../define-collector.js';
import { samples } from '../internal/samples.js';
import { WebVitalsReportSchema } from './schema.js';
import type { WebVitalsReport } from './schema.js';

export const WEB_VITALS_KIND = 'web-vitals';

/**
 * Web Vitals 只认得出这几个指标。
 *
 * 不直接用 `METRIC_NAMES` 全量放行：上报端点里出现 `JS_SIZE` 这类
 * 只能由构建产物分析得出的指标，说明上游写错了数据源，
 * 与其采信一个来路不明的体积数字，不如忽略它。
 */
const SUPPORTED: readonly MetricName[] = ['LCP', 'CLS', 'INP', 'FCP', 'TTFB', 'TBT'];

const SUPPORTED_SET = new Set<string>(SUPPORTED);
const KNOWN_METRICS = new Set<string>(METRIC_NAMES);

function readVital(report: WebVitalsReport, name: string): number | null {
  const raw = report.metrics[name];
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  const value = raw.value;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function samplesFromReport(report: WebVitalsReport): MetricSample[] {
  const entries: Array<readonly [MetricName, number | null]> = [];

  for (const name of SUPPORTED) {
    if (!(name in report.metrics)) continue;
    entries.push([name, readVital(report, name)]);
  }

  return samples(entries);
}

/** 上报里出现了我们认识、但 web-vitals 不该产出的指标名 → 数据源可能配错了 */
export function unexpectedMetricNames(report: WebVitalsReport): string[] {
  return Object.keys(report.metrics).filter(
    (name) => KNOWN_METRICS.has(name) && !SUPPORTED_SET.has(name),
  );
}

/**
 * Web Vitals 上报 → 未打分样本。
 *
 * 抛 `ValidationError` 而不是静默返回空数组：负载结构不对是必须被看见的故障，
 * 由 core 的 collector 统一降级成 warning（M1 验收标准第 4 条）。
 */
export function parseWebVitals(artifacts: readonly RawArtifact[]): MetricSample[] {
  const out: MetricSample[] = [];

  for (const artifact of artifactsOf(artifacts, 'web-vitals', WEB_VITALS_KIND)) {
    const report: WebVitalsReport = parseExternal(WebVitalsReportSchema, artifact.payload, {
      what: 'web-vitals 上报数据',
      code: 'ADAPTER_OUTPUT_INVALID',
      stage: 'collect',
    });
    out.push(...samplesFromReport(report));
  }

  return out;
}
