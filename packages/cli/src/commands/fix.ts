import {
  EXIT_CODES,
  exitCodeForError,
  toPerfPilotError,
  type ExitCode,
  type OptimizationClass,
  type RunSummary,
} from '@yuki-byte18/shared';
import { bootstrap, type BootstrapOptions } from '../bootstrap.js';

export interface FixOptions {
  cwd: string;
  config?: string;
  /** 指定 run；不传则取最近一次 */
  run?: string;
  /** 只处理单个候选 */
  candidate?: string;
  /** 只处理某一级（A / B / C） */
  only?: string;
  dryRun?: boolean;
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  allowDirty?: boolean;
  bootstrap?: Partial<BootstrapOptions>;
}

/**
 * `perfpilot fix` —— 对**上一轮已落盘的候选**执行改动。
 *
 * 与 `run` 的分工：`run` 是「从头测一遍，然后该改就改」，
 * `fix` 是「我已经看过报告、也确认过方案了，现在把它落地」。
 * 后者不重新采集，因此不会因为两次采集之间的环境波动而改变判断依据。
 *
 * 下面这段输出不是装饰 —— 自动改代码这件事必须让人一眼看到
 * **改了什么、验证结果如何、有没有回滚**，否则没人敢在 CI 里用它。
 */
export async function fix(options: FixOptions): Promise<ExitCode> {
  let dispose: (() => void) | null = null;

  try {
    const quiet = options.quiet === true;
    const ctx = await bootstrap({
      cwd: options.cwd,
      ...(options.config !== undefined ? { configPath: options.config } : {}),
      apply: true,
      ...(options.allowDirty !== undefined ? { allowDirtyWorktree: options.allowDirty } : {}),
      logLevel: options.verbose === true ? 'debug' : 'info',
      ...options.bootstrap,
    });
    dispose = ctx.dispose;

    const runId = options.run ?? (await latestRunId(ctx));
    if (runId === null) {
      process.stdout.write('\n❌ 没有可用的运行记录，先跑一次 `perfpilot run` 或 `perfpilot diagnose`。\n');
      return EXIT_CODES.CONFIG_ERROR;
    }

    const only = parseClass(options.only);
    const outcome = await ctx.pipeline.fix({
      runId,
      ...(options.candidate !== undefined ? { candidateId: options.candidate } : {}),
      ...(only !== undefined ? { onlyClass: only } : {}),
      ...(options.dryRun === true ? { dryRun: true } : {}),
    });

    if (options.json === true) {
      process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
    } else if (!quiet) {
      process.stdout.write(renderFixReport(runId, outcome, options.dryRun === true));
    }

    /**
     * 退出码。
     *
     * **回滚不算失败**：一次回滚意味着门禁把不合格的改动拦下来了，
     * 这正是工具该做的事。把它变成非零退出码会让 CI 因为"守住了底线"而变红，
     * 于是很快就没人看这个信号了。
     *
     * 真正该失败的只有一种情况：**该应用的改动一个都没能应用**，
     * 而那说明前置条件出了问题（没有 git 仓库、工作区不干净、补丁全部冲突），
     * 用户必须知道这次 fix 实际上什么都没做。
     */
    if (outcome.verifications.length === 0 && outcome.executions.length > 0) {
      return EXIT_CODES.GATE_FAILED;
    }
    return EXIT_CODES.OK;
  } catch (err) {
    const error = toPerfPilotError(err);
    process.stdout.write(`\n❌ ${error.code}: ${error.message}\n`);
    if (error.details !== null) process.stdout.write(`\n${JSON.stringify(error.details, null, 2)}\n`);
    return exitCodeForError(error);
  } finally {
    // 记忆库的文件句柄要显式放掉，否则测试与 CI 的清理步骤会撞上 EBUSY
    dispose?.();
  }
}

async function latestRunId(ctx: Awaited<ReturnType<typeof bootstrap>>): Promise<string | null> {
  const runs: RunSummary[] = await ctx.store.list();
  return runs[0]?.id ?? null;
}

function parseClass(value: string | undefined): OptimizationClass | undefined {
  if (value === undefined) return undefined;
  const upper = value.toUpperCase();
  if (upper !== 'A' && upper !== 'B' && upper !== 'C') {
    throw toPerfPilotError(
      new Error(`--only 只能是 A / B / C，收到 "${value}"`),
      'CONFIG_INVALID',
    );
  }
  return upper;
}

function renderFixReport(
  runId: string,
  outcome: Awaited<ReturnType<Awaited<ReturnType<typeof bootstrap>>['pipeline']['fix']>>,
  dryRun: boolean,
): string {
  const lines: string[] = [];
  const kept = outcome.verifications.filter((v) => v.status === 'kept');
  const rolled = outcome.verifications.filter((v) => v.status === 'rolled_back');

  lines.push('', `# PerfPilot fix — run \`${runId}\``, '');
  if (dryRun) lines.push('> `--dry-run`：只产出补丁，未修改工作区。', '');

  if (outcome.executions.length === 0 && outcome.skippedExecutions.length === 0) {
    lines.push('没有可执行的候选（没有 apply / confirm 裁决，或过滤条件排除了全部）。', '');
    return `${lines.join('\n')}\n`;
  }

  if (outcome.executions.length > 0) {
    lines.push('| 方案 | 路由 | 产物 | 文件 |', '| --- | --- | --- | --- |');
    for (const execution of outcome.executions) {
      const artifact =
        execution.patch !== ''
          ? 'patch'
          : execution.applied
            ? '二进制已写入'
            : '仅评估（未写入）';
      lines.push(
        `| ${execution.candidateId} | \`${execution.route}\` | ${artifact} | ${execution.files.join(', ') || '—'} |`,
      );
    }
    lines.push('');
  }

  if (outcome.skippedExecutions.length > 0) {
    lines.push('### 未执行', '');
    for (const skipped of outcome.skippedExecutions) {
      lines.push(`- \`${skipped.candidateId}\`：${skipped.reason}`);
    }
    lines.push('');
  }

  if (outcome.verifications.length > 0) {
    lines.push(`## 验证结果：保留 ${kept.length} / 回滚 ${rolled.length}`, '');
    for (const verification of outcome.verifications) {
      const icon = verification.status === 'kept' ? '✅' : '↩️';
      lines.push(`### ${icon} \`${verification.candidateId}\` — ${verification.status}`, '');
      if (verification.git !== null) {
        lines.push(
          `- 回滚目标 \`${verification.git.baseRef}\`` +
            (verification.git.resultRef !== null ? ` · 结果 \`${verification.git.resultRef}\`` : '') +
            (verification.git.reverted ? ' · **已回滚**' : ''),
        );
      }
      lines.push(
        `- 检查：${verification.checks.map((c) => `${c.kind}${c.skipped ? '(跳过)' : c.passed ? '✅' : '❌'}`).join(' · ')}`,
      );
      if (verification.gate.failedRules.length > 0) {
        lines.push(`- 未通过原因：${verification.gate.failedRules.join('；')}`);
      }
      lines.push('');
    }
  }

  for (const warning of outcome.warnings) {
    lines.push(`> ⚠️ \`${warning.code}\` ${warning.message}`, '');
  }

  return `${lines.join('\n')}\n`;
}
