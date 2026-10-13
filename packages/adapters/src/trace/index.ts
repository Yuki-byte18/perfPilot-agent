import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import {
  TracePayloadSchema,
  parseJsonText,
  type CollectorPort,
  type MetricSample,
  type RawArtifact,
  type RawRunner,
  type TracePayload,
} from '@yuki-byte18/shared';
import { artifactsOf, defineCollector } from '../define-collector.js';
import { samples } from '../internal/samples.js';
import { TraceFileSchema } from './schema.js';
import type { TraceEvent } from './schema.js';
import { analyzeTrace } from './analyze.js';

export const TRACE_KIND = 'trace';

/** 长任务保留上限：报告展示 top N 就够，全量只会让产物膨胀 */
const DEFAULT_MAX_LONG_TASKS = 50;

export interface TraceRunnerOptions {
  file?: string;
  root?: string;
  maxLongTasks?: number;
}

export function resolveTracePath(options: TraceRunnerOptions = {}): string {
  const file = options.file ?? process.env.PERFPILOT_TRACE_FILE ?? '.perfpilot/trace.json';
  if (isAbsolute(file)) return file;
  return resolve(options.root ?? process.cwd(), file);
}

/** 抽出事件数组，兼容两种导出形态 */
export function eventsOf(parsed: unknown): TraceEvent[] {
  const result = TraceFileSchema.safeParse(parsed);
  if (!result.success) return [];
  return Array.isArray(result.data) ? result.data : result.data.traceEvents;
}

export async function probeTrace(options: TraceRunnerOptions = {}): Promise<boolean> {
  try {
    const parsed = parseJsonText(await readFile(resolveTracePath(options), 'utf8'));
    return eventsOf(parsed).length > 0;
  } catch {
    return false;
  }
}

/**
 * 读取 Chrome trace 并归约成有界摘要。
 *
 * **为什么 runner 里就归约**：一份 10 秒的 trace 有几十万个事件、上百 MB。
 * 原样落盘会让 run 目录不可用，也会让后面的诊断规则每次都在几十万条事件里遍历。
 * 归约后只留下「超过 50ms 的任务 + 每任务的罪魁帧 + 阶段耗时」，
 * 这恰好是诊断需要的全部信息。
 */
export function createTraceRunner(options: TraceRunnerOptions = {}): RawRunner {
  const maxLongTasks = options.maxLongTasks ?? DEFAULT_MAX_LONG_TASKS;

  return async (ctx): Promise<RawArtifact[]> => {
    const path = resolveTracePath(options);
    const parsed = parseJsonText(await readFile(path, 'utf8'));
    const events = eventsOf(parsed);

    const analysis = analyzeTrace(events);

    const payload: TracePayload = {
      source: 'trace',
      totalMs: Math.round(analysis.totalMs),
      eventCount: events.length,
      longTasks: analysis.longTasks.slice(0, maxLongTasks),
      totals: analysis.totals,
    };

    return [
      {
        adapter: 'trace',
        kind: TRACE_KIND,
        payload,
        collectedAt: new Date().toISOString(),
        route: ctx.route,
        device: ctx.device,
        file: null,
      },
    ];
  };
}

export function tracePayloads(artifacts: readonly RawArtifact[]): TracePayload[] {
  const out: TracePayload[] = [];
  for (const artifact of artifactsOf(artifacts, 'trace', TRACE_KIND)) {
    const parsed = TracePayloadSchema.safeParse(artifact.payload);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/**
 * trace → 指标样本。
 *
 * 只产出 TBT（总阻塞时间）：长任务超出 50ms 的部分累加，这正是 Lighthouse
 * 对 Total Blocking Time 的定义。之所以不在这里也产出 INP，
 * 是因为 trace 只能看到主线程忙不忙，看不到用户实际交互的响应延迟。
 */
export function parseTrace(artifacts: readonly RawArtifact[]): MetricSample[] {
  const payloads = tracePayloads(artifacts);
  if (payloads.length === 0) return [];

  const longTasks = payloads.flatMap((p) => p.longTasks);
  if (longTasks.length === 0) {
    // 没有长任务时 TBT 确实是 0 —— 这是一个可信的结论，不是缺失数据
    return samples([['TBT', 0]]);
  }

  const blocking = longTasks.reduce((sum, task) => sum + Math.max(0, task.durationMs - 50), 0);
  return samples([['TBT', Math.round(blocking)]]);
}

export interface TraceAdapterOptions extends TraceRunnerOptions {
  runner?: RawRunner;
  probe?: () => Promise<boolean>;
}

export function createTraceCollector(options: TraceAdapterOptions = {}): CollectorPort {
  return defineCollector({
    id: 'trace',
    probe: options.probe ?? (() => probeTrace(options)),
    runner: options.runner ?? createTraceRunner(options),
    parse: parseTrace,
  });
}
