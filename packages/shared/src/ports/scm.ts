/**
 * Git / SCM 端口（README §5 adapters/git）。
 *
 * 所有 git 操作必须经过 adapter，core 里不得直接调用 `child_process`（硬约束 5）。
 * verifier 用它做回滚，CI 阶段用它做分支切换与 PR 创建。
 */

/** git diff 的一条变更 */
export interface DiffEntry {
  path: string;
  /** unified diff 文本 */
  diff: string;
}

export interface GitPort {
  /** 当前工作区是否干净（无未提交改动） */
  isClean(): Promise<boolean>;
  /** 当前分支名 */
  currentBranch(): Promise<string>;
  /** 当前 HEAD commit */
  currentRef(): Promise<string>;

  /**
   * 远端的 origin 地址；没有远端时返回 null。
   *
   * `perfpilot init` 用它填 `target.repo`（那份仓库标识是 MR 评论与自动 PR 的回落值）。
   * 放在端口上而不是让 CLI 直接跑 `git`：硬约束 5 —— 所有外部工具调用都经过
   * adapter，CLI 与 core 都不该认识 `git` 这个可执行文件。
   */
  remoteUrl(): Promise<string | null>;

  /** 创建一个 worktree 用于执行改动，返回 worktree 路径 */
  createWorktree(branch: string, baseRef: string): Promise<string>;
  /** 删除 worktree */
  removeWorktree(path: string): Promise<void>;

  /**
   * 应用 patch。返回 false 表示 apply 失败（冲突等）。
   * 失败时工作区应保持原状。
   */
  applyPatch(patch: string): Promise<boolean>;

  /** 暂存并提交，返回 commit hash；无改动时返回 null */
  commit(message: string, author?: string): Promise<string | null>;

  /** 回滚到指定 ref（hard reset），用于验证失败后的回滚 */
  resetHard(ref: string): Promise<void>;

  /** 两 ref 之间的 diff */
  diff(fromRef: string, toRef: string): Promise<DiffEntry[]>;

  /** 推送分支到远端 */
  push(branch: string, force?: boolean): Promise<void>;
}

/**
 * GitHub / GitLab 等代码托管平台的 SCM 端口。
 *
 * 与 GitPort 分开：GitPort 管本地仓库操作，ScmPort 管平台 API（MR 评论、PR 创建）。
 * 未接入 SCM 时用 null 实现。
 */
export interface ScmPort {
  readonly provider: 'github' | 'gitlab' | 'none';

  /** 在 MR/PR 上发布评论 */
  commentOnMr(mrId: string, body: string): Promise<void>;

  /**
   * 发布**或更新**评论。
   *
   * MR 会被反复推送，每次推送都触发一轮 CI。如果只追加，
   * 一个来回十几次的 MR 会攒出十几条几乎一样的评论 —— 评审的人只会把整个区块折叠掉，
   * 于是门禁结论再也没人看。
   *
   * 判据是 `marker`（一段 HTML 注释，如 `<!-- perfpilot-report -->`）：
   * 找到带这个标记的旧评论就更新它，找不到才新建。
   * 返回 `'created' | 'updated'` 让调用方能如实写日志与提示。
   */
  upsertComment(mrId: string, marker: string, body: string): Promise<'created' | 'updated'>;

  /** 创建 PR，返回 PR URL */
  createPullRequest(input: {
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<string>;

  /** 设置 CI 状态（pending / success / failure） */
  setCommitStatus(ref: string, state: 'pending' | 'success' | 'failure', description: string): Promise<void>;
}

/** 空 Git 实现：无仓库 / 测试注入时使用，所有写操作都是 no-op */
export function createNullGit(): GitPort {
  return {
    async isClean() {
      return true;
    },
    async currentBranch() {
      return 'main';
    },
    async currentRef() {
      return 'HEAD';
    },
    async remoteUrl() {
      return null;
    },
    async createWorktree() {
      return '';
    },
    async removeWorktree() {
      /* no-op */
    },
    async applyPatch() {
      return true;
    },
    async commit() {
      return null;
    },
    async resetHard() {
      /* no-op */
    },
    async diff() {
      return [];
    },
    async push() {
      /* no-op */
    },
  };
}

/** 空 SCM 实现：未配置代码托管平台、或测试注入时使用，所有写操作都是 no-op */
export function createNullScm(): ScmPort {
  return {
    provider: 'none',
    async commentOnMr() {
      /* no-op */
    },
    async upsertComment() {
      // 没有平台可写，但也不能假装"更新了"——调用方靠返回值写日志
      return 'created';
    },
    async createPullRequest() {
      return '';
    },
    async setCommitStatus() {
      /* no-op */
    },
  };
}
