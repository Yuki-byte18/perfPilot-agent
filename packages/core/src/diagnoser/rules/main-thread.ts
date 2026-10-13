import {
  attributionMergeKey,
  type BottleneckKind,
  type Evidence,
} from '@yuki-byte18/shared';
import { longTasksOf, str, webVitalsAttributionsOf } from '../artifacts.js';
import {
  metricValue,
  severityBetween,
  type Detection,
  type DiagnosticRule,
  type RuleContext,
} from '../types.js';

/** 长任务阈值，与 trace 适配器保持一致（RAIL 模型） */
const LONG_TASK_MS = 50;
/** 「确实很糟」的参照点：一次 500ms 的卡顿已经能让用户明显感知 */
const LONG_TASK_SEVERE_MS = 500;
/** CLS 的「确实很糟」参照点（good 边界由规格表给出，默认 0.1） */
const CLS_SEVERE = 0.5;

function basename(url: string): string {
  const clean = url.split(/[?#]/)[0] ?? url;
  const slash = clean.lastIndexOf('/');
  return slash >= 0 ? clean.slice(slash + 1) : clean;
}

/**
 * 去掉脚本 URL 的 origin，换成相对项目根的路径。
 *
 * trace 里记录的是 `https://staging.example.com/assets/index.js`，
 * 而 source map 的 `generated.file` 是相对项目根的 `assets/index.js`。
 * 不做这一步转换，`resolve` 永远查不到映射 —— 归因就停在「某个 URL 很慢」。
 */
function toProjectRelative(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname.replace(/^\//, '');
  } catch {
    return url.replace(/^\.?\//, '');
  }
}

/**
 * 把 trace 的帧位置还原到源码。
 *
 * 这是 source map 在 M2 的唯一接入点，也是整条归因链最有价值的一跳：
 * trace 只能说「index.js 第 142 行花了 150ms」，source map 才能说
 * 「src/components/VirtualList.tsx 第 88 行的 renderList」。
 * 拿不到映射时降级为产物位置 —— 仍然可查，只是要多跳一步。
 */
async function resolveFrame(
  ctx: RuleContext,
  frame: {
    url: string | null;
    line: number | null;
    column: number | null;
    functionName: string | null;
  },
): Promise<{ attribution: Detection['attribution']; confidence: number; evidence: Evidence[] } | null> {
  if (frame.url === null) return null;

  const generatedFile = toProjectRelative(frame.url);

  if (ctx.sourceMap !== null && frame.line !== null) {
    const original = await ctx.sourceMap.resolve({
      file: generatedFile,
      line: frame.line,
      column: frame.column ?? 0,
    });

    if (original !== null) {
      return {
        attribution: {
          level: 'source',
          file: original.source,
          line: original.line,
          column: original.column,
          component: original.name ?? frame.functionName,
        },
        // 有 source map 就能直接指到源码行，这是最强的一类归因；
        // 但落到 node_modules 里说明问题在第三方库里，置信度降一档
        confidence: original.fromDependency ? 0.7 : 0.9,
        evidence: [
          {
            kind: 'source-map',
            payload: { generated: { file: generatedFile, line: frame.line }, original },
            description: `产物 ${generatedFile}:${frame.line} 还原到 ${original.source}:${original.line}`,
          },
        ],
      };
    }
  }

  // 降级：只能归因到产物文件
  return {
    attribution: {
      level: 'resource',
      url: generatedFile,
      size: 0,
      contentType: 'application/javascript',
    },
    confidence: 0.6,
    evidence: [
      {
        kind: 'trace-event',
        payload: frame,
        description: `无 source map，仅能定位到产物 ${generatedFile}${frame.line === null ? '' : `:${frame.line}`}`,
      },
    ],
  };
}

/**
 * LONG_MAIN_THREAD_TASK —— 主线程长任务。
 *
 * 按「可归因位置」合并，而不是按任务逐条列：10 个长任务里 8 个都指向
 * 同一个 `renderList`，那它们本来就是同一个问题（这个函数要优化），
 * 合并成一条 `occurrences: 8` 才是有行动价值的结论。
 */
export const longMainThreadTaskRule: DiagnosticRule = {
  id: 'long-main-thread-task',
  kind: 'LONG_MAIN_THREAD_TASK' satisfies BottleneckKind,
  description: `主线程任务超过 ${LONG_TASK_MS}ms`,

  async detect(ctx: RuleContext): Promise<Detection[]> {
    const tasks = longTasksOf(ctx.artifacts);
    if (tasks.length === 0) return [];

    const detections: Detection[] = [];

    for (const task of tasks) {
      const frame = task.topFrame;
      const resolved = frame === null ? null : await resolveFrame(ctx, frame);

      if (resolved === null) {
        // 没有可归因的帧：仍然值得报，但要说明「测到了卡顿，但不知道卡在哪」
        detections.push({
          mergeKey: 'unattributed',
          title: `主线程被占用 ${Math.round(task.durationMs)}ms，无法定位到具体代码`,
          severity: severityBetween(task.durationMs, LONG_TASK_MS, LONG_TASK_SEVERE_MS),
          impact: { TBT: Math.round(Math.max(0, task.durationMs - LONG_TASK_MS)) },
          attribution: {
            level: 'component',
            name: '(未定位)',
            file: null,
            line: null,
            renderCount: null,
          },
          evidence: [
            {
              kind: 'trace-event',
              payload: task,
              description: `长任务起于 ${Math.round(task.startMs)}ms，持续 ${Math.round(task.durationMs)}ms；其中脚本 ${Math.round(task.scriptingMs)}ms、布局 ${Math.round(task.layoutMs)}ms、样式 ${Math.round(task.styleMs)}ms`,
            },
          ],
          confidence: 0.5,
        });
        continue;
      }

      const blocking = Math.max(0, task.durationMs - LONG_TASK_MS);
      const label =
        frame?.functionName ??
        (resolved.attribution.level === 'source'
          ? basename(resolved.attribution.file)
          : resolved.attribution.level === 'resource'
            ? basename(resolved.attribution.url)
            : '未知位置');

      detections.push({
        mergeKey: attributionMergeKey(resolved.attribution),
        title: `${label} 阻塞主线程 ${Math.round(task.durationMs)}ms`,
        severity: severityBetween(task.durationMs, LONG_TASK_MS, LONG_TASK_SEVERE_MS),
        impact: { TBT: Math.round(blocking), INP: Math.round(blocking * 0.5) },
        attribution: resolved.attribution,
        evidence: [
          ...resolved.evidence,
          {
            kind: 'trace-event',
            payload: task,
            description: `长任务起于 ${Math.round(task.startMs)}ms；脚本 ${Math.round(task.scriptingMs)}ms、布局 ${Math.round(task.layoutMs)}ms、样式 ${Math.round(task.styleMs)}ms`,
          },
        ],
        confidence: resolved.confidence,
      });
    }

    return detections;
  },
};

/**
 * CLS_SHIFT_SOURCE —— 布局偏移的源头。
 *
 * 只认 Web Vitals 的 attribution：`onCLS` 会给出 `largestShiftTarget`
 * （造成最大偏移的元素选择器）与 `largestShiftSources`。
 * 这些是 DOM 层面的信息，从 HAR / trace 里拿不到，因此没有该来源时
 * 这条规则不产出任何结果 —— 而不是编一个。
 *
 * 归因落在 **component 级**：`file`/`line` 为 null 是诚实的 ——
 * 选择器能告诉你「哪个元素」，但拿不到它定义在哪个文件里。
 */
export const clsShiftSourceRule: DiagnosticRule = {
  id: 'cls-shift-source',
  kind: 'CLS_SHIFT_SOURCE' satisfies BottleneckKind,
  description: 'CLS 超过 good 阈值且 Web Vitals 报告了偏移元素',

  detect(ctx: RuleContext): Detection[] {
    const cls = metricValue(ctx, 'CLS');
    if (cls === null) return [];

    // 阈值取自评分规格（默认 good=0.1），配置覆盖时同步生效
    const threshold = ctx.thresholds.CLS?.warning ?? 0.1;
    if (cls <= threshold) return [];

    const detections: Detection[] = [];

    for (const attribution of webVitalsAttributionsOf(ctx.artifacts)) {
      if (attribution.metric !== 'CLS') continue;

      const target = str(attribution.data, 'largestShiftTarget');
      const sources = attribution.data['largestShiftSources'];

      // 没有 DOM 归因就什么都别说 —— 编一个选择器比不报更糟
      if (target === null && !Array.isArray(sources)) continue;

      const selector = target ?? (Array.isArray(sources) ? String(sources[0] ?? '') : '');
      if (selector === '') continue;

      const assetUrl = str(attribution.data, 'url');

      detections.push({
        mergeKey: selector,
        title: `${selector} 造成布局偏移`,
        severity: severityBetween(cls, threshold, CLS_SEVERE),
        impact: { CLS: Math.round((cls - threshold) * 1000) / 1000 },
        attribution: {
          level: 'component',
          name: selector,
          // 选择器给不出源码位置；若 attribution 带了资源 URL 则补一个线索
          file: assetUrl,
          line: null,
          renderCount: null,
        },
        evidence: [
          {
            kind: 'web-vitals-attribution',
            payload: attribution.data,
            description: `CLS ${cls}（good 阈值 ${threshold}），最大偏移元素 ${selector}`,
          },
        ],
        confidence: 0.8,
      });
    }

    return detections;
  },
};
