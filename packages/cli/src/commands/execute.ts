import {
  EXIT_CODES,
  exitCodeForError,
  toPerfPilotError,
  type Device,
  type ExitCode,
  type LogLevel,
} from '@yuki-byte18/shared';
import { evaluateCiGate, publishCiReport } from '@yuki-byte18/core';
import { bootstrap, type BootstrapOptions, type CliContext } from '../bootstrap.js';
import {
  exitCodeForSummary,
  runRoutes,
  type OutputFormat,
  type RunRoutesSummary,
} from '../runner.js';

export interface CommonCommandOptions {
  config?: string;
  url?: string;
  routes?: string;
  device?: string;
  baseline?: string;
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  [key: string]: unknown;
}

/**
 * 把 commander 的原始选项收敛成强类型输入。
 *
 * CLI 参数同样是**外部输入**（硬约束 11），只是校验发生在这一层而非 zod：
 * `--device tablet` 这种拼错必须当场报错，而不是默默按 mobile 跑完整轮 CI。
 */
/**
 * 逐路由评估门禁，并把结果发布出去（M7）。
 *
 * 两个刻意的顺序选择：
 *
 * 1. **门禁先算，发布后做。** 发布可能慢（网络）也可能失败（token 过期），
 *    而门禁结论是本地就能确定的。先算出来，才能保证"发评论失败"不会
 *    反过来影响"这次提交过没过"。
 * 2. **门禁结论落盘（`gate.json`）。** 验收 5 要求"同一 commit 跑两次结论一致"——
 *    把结论本身写成文件，重跑一次直接 diff 两个文件就行，
 *    不需要人去比对两份 Markdown 报告的措辞。
 */
async function evaluateAndPublish(input: {
  ctx: CliContext;
  summary: RunRoutesSummary;
  ci: boolean;
  maxRegression?: number;
  output: OutputFormat;
  reportUrl?: string;
}): Promise<{ passed: boolean; failures: string[] }> {
  const { ctx, summary, ci, output } = input;
  const failures: string[] = [];

  for (const result of summary.results) {
    if (!result.ok) {
      // 采集失败本身就是门禁失败：拿不到数据时"通过"是没有意义的
      failures.push(`路由 ${result.route}: ${result.error.code} ${result.error.message}`);
      continue;
    }

    const { run, diagnosis, candidates, decisions, executions, verifications } = result.outcome;

    const gate = evaluateCiGate({
      run,
      config: ctx.config,
      ...(input.maxRegression !== undefined ? { maxRegression: input.maxRegression } : {}),
    });

    if (!gate.passed) failures.push(...gate.failures.map((f) => `路由 ${run.route} ${f}`));

    // 门禁结论落盘：可复现性靠它，而不是靠重看报告
    try {
      await ctx.store.saveJson(run.id, 'gate.json', gate);
    } catch (err) {
      ctx.logger.warn('门禁结论落盘失败', { error: toPerfPilotError(err).message });
    }

    const published = await publishCiReport({
      run,
      diagnosis,
      candidates,
      decisions,
      executions,
      verifications,
      config: ctx.config,
      store: ctx.store,
      logger: ctx.logger,
      scm: ctx.scm,
      git: ctx.git,
      ci: ctx.ci,
      gate,
      reportUrl: input.reportUrl ?? null,
    });

    if (output === 'quiet') continue;

    process.stdout.write(
      `\n## ${gate.passed ? '✅ 门禁通过' : '⛔ 门禁未通过'}\n\n` +
        gate.checks.map((c) => `- ${c.passed ? '✅' : '❌'} \`${c.name}\`: ${c.detail}`).join('\n') +
        '\n',
    );

    for (const note of published.notes) process.stdout.write(`\n> ℹ️ ${note}\n`);
    if (published.prUrl !== null) process.stdout.write(`\n> 🔀 自动 PR：${published.prUrl}\n`);
  }

  /**
   * 说清"这些红灯为什么没影响退出码"。
   *
   * 不解释的话，本地 `run` 会稳定地打出 `⛔ 门禁未通过` 而退出码是 0，
   * 用户只能得出"门禁坏了" —— 实际上这是刻意的：本地跑一次不该被门禁挂掉，
   * CI 里才该。这句提示只在非 CI 且非静默时打一次，不逐路由重复。
   */
  if (!ci && output !== 'quiet' && summary.results.some((r) => r.ok)) {
    process.stdout.write(
      '\n> ℹ️ 非 CI 模式：以上门禁结论**只展示、不影响退出码**。想让门禁决定 CI 的成败，加 `--ci`。\n',
    );
  }

  // 非 CI 模式下门禁结论只展示、不决定退出码
  return { passed: ci ? failures.length === 0 : true, failures };
}

export function parseCommon(options: CommonCommandOptions): {
  configPath?: string;
  url?: string;
  routes?: string[];
  device: Device;
  baselineRef?: string;
  output: OutputFormat;
  logLevel: LogLevel;
} {
  const device = options.device ?? 'mobile';
  if (device !== 'mobile' && device !== 'desktop') {
    throw toPerfPilotError(
      new Error(`--device 只能是 mobile 或 desktop，收到 "${device}"`),
      'CONFIG_INVALID',
    );
  }

  const routes = options.routes
    ?.split(',')
    .map((r) => r.trim())
    .filter((r) => r !== '');

  const output: OutputFormat = options.quiet ? 'quiet' : options.json ? 'json' : 'markdown';

  return {
    ...(options.config !== undefined ? { configPath: options.config } : {}),
    ...(options.url !== undefined ? { url: options.url } : {}),
    ...(routes !== undefined && routes.length > 0 ? { routes } : {}),
    device,
    ...(options.baseline !== undefined ? { baselineRef: options.baseline } : {}),
    output,
    logLevel: options.verbose === true ? 'debug' : 'info',
  };
}

export interface ExecuteOptions extends CommonCommandOptions {
  cwd: string;
  /**
   * 是否允许执行 / 验证 / 回滚（M5）。
   *
   * `run` 传 true，`diagnose` 传 false —— 后者对用户的承诺是
   * 「只诊断，不修改任何代码」，这不是默认值问题，是命令语义问题。
   */
  apply: boolean;
  /** 只生成 patch，不应用任何改动 */
  dryRun?: boolean;
  /**
   * CI 模式：跑完门禁后按结论决定退出码（M7 验收 1）。
   *
   * 非 CI 模式下退出码只反映"跑没跑成"；CI 模式下才反映"过没过"。
   * 分开是必要的：本地跑一次拿到红灯会让人以为工具坏了，
   * 而 CI 里拿到绿灯却挂着回归才是真的坏。
   */
  ci?: boolean;
  /** 覆盖配置里的 max_regression（临时放宽/收紧） */
  maxRegression?: string;
  /** 注入点：测试把 adapter 换成 fixture，整条链路不再需要网络 */
  bootstrap?: Partial<BootstrapOptions>;
}

/**
 * `run` 与 `diagnose` 共用的执行体。
 *
 * 两者共用同一条流水线，差异只在 `apply`：
 * `run` 会继续走执行→验证→保留/回滚，`diagnose` 永远止步于报告。
 * 共用同一个执行体是为了让「诊断」这条路径只有一份实现 ——
 * 两套代码做同一件事，迟早会给出两个不同的诊断结论。
 */
export async function execute(options: ExecuteOptions): Promise<ExitCode> {
  let dispose: (() => void) | null = null;

  try {
    const parsed = parseCommon(options);
    /**
     * `apply` 是**是否进入变更闭环**（execute → verify → 保留/回滚），
     * 与"是否真的写盘"是两件事。
     *
     * `--dry-run` 必须走完闭环才产得出补丁，只是不写盘（由 pipeline 的 `dryRun`
     * 决定 `allowWrite`）。早先把两者混成一句，`run --dry-run` 就被降级成了
     * `diagnose`：补丁一份都没有，而 `--help` 里写着"只生成 patch，不修改工作区"。
     */
    const apply = options.apply;

    const ctx = await bootstrap({
      cwd: options.cwd,
      ...(parsed.configPath !== undefined ? { configPath: parsed.configPath } : {}),
      ...(parsed.url !== undefined ? { url: parsed.url } : {}),
      ...(parsed.routes !== undefined ? { routes: parsed.routes } : {}),
      ...(parsed.baselineRef !== undefined ? { baselineRef: parsed.baselineRef } : {}),
      logLevel: parsed.logLevel,
      apply,
      ...options.bootstrap,
    });
    dispose = ctx.dispose;

    if (parsed.output !== 'quiet') {
      process.stdout.write(
        `\n# PerfPilot · ${ctx.config.project.name}\n\n` +
          `> 配置 \`${ctx.configPath}\` · 目标 ${ctx.config.target.url} · ` +
          `适配器 ${ctx.collectors.map((c) => c.id).join(', ') || '无'} · ` +
          `${apply ? (options.dryRun === true ? '闭环 · dry-run（只产出补丁，不写工作区）' : '闭环（执行 + 验证 + 回滚）') : '只读（不修改代码）'}\n`,
      );
    }

    const summary = await runRoutes({
      ctx,
      ...(parsed.routes !== undefined ? { routes: parsed.routes } : {}),
      device: parsed.device,
      ...(parsed.baselineRef !== undefined ? { baselineRef: parsed.baselineRef } : {}),
      output: parsed.output,
      ...(options.dryRun === true ? { dryRun: true } : {}),
    });

    if (parsed.output !== 'quiet') {
      const kept = summary.results.reduce(
        (sum, r) => sum + (r.ok ? r.outcome.verifications.filter((v) => v.status === 'kept').length : 0),
        0,
      );
      const rolled = summary.results.reduce(
        (sum, r) =>
          sum + (r.ok ? r.outcome.verifications.filter((v) => v.status === 'rolled_back').length : 0),
        0,
      );

      process.stdout.write(
        `\n---\n\n共 ${summary.results.length} 条路由：${summary.succeeded} 条成功、${summary.failed} 条失败。\n`,
      );

      const uncollected = summary.results.filter((r) => r.ok && !r.collected).length;
      if (uncollected > 0) {
        process.stdout.write(
          `> ⚠️ 其中 ${uncollected} 条跑完了流水线、但一条指标都没采到（数据源不可用或页面打不开）：` +
            `报告里的"0 个瓶颈"不代表页面没问题，只代表**这次没测到**。\n`,
        );
      }
      if (kept > 0 || rolled > 0) {
        process.stdout.write(`验证结果：保留 ${kept} 个改动、回滚 ${rolled} 个。\n`);
      }
    }

    // ── 门禁与发布（M7）────────────────────────────────────────────
    /**
     * 门禁只在**它能起作用**的时候评估：要么本次进了变更闭环（`run`），
     * 要么显式要了 CI 语义（`--ci`，此时它决定退出码）。
     *
     * 只读诊断既不改代码、退出码也不由门禁决定，却照样逐路由打印
     * `⛔ 门禁未通过` —— 满屏红灯配退出码 0，用户只能得出"这工具坏了"。
     */
    if (apply || options.ci === true) {
      const gateOutcomes = await evaluateAndPublish({
        ctx,
        summary,
        ci: options.ci === true,
        ...(options.maxRegression !== undefined
          ? { maxRegression: Number.parseFloat(options.maxRegression) }
          : {}),
        output: parsed.output,
        ...(options.bootstrap?.reportUrl !== undefined
          ? { reportUrl: options.bootstrap.reportUrl }
          : {}),
      });

      if (!gateOutcomes.passed) return EXIT_CODES.GATE_FAILED;
    } else if (parsed.output !== 'quiet') {
      process.stdout.write(
        '\n> 本次为只读诊断，未评估 CI 门禁。加 `--ci` 可让门禁结论决定退出码。\n',
      );
    }

    return exitCodeForSummary(summary);
  } catch (err) {
    const error = toPerfPilotError(err);
    // 人读的错误写 stdout（stderr 被 pino 占满了 JSON）
    process.stdout.write(`\n❌ ${error.code}: ${error.message}\n`);
    if (error.details !== null) {
      process.stdout.write(`\n${JSON.stringify(error.details, null, 2)}\n`);
    }
    return exitCodeForError(error);
  } finally {
    // 记忆库的文件句柄要显式放掉，否则测试与 CI 的清理步骤会撞上 EBUSY
    dispose?.();
  }
}
