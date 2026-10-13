import {
  EXIT_CODES,
  exitCodeForError,
  toPerfPilotError,
  type Device,
  type ExitCode,
  type PerfPilotError,
} from '@yuki-byte18/shared';
import { renderMarkdown, type RunOutcome } from '@yuki-byte18/core';
import type { CliContext } from './bootstrap.js';

export type OutputFormat = 'markdown' | 'json' | 'quiet';

export interface RunRoutesOptions {
  ctx: CliContext;
  routes?: readonly string[];
  device?: Device;
  baselineRef?: string;
  output?: OutputFormat;
  /** 只产出补丁、不应用任何改动（`run --dry-run`） */
  dryRun?: boolean;
}

export interface RouteSuccess {
  route: string;
  ok: true;
  outcome: RunOutcome;
  /**
   * 这条路由是否真的采到了指标。
   *
   * `ok` 只说明"流水线没抛异常"。采集全线失败时流水线**照样正常返回**：
   * 它把失败写进 `run.status = 'failed'` 与 warnings，报告里白纸黑字写着 failed。
   * 只看 `ok` 就会输出"共 3 条路由：3 条成功"，而同一屏里三条报告全是 failed ——
   * 这种自相矛盾的汇总比没有汇总更糟，用户会以为数据是好的。
   */
  collected: boolean;
}

export interface RouteFailure {
  route: string;
  ok: false;
  error: PerfPilotError;
}

export type RouteResult = RouteSuccess | RouteFailure;

export interface RunRoutesSummary {
  results: RouteResult[];
  succeeded: number;
  failed: number;
}

/**
 * 逐路由执行流水线。
 *
 * **路由之间串行，adapter 之间并行** —— 这不是偷懒，是测量正确性问题。
 * 同时跑三个页面的 Lighthouse 会争抢 CPU 与 Chrome 实例，
 * 测出来的 LCP 反映的是机器负载而不是页面性能；
 * 而同一路由内的多个 adapter（Lighthouse / 体积扫描 / 现场指标）
 * 互相独立，用 `Promise.allSettled` 并发没有副作用。
 *
 * 单个路由失败不中断后续路由：一个页面 404 不该让整份报告消失。
 */
export async function runRoutes(options: RunRoutesOptions): Promise<RunRoutesSummary> {
  const { ctx } = options;
  const routes = options.routes ?? ctx.config.target.routes;
  const device = options.device ?? 'mobile';
  const output = options.output ?? 'markdown';
  const results: RouteResult[] = [];

  for (const route of routes) {
    try {
      const outcome = await ctx.pipeline.run({
        route,
        device,
        ...(options.baselineRef !== undefined ? { baselineRef: options.baselineRef } : {}),
        ...(options.dryRun === true ? { dryRun: true } : {}),
      });
      results.push({ route, ok: true, outcome, collected: outcome.run.status !== 'failed' });
      emit(outcome, output, results.length, routes.length);
    } catch (err) {
      const error = toPerfPilotError(err, 'COLLECT_FAILED');
      results.push({ route, ok: false, error });
      ctx.logger.error('路由执行失败', { route, code: error.code, error: error.message });
      if (output !== 'quiet') {
        process.stdout.write(`\n### 路由 \`${route}\` 执行失败\n\n> ${error.code}: ${error.message}\n`);
      }
    }
  }

  const succeeded = results.filter((r) => r.ok && r.collected).length;
  return { results, succeeded, failed: results.length - succeeded };
}

function emit(
  outcome: RunOutcome,
  output: OutputFormat,
  index: number,
  total: number,
): void {
  if (output === 'quiet') return;

  const { run, saved } = outcome;

  if (output === 'json') {
    process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
    return;
  }

  if (total > 1) {
    process.stdout.write(`\n<!-- 路由 ${index}/${total} -->\n`);
  }
  process.stdout.write(`${renderMarkdown(run)}\n`);
  process.stdout.write(`\n> 报告已写入 \`${saved.dir}\`\n`);
}

/**
 * 汇总退出码。
 *
 * 只要有一条路由产出了数据就返回 0：部分成功意味着「有可用结果」，
 * 拿非零退出码去挂 CI 会让人误以为这次运行毫无价值。
 * 哪条路由失败了写在报告与日志里。
 */
export function exitCodeForSummary(summary: RunRoutesSummary): ExitCode {
  if (summary.results.length === 0) return EXIT_CODES.OK;
  if (summary.succeeded > 0) return EXIT_CODES.OK;

  const first = summary.results.find((r): r is RouteFailure => !r.ok);
  if (first !== undefined) return exitCodeForError(first.error);

  // 流水线跑完了，却一条指标都没采到：报告能出，结论无从谈起。
  // 这是**采集失败**（退出码 3），不是成功 —— 否则 CI 上"数据源全挂"会拿到绿灯。
  return EXIT_CODES.COLLECT_FAILED;
}
