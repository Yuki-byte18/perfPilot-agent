import { execFile } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { AdapterError, type DiffEntry, type GitPort } from '@yuki-byte18/shared';

const execFileAsync = promisify(execFile);

export interface GitAdapterOptions {
  /** 仓库工作目录（绝对路径） */
  cwd: string;
  /** worktree 建在哪里，默认 `<cwd>/.perfpilot/worktrees` */
  worktreeRoot?: string;
}

/**
 * Git 适配器。
 *
 * 硬约束 5：core 不得调用外部进程，因此所有 git 操作收敛在这里。
 * verifier 用它做回滚，CI 阶段用它切换分支与推送。
 *
 * 一个刻意的选择：**回滚不做"再跑一次反向补丁"，而是 `reset --hard` 到基线 ref**。
 * 反向补丁只能撤销它自己引入的改动；一旦执行过程中还产生了别的副作用
 * （新建文件、依赖安装、asset 写入），反向补丁撤不干净。
 * `reset --hard` 是"回到已知状态"，语义上更强也更简单。
 */
export function createGitAdapter(options: GitAdapterOptions): GitPort {
  const cwd = options.cwd;
  const worktreeRoot = options.worktreeRoot ?? join(cwd, '.perfpilot', 'worktrees');

  const run = async (args: readonly string[], cwdOverride?: string): Promise<string> => {
    try {
      const { stdout } = await execFileAsync('git', [...args], {
        cwd: cwdOverride ?? cwd,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      });
      return stdout;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AdapterError(`git ${args[0] ?? ''} 失败: ${message}`, {
        code: 'ADAPTER_FAILED',
        stage: 'execute',
        retryable: false,
        details: { args },
        cause: err,
      });
    }
  };

  /** 允许失败的调用：返回 null 而不是抛错 */
  const tryRun = async (args: readonly string[], cwdOverride?: string): Promise<string | null> => {
    try {
      return await run(args, cwdOverride);
    } catch {
      return null;
    }
  };

  return {
    async isClean(): Promise<boolean> {
      const out = await run(['status', '--porcelain']);
      return out.trim() === '';
    },

    async currentBranch(): Promise<string> {
      const out = await run(['rev-parse', '--abbrev-ref', 'HEAD']);
      return out.trim();
    },

    async currentRef(): Promise<string> {
      const out = await run(['rev-parse', 'HEAD']);
      return out.trim();
    },

    /**
     * origin 的地址；没有远端（或不是 git 仓库）时返回 null。
     *
     * 用 `tryRun` 而不是 `run`：本地刚 `git init` 的项目没有 origin，
     * 那是**正常状态**，不该抛异常 —— `perfpilot init` 会据此留下 TODO 让用户填。
     */
    async remoteUrl(): Promise<string | null> {
      const out = await tryRun(['remote', 'get-url', 'origin']);
      if (out === null) return null;
      const trimmed = out.trim();
      return trimmed === '' ? null : trimmed;
    },

    async createWorktree(branch: string, baseRef: string): Promise<string> {
      const path = join(worktreeRoot, branch.replace(/[^A-Za-z0-9._-]/g, '-'));
      // 已存在则先清掉，避免因为上次异常退出而失败
      await tryRun(['worktree', 'remove', '--force', path]);
      await run(['worktree', 'add', '-b', branch, path, baseRef]);
      return path;
    },

    async removeWorktree(path: string): Promise<void> {
      const out = await tryRun(['worktree', 'remove', '--force', path]);
      if (out === null) {
        // git 认不出这个 worktree 时直接删目录，保证不留垃圾
        await rm(path, { recursive: true, force: true });
      }
    },

    async applyPatch(patch: string): Promise<boolean> {
      if (patch.trim() === '') return false;

      const file = join(cwd, '.perfpilot', 'apply.patch');
      const { writeFile, mkdir } = await import('node:fs/promises');
      await mkdir(join(cwd, '.perfpilot'), { recursive: true });
      await writeFile(file, patch, 'utf8');

      // 先 --check：冲突时不改动工作区，保证"apply 失败则保持原状"
      const checked = await tryRun(['apply', '--check', '--whitespace=nowarn', file]);
      if (checked === null) return false;

      const applied = await tryRun(['apply', '--whitespace=nowarn', file]);
      await rm(file, { force: true });
      return applied !== null;
    },

    async commit(message: string, author?: string): Promise<string | null> {
      // 没有任何改动时 commit 会失败，先判断
      const staged = await run(['status', '--porcelain']);
      if (staged.trim() === '') return null;

      await run(['add', '-A']);
      const args = ['commit', '-m', message];
      if (author !== undefined) args.push(`--author=${author}`);

      await run(args);
      return (await run(['rev-parse', 'HEAD'])).trim();
    },

    async resetHard(ref: string): Promise<void> {
      await run(['reset', '--hard', ref]);
      // reset 不清理未跟踪文件（比如 asset 写入的新图片），必须单独清
      await run(['clean', '-fd']);
    },

    async diff(fromRef: string, toRef: string): Promise<DiffEntry[]> {
      const out = await run(['diff', '--no-color', fromRef, toRef]);
      return parseDiff(out);
    },

    async push(branch: string, force = false): Promise<void> {
      const args = ['push', '-u', 'origin', branch];
      if (force) args.push('--force-with-lease');
      await run(args);
    },
  };
}

/** 把 `git diff` 输出切成按文件的条目 */
export function parseDiff(output: string): DiffEntry[] {
  if (output.trim() === '') return [];

  const entries: DiffEntry[] = [];
  let current: { path: string; lines: string[] } | null = null;

  for (const line of output.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (current !== null) entries.push({ path: current.path, diff: current.lines.join('\n') });
      // `diff --git a/x b/x` → 取 b/ 侧路径
      const match = /diff --git a\/(.+?) b\/(.+)$/.exec(line);
      current = { path: match?.[2] ?? line.slice('diff --git '.length), lines: [line] };
      continue;
    }
    current?.lines.push(line);
  }

  if (current !== null) entries.push({ path: current.path, diff: current.lines.join('\n') });
  return entries;
}
