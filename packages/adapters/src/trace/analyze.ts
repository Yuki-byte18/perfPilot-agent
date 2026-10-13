import type { TraceFrame, TraceLongTask } from '@yuki-byte18/shared';
import type { TraceEvent } from './schema.js';

/** 长任务阈值：主线程被占用超过 50ms，用户就能感知到卡顿（RAIL 模型） */
export const LONG_TASK_THRESHOLD_MS = 50;

/** 事件耗时超过这个值才值得作为「罪魁帧」记录，避免噪音 */
const SIGNIFICANT_FRAME_MS = 5;

const MICROS_PER_MS = 1_000;

/** 把「卡住主线程」的任务挑出来。RunTask 是 Chrome 对主线程任务的封装 */
const TASK_NAMES = new Set(['RunTask', 'ThreadControllerImpl::RunTask', 'TaskQueueManager::ProcessTask']);

/** 可归因到具体代码位置的事件类型 */
const ATTRIBUTABLE_NAMES = new Set([
  'FunctionCall',
  'EvaluateScript',
  'v8.compile',
  'CompileScript',
  'TimerFire',
  'EventDispatch',
  'XHRLoad',
  'XHRReadyStateChange',
  'ParseHTML',
  'GCEvent',
]);

/** 主线程各阶段的耗时归类 */
const PHASE_OF_NAME = new Map<string, 'scripting' | 'layout' | 'style'>([
  ['FunctionCall', 'scripting'],
  ['EvaluateScript', 'scripting'],
  ['v8.compile', 'scripting'],
  ['CompileScript', 'scripting'],
  ['TimerFire', 'scripting'],
  ['EventDispatch', 'scripting'],
  ['XHRLoad', 'scripting'],
  ['XHRReadyStateChange', 'scripting'],
  ['GCEvent', 'scripting'],
  ['Layout', 'layout'],
  ['UpdateLayoutTree', 'layout'],
  ['RecalculateStyle', 'style'],
]);

function dataOf(event: TraceEvent): Record<string, unknown> {
  const data = event.args?.['data'];
  return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
}

function numberOf(source: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function stringOf(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * 从事件里抽出可归因的代码位置。
 *
 * 这里有个容易踩的坑：Chrome trace 的 `lineNumber` 是 **0-based**，
 * 而我们的 `TraceFrame.line` 与 source map 查询都按 1-based。
 * 转换放在这一层，避免规则层各转一次、转漏一次。
 */
export function frameOf(event: TraceEvent): TraceFrame | null {
  const data = dataOf(event);

  // FunctionCall 用 functionName + url；EvaluateScript 用 url；有的只有 scriptName
  const functionName = stringOf(data, 'functionName');
  const url = stringOf(data, 'url') ?? stringOf(data, 'scriptName') ?? stringOf(data, 'fileName');
  const rawLine = numberOf(data, 'lineNumber');
  const column = numberOf(data, 'columnNumber');

  if (functionName === null && url === null) return null;

  return {
    functionName,
    url,
    // 0-based → 1-based；缺失时为 null，由上层决定是否用 source map
    line: rawLine === null ? null : Math.max(1, Math.round(rawLine) + 1),
    column: column === null ? null : Math.max(0, Math.round(column)),
  };
}

/** 事件是否落在目标线程上（tracer 会混入 compositor / GPU 线程的事件） */
function isMainThread(event: TraceEvent, mainTid: number | null): boolean {
  if (mainTid === null) return true;
  return event.tid === undefined || event.tid === mainTid;
}

/**
 * 挑出主线程线程号。
 *
 * 取「RunTask 事件数最多的那个 tid」而不是 tid 最小的那个：
 * trace 里同时存在渲染主线程、compositor、worker、GPU 进程，
 * 用最小 tid 猜会在某些导出格式下选错，而主线程一定是 RunTask 最多的。
 */
export function detectMainThread(events: readonly TraceEvent[]): number | null {
  const counts = new Map<number, number>();
  for (const event of events) {
    if (event.tid === undefined || !TASK_NAMES.has(event.name ?? '')) continue;
    counts.set(event.tid, (counts.get(event.tid) ?? 0) + 1);
  }

  let best: number | null = null;
  let bestCount = 0;
  for (const [tid, count] of counts) {
    if (count > bestCount) {
      best = tid;
      bestCount = count;
    }
  }
  return best;
}

export interface TraceAnalysis {
  totalMs: number;
  longTasks: TraceLongTask[];
  totals: { scriptingMs: number; layoutMs: number; styleMs: number };
}

/**
 * 事件流 → 长任务与阶段耗时。
 *
 * 归因策略：一个长任务里往往嵌套几十个事件，直接把整个任务归因到「某个脚本」
 * 会得到一条无用的结论。这里的做法是**只保留任务内耗时最高的那一帧**——
 * 「这次卡顿主要是 `renderList` 在 app.js:142 上花了 180ms」才是可行动的结论。
 */
export function analyzeTrace(events: readonly TraceEvent[]): TraceAnalysis {
  const mainTid = detectMainThread(events);

  const tasks: Array<{ start: number; dur: number; frames: TraceEvent[] }> = [];
  const totals = { scriptingMs: 0, layoutMs: 0, styleMs: 0 };
  let maxTs = 0;

  for (const event of events) {
    if (event.ph !== undefined && event.ph !== 'X') continue;
    if (!isMainThread(event, mainTid)) continue;
    if (typeof event.ts !== 'number' || !Number.isFinite(event.ts)) continue;

    const dur = typeof event.dur === 'number' && Number.isFinite(event.dur) ? event.dur : 0;
    maxTs = Math.max(maxTs, event.ts + dur);

    const phase = PHASE_OF_NAME.get(event.name ?? '');
    if (phase !== undefined) {
      totals[`${phase}Ms`] = totals[`${phase}Ms` as 'scriptingMs' | 'layoutMs' | 'styleMs'] + dur / MICROS_PER_MS;
    }

    if (TASK_NAMES.has(event.name ?? '')) {
      const start = event.ts;
      tasks.push({ start, dur, frames: [] });
    }
  }

  // 把可归因事件分配给它所属的任务（ts 落在 [start, start+dur) 内）
  const attributable = events.filter((e) => ATTRIBUTABLE_NAMES.has(e.name ?? ''));
  for (const frameEvent of attributable) {
    if (typeof frameEvent.ts !== 'number') continue;
    const ts = frameEvent.ts;
    // 任务按开始时间升序；找最后一个 start <= ts 的任务
    let owner: (typeof tasks)[number] | null = null;
    for (const task of tasks) {
      if (task.start <= ts) owner = task;
      else break;
    }
    if (owner !== null && ts < owner.start + owner.dur) owner.frames.push(frameEvent);
  }

  const longTasks: TraceLongTask[] = [];
  for (const task of tasks) {
    const durationMs = task.dur / MICROS_PER_MS;
    if (durationMs < LONG_TASK_THRESHOLD_MS) continue;

    let top: TraceEvent | null = null;
    let topDur = SIGNIFICANT_FRAME_MS * MICROS_PER_MS;
    const phases = { scriptingMs: 0, layoutMs: 0, styleMs: 0 };

    for (const frame of task.frames) {
      const frameDur = typeof frame.dur === 'number' && Number.isFinite(frame.dur) ? frame.dur : 0;
      const phase = PHASE_OF_NAME.get(frame.name ?? '');
      if (phase !== undefined) phases[`${phase}Ms`] += frameDur / MICROS_PER_MS;
      if (frameDur > topDur) {
        top = frame;
        topDur = frameDur;
      }
    }

    longTasks.push({
      startMs: task.start / MICROS_PER_MS,
      durationMs,
      topFrame: top === null ? null : frameOf(top),
      scriptingMs: phases.scriptingMs,
      layoutMs: phases.layoutMs,
      styleMs: phases.styleMs,
    });
  }

  longTasks.sort((a, b) => b.durationMs - a.durationMs);

  return {
    totalMs: maxTs / MICROS_PER_MS,
    longTasks,
    totals: {
      scriptingMs: round(totals.scriptingMs),
      layoutMs: round(totals.layoutMs),
      styleMs: round(totals.styleMs),
    },
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
