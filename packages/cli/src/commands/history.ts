import { isSafeId, type ExitCode } from '@yuki-byte18/shared';
import { createFileRunStore } from '@yuki-byte18/core';
import { closeMemory, createMemory } from '@yuki-byte18/adapters';
import { join } from 'node:path';
import { loadConfig } from '../config-loader.js';

export interface HistoryOptions {
  cwd: string;
  config?: string;
  project?: string;
  limit?: string;
  showFailures?: boolean;
  /** 忘掉失败记忆：给定指纹则只忘一条 */
  forget?: string;
  /** 忘掉该项目的全部失败记忆 */
  forgetAll?: boolean;
}

/**
 * `perfpilot history` —— 历史记录查询。
 *
 * 两个视图：
 * - 默认：`.perfpilot/runs/` 里的运行记录（文件系统存储）
 * - `--show-failures`：记忆层里的**失败记忆**（哪些改法失败过、为什么）
 *
 * 后者是 M6 加的，也是这个工具"越用越聪明"的唯一可见证据：
 * 失败记忆一旦写下，planner 下一轮就不会再提同一个改法 ——
 * 因此必须能被人查到"它到底记住了什么"，否则那条规则就成了一个黑箱。
 *
 * 本文件只做**展示**，不做聚合计算 —— 聚合逻辑属于 Memory 层。
 */
export async function history(options: HistoryOptions): Promise<ExitCode> {
  const loaded = await loadConfig({
    cwd: options.cwd,
    ...(options.config !== undefined ? { configPath: options.config } : {}),
  });

  const store = createFileRunStore({ baseDir: join(loaded.root, '.perfpilot') });
  const limit = clampLimit(options.limit);
  const project = options.project ?? loaded.config.project.name;

  const all = await store.list();
  const filtered = all.filter((s) => project === '' || s.project === project).slice(0, limit);

  if (filtered.length === 0) {
    process.stdout.write(
      `\n# 历史记录 · ${project}\n\n_暂无记录。先跑一次 \`perfpilot diagnose\`。_\n`,
    );
  } else {
    process.stdout.write(
      `\n# 历史记录 · ${project}\n\n共 ${filtered.length} 条（总计 ${all.length} 条）。\n\n`,
    );
    process.stdout.write('| Run | 路由 | 设备 | 状态 | 指标 | 时间 |\n');
    process.stdout.write('| --- | --- | :---: | :---: | ---: | --- |\n');

    const statusIcon = { success: '✅', partial: '⚡', failed: '❌' } as const;
    for (const summary of filtered) {
      process.stdout.write(
        `| ${isSafeId(summary.id) ? `\`${summary.id}\`` : '—'} | \`${summary.route}\` | ${summary.device} | ${
          statusIcon[summary.status]
        } ${summary.status} | ${summary.metricCount} | ${summary.startedAt} |\n`,
      );
    }
    process.stdout.write('\n');
  }

  if (options.showFailures === true || options.forget !== undefined || options.forgetAll === true) {
    await handleFailures({ loaded, project, limit, options });
  }

  return 0;
}

/**
 * 失败记忆：查看与撤销。
 *
 * ## 为什么必须有撤销
 *
 * 失败记忆是**一票否决**：命中指纹就不再提案，而指纹是「瓶颈类型 + 改动类型」，
 * 不含文件路径。一次误判（当时测试环境坏了、预览环境没起来、阈值被临时调紧）
 * 会让这一类改动在这个项目上**永久消失**。没有出口的话，用户只能删库 ——
 * 而删库会连带上所有别的好记忆。
 */
async function handleFailures(input: {
  loaded: Awaited<ReturnType<typeof loadConfig>>;
  project: string;
  limit: number;
  options: HistoryOptions;
}): Promise<void> {
  const { loaded, project, limit, options } = input;

  let memory;
  try {
    memory = createMemory({ config: loaded.config.memory, root: loaded.root });
  } catch (err) {
    process.stdout.write(
      `\n## 失败记忆\n\n_memory 打不开：${err instanceof Error ? err.message : String(err)}_\n\n`,
    );
    return;
  }

  try {
    // ── 撤销 ────────────────────────────────────────────────────
    if (options.forget !== undefined || options.forgetAll === true) {
      const removed = await memory.forgetFailures({
        project,
        ...(options.forget !== undefined ? { fingerprint: options.forget } : {}),
        ...(options.forgetAll === true ? { all: true } : {}),
      });

      process.stdout.write(
        removed === 0
          ? `\n没有可忘掉的失败记忆${options.forget === undefined ? '' : `（指纹 \`${options.forget}\` 不在库里）`}。\n\n`
          : `\n✅ 已忘掉 ${removed} 条失败记忆。下一轮方案生成时这些改法会重新被提案。\n\n`,
      );

      if (removed === 0 && options.forget !== undefined) {
        process.stdout.write(
          '提示：指纹用 `history --show-failures` 里那一列原样复制，它由「瓶颈类型 + 改动类型」拼成。\n\n',
        );
      }
      return;
    }

    // ── 查看 ────────────────────────────────────────────────────
    const failures = await memory.listFailures(project, limit);
    process.stdout.write(`\n## 失败记忆 · ${project}\n\n`);

    if (failures.length === 0) {
      process.stdout.write(
        '_暂无失败记忆。它只在某个改动被验证失败并回滚时才写入 —— ' +
          '`diagnose` 不改代码，因此不会产生失败记忆。_\n\n',
      );
      return;
    }

    process.stdout.write('| 时间 | 问题类型 | 改动指纹 | 失败原因 |\n');
    process.stdout.write('| --- | --- | --- | --- |\n');
    for (const failure of failures) {
      process.stdout.write(
        `| ${failure.failedAt} | \`${failure.bottleneckKind}\` | \`${failure.candidateFingerprint}\` | ${failure.failureReason.replace(/\|/g, '\\|')} |\n`,
      );
    }
    process.stdout.write(
      `\n> 这 ${failures.length} 条改法在下一轮方案生成时会被**直接跳过**：\n` +
        '> 指纹是「瓶颈类型 + 改动类型」，不含文件路径 —— 同一个改法在别的图片/别的文件上同样会被跳过。\n' +
        '>\n' +
        '> 如果某条是**误判**（当时环境坏了、阈值调紧过），用下面的命令让它重新参与提案：\n' +
        '>\n' +
        `> \`perfpilot history --forget '<改动指纹>'\`  或  \`perfpilot history --forget-all\`\n\n`,
    );
  } finally {
    closeMemory(memory);
  }
}

function clampLimit(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? '20', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 20;
  return Math.min(parsed, 500);
}
