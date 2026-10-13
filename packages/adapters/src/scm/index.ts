import { AdapterError, toPerfPilotError, type ScmPort } from '@yuki-byte18/shared';

/**
 * 代码托管平台适配器（GitHub / GitLab）。
 *
 * 硬约束 5：所有外部调用经过 adapter，core 只认识 `ScmPort`。
 * 这里用 Node 内置的 `fetch`，**不引第三方 SDK** —— 我们只用到三个端点
 * （发评论 / 建 PR / 设状态），一个 SDK 带来的依赖树与版本升级成本
 * 远大于这三段 HTTP 调用。
 *
 * ## 关于"注入 fetch"
 *
 * `fetch` 做成可注入的，不是为了抽象，是为了**能测**：
 * 否则验证"评论发出去没有"就得真的建一个 PR。这里注入一个记录请求的假实现，
 * 就能断言请求体长什么样、认证头带没带对、出错时会不会把 token 打进日志。
 */

/** `fetch` 里我们真正用到的那部分 */
export type FetchLike = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
}>;

export interface GithubScmOptions {
  /** 形如 `owner/repo` */
  repo: string;
  token: string;
  /** GitHub Enterprise 用，默认 https://api.github.com */
  apiUrl?: string;
  fetchImpl?: FetchLike;
}

/**
 * 从 CI 环境里读出"这是哪个 MR / PR"。
 *
 * 两个平台的环境变量完全不同，而且都**只在 CI 里存在**。
 * 读不到就返回 null，调用方据此决定"跳过评论"而不是"评论到错误的地方" ——
 * 后者会在主分支上留下一条莫名其妙的评论。
 */
export interface CiContext {
  /** 平台 */
  provider: 'github' | 'gitlab' | 'none';
  /** PR / MR 编号 */
  mrId: string | null;
  /** 目标分支 */
  baseBranch: string | null;
  /** 源分支（head） */
  headBranch: string | null;
  /** 当前提交 */
  commitSha: string | null;
  /** 仓库标识：GitHub 是 owner/repo，GitLab 是项目 ID 或 path */
  repo: string | null;
  /** 服务端 URL（报告链接前缀用） */
  serverUrl: string | null;
  /** 触发本次运行的原因，写进 MR 评论便于追溯 */
  eventName: string | null;
}

export function detectCiContext(env: Record<string, string | undefined>): CiContext {
  const pick = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = env[key];
      if (value !== undefined && value.trim() !== '') return value.trim();
    }
    return null;
  };

  // GitLab 的 MR 变量以 `CI_MERGE_REQUEST_` 开头，比 GitHub 的特征更明确，
  // 因此先判它 —— 两个平台的变量理论上可能同时存在（比如 GitHub 上跑 GitLab 镜像）
  if (pick('GITLAB_CI') !== null || pick('CI_MERGE_REQUEST_IID') !== null) {
    return {
      provider: 'gitlab',
      mrId: pick('CI_MERGE_REQUEST_IID'),
      baseBranch: pick('CI_MERGE_REQUEST_TARGET_BRANCH_NAME'),
      headBranch: pick('CI_MERGE_REQUEST_SOURCE_BRANCH_NAME'),
      commitSha: pick('CI_COMMIT_SHA'),
      repo: pick('CI_PROJECT_ID', 'CI_PROJECT_PATH'),
      serverUrl: pick('CI_PROJECT_URL'),
      eventName: pick('CI_PIPELINE_SOURCE'),
    };
  }

  if (pick('GITHUB_ACTIONS') !== null || pick('GITHUB_EVENT_NAME') !== null) {
    return {
      provider: 'github',
      mrId: pick('PR_NUMBER'),
      baseBranch: pick('GITHUB_BASE_REF'),
      headBranch: pick('GITHUB_HEAD_REF'),
      commitSha: pick('GITHUB_SHA'),
      repo: pick('GITHUB_REPOSITORY'),
      serverUrl: pick('GITHUB_SERVER_URL'),
      eventName: pick('GITHUB_EVENT_NAME'),
    };
  }

  return {
    provider: 'none',
    mrId: null,
    baseBranch: null,
    headBranch: null,
    commitSha: null,
    repo: null,
    serverUrl: null,
    eventName: null,
  };
}

/**
 * GitHub 适配器。
 *
 * 三个端点：
 * - `POST /repos/{owner}/{repo}/issues/{n}/comments`  发评论
 * - `POST /repos/{owner}/{repo}/pulls`                 建 PR
 * - `POST /repos/{owner}/{repo}/statuses/{sha}`        设提交状态
 */
export function createGithubScm(options: GithubScmOptions): ScmPort {
  const api = (options.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '');
  const doFetch = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);

  const request = async (
    method: 'POST' | 'PATCH',
    path: string,
    body: unknown,
  ): Promise<unknown> => {
    const response = await doFetch(`${api}${path}`, {
      method,
      headers: {
        // token 只出现在请求头里，永远不进日志与错误信息
        authorization: `Bearer ${options.token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'perfpilot-agent',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new AdapterError(`GitHub API ${method} ${path} 失败（${response.status}）`, {
        code: 'ADAPTER_FAILED',
        retryable: response.status >= 500,
        // 响应正文可能很长，截断后再进错误详情
        details: { status: response.status, body: text.slice(0, 500) },
      });
    }

    return response.json().catch(() => null);
  };

  return {
    provider: 'github',

    async commentOnMr(mrId: string, body: string): Promise<void> {
      await request('POST', `/repos/${options.repo}/issues/${mrId}/comments`, { body });
    },

    /**
     * 找到带标记的旧评论就更新，否则新建。
     *
     * GitHub 的评论更新走 `PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}`
     * —— 注意它用的是 **comment id**（而不是 issue 编号），因此必须先列表再更新。
     * 只取最近 100 条：一个 MR 上千条评论的情况不存在，而分页会让逻辑复杂一倍。
     */
    async upsertComment(mrId: string, marker: string, body: string): Promise<'created' | 'updated'> {
      const existing = await listWith(
        doFetch,
        `${api}/repos/${options.repo}/issues/${mrId}/comments?per_page=100`,
        { authorization: `Bearer ${options.token}` },
      );

      const mine = existing.find((comment) => comment.body.includes(marker));

      if (mine === null || mine === undefined) {
        await request('POST', `/repos/${options.repo}/issues/${mrId}/comments`, { body });
        return 'created';
      }

      await request('PATCH', `/repos/${options.repo}/issues/comments/${mine.id}`, { body });
      return 'updated';
    },

    async createPullRequest(input): Promise<string> {
      const created = (await request('POST', `/repos/${options.repo}/pulls`, {
        title: input.title,
        body: input.body,
        head: input.head,
        base: input.base,
      })) as { html_url?: string } | null;

      return created?.html_url ?? '';
    },

    async setCommitStatus(ref, state, description): Promise<void> {
      await request('POST', `/repos/${options.repo}/statuses/${ref}`, {
        state,
        description: description.slice(0, 140), // GitHub 限制 140 字符
        context: 'perfpilot',
      });
    },
  };
}

/**
 * 读一个列表端点，失败时**返回空数组**而不是抛错。
 *
 * 只在"找旧评论"这条路径上用：列表拉不到（权限不足、端点变了）时，
 * 退化成"新建一条评论"是可以接受的；而为此让整轮 CI 失败则不可接受 ——
 * 评论只是分发渠道，不是门禁结论本身。
 */
async function listWith(
  doFetch: FetchLike,
  url: string,
  headers: Record<string, string>,
): Promise<Array<{ id: number | string; body: string }>> {
  try {
    const response = await doFetch(url, { method: 'GET', headers: { ...headers, accept: 'application/json' } });
    if (!response.ok) return [];

    const parsed: unknown = await response.json();
    if (!Array.isArray(parsed)) return [];

    return parsed
      .map((item) => {
        if (typeof item !== 'object' || item === null) return null;
        const record = item as { id?: unknown; body?: unknown };
        if (record.body === undefined) return null;
        return {
          id: typeof record.id === 'number' || typeof record.id === 'string' ? record.id : '',
          body: String(record.body),
        };
      })
      .filter((item): item is { id: number | string; body: string } => item !== null);
  } catch {
    return [];
  }
}

export interface GitlabScmOptions {
  /** 项目 ID 或 URL 编码后的 path（`group%2Fproject`） */
  projectId: string;
  token: string;
  /** 自建 GitLab 用，默认 https://gitlab.com/api/v4 */
  apiUrl?: string;
  fetchImpl?: FetchLike;
}

/**
 * GitLab 适配器。
 *
 * 与 GitHub 的三个差异值得写下来，它们都是踩过才知道的：
 * - 认证头是 `PRIVATE-TOKEN`，不是 `Authorization: Bearer`
 * - 评论叫 note，走 `merge_requests/{iid}/notes`
 * - 提交状态用 `state=success|failed|running`（GitHub 是 `success|failure|pending`）
 */
export function createGitlabScm(options: GitlabScmOptions): ScmPort {
  const api = (options.apiUrl ?? 'https://gitlab.com/api/v4').replace(/\/+$/, '');
  const doFetch = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);

  const request = async (path: string, body: unknown): Promise<unknown> => {
    const response = await doFetch(`${api}${path}`, {
      method: 'POST',
      headers: {
        'private-token': options.token,
        'content-type': 'application/json',
        'user-agent': 'perfpilot-agent',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new AdapterError(`GitLab API POST ${path} 失败（${response.status}）`, {
        code: 'ADAPTER_FAILED',
        retryable: response.status >= 500,
        details: { status: response.status, body: text.slice(0, 500) },
      });
    }

    return response.json().catch(() => null);
  };

  return {
    provider: 'gitlab',

    async commentOnMr(mrId: string, body: string): Promise<void> {
      await request(`/projects/${options.projectId}/merge_requests/${mrId}/notes`, { body });
    },

    /**
     * GitLab 的评论叫 note，且**更新走 PUT**（GitHub 是 PATCH）。
     * note id 是项目内唯一的整数，因此和 GitHub 一样要先列表再更新。
     */
    async upsertComment(mrId: string, marker: string, body: string): Promise<'created' | 'updated'> {
      const existing = await listWith(
        doFetch,
        `${api}/projects/${options.projectId}/merge_requests/${mrId}/notes?per_page=100`,
        { 'private-token': options.token },
      );

      const mine = existing.find((note) => note.body.includes(marker));

      if (mine === null || mine === undefined) {
        await request(`/projects/${options.projectId}/merge_requests/${mrId}/notes`, { body });
        return 'created';
      }

      await putJson(
        doFetch,
        `${api}/projects/${options.projectId}/merge_requests/${mrId}/notes/${mine.id}`,
        { 'private-token': options.token },
        { body },
      );
      return 'updated';
    },

    async createPullRequest(input): Promise<string> {
      const created = (await request(`/projects/${options.projectId}/merge_requests`, {
        title: input.title,
        description: input.body,
        source_branch: input.head,
        target_branch: input.base,
      })) as { web_url?: string } | null;

      return created?.web_url ?? '';
    },

    async setCommitStatus(ref, state, description): Promise<void> {
      await request(`/projects/${options.projectId}/statuses/${ref}`, {
        state: state === 'pending' ? 'running' : state === 'failure' ? 'failed' : 'success',
        name: 'perfpilot',
        description,
      });
    },
  };
}

/** GitLab 的更新是 PUT；单独抽出来是因为 `request` 只发 POST */
async function putJson(
  doFetch: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<void> {
  const response = await doFetch(url, {
    method: 'PUT',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new AdapterError(`GitLab API PUT ${url} 失败（${response.status}）`, {
      code: 'ADAPTER_FAILED',
      retryable: response.status >= 500,
      details: { status: response.status, body: text.slice(0, 500) },
    });
  }
}

/** 配置里的仓库信息，用于不在 CI 时的兜底 */
export interface ScmFallbackOptions {
  /**
   * 仓库标识。GitHub 传 `owner/repo`，也接受完整 URL
   * （`https://github.com/owner/repo`）—— 配置里两种写法都很自然。
   */
  repo?: string;
  /** 目标分支（PR 的 base） */
  baseBranch?: string;
}

/**
 * 从仓库 URL 里取出 `owner/repo`。
 *
 * 配置示例里写的是完整 URL（`https://github.com/org/app`），而 GitHub API
 * 要的是 `org/app`。直接拿 URL 去拼 `/repos/https://github.com/...` 会得到
 * 一个 404，而错误信息完全看不出是这里的问题。
 */
export function repoSlugOf(repo: string): string {
  const trimmed = repo.trim().replace(/\.git$/, '').replace(/\/+$/, '');
  if (!trimmed.includes('://') && !trimmed.startsWith('git@')) return trimmed;

  try {
    // git@github.com:owner/repo 这种 SSH 形式
    const ssh = /^git@[^:]+:(.+)$/.exec(trimmed);
    if (ssh?.[1] !== undefined) return ssh[1];

    const url = new URL(trimmed);
    return url.pathname.replace(/^\/+/, '');
  } catch {
    return trimmed;
  }
}

/**
 * 按环境变量创建 SCM 适配器。
 *
 * 拿不到 token 就返回 null —— **不假装接了平台**。调用方据此
 * 输出一条"未接入 SCM，评论已写入文件"的提示，而不是静默什么都不做。
 *
 * `fallback` 是配置里的仓库信息：CI 环境变量优先（那里是最权威的来源），
 * 缺失时用它兜底 —— 否则本地想试一次 `comment_mr` 就得伪造一堆环境变量。
 */
export function createScmFromEnv(
  env: Record<string, string | undefined> = process.env,
  fetchImpl?: FetchLike,
  fallback: ScmFallbackOptions = {},
): { scm: ScmPort | null; context: CiContext; reason: string } {
  const detected = detectCiContext(env);
  const repo = detected.repo ?? fallback.repo ?? null;

  const context: CiContext = {
    ...detected,
    repo,
    ...(detected.baseBranch === null && fallback.baseBranch !== undefined
      ? { baseBranch: fallback.baseBranch }
      : {}),
  };

  try {
    if (context.provider === 'github') {
      const token = env['GITHUB_TOKEN'] ?? env['GH_TOKEN'] ?? '';
      if (token === '' || context.repo === null) {
        return { scm: null, context, reason: '缺少 GITHUB_TOKEN 或 GITHUB_REPOSITORY' };
      }
      return {
        scm: createGithubScm({
          repo: context.repo,
          token,
          ...(env['GITHUB_API_URL'] !== undefined ? { apiUrl: env['GITHUB_API_URL'] } : {}),
          ...(fetchImpl !== undefined ? { fetchImpl } : {}),
        }),
        context,
        reason: '',
      };
    }

    if (context.provider === 'gitlab') {
      const token = env['GITLAB_TOKEN'] ?? env['CI_JOB_TOKEN'] ?? '';
      if (token === '' || context.repo === null) {
        return { scm: null, context, reason: '缺少 GITLAB_TOKEN 或 CI_PROJECT_ID' };
      }
      return {
        scm: createGitlabScm({
          projectId: context.repo,
          token,
          ...(env['CI_API_V4_URL'] !== undefined ? { apiUrl: env['CI_API_V4_URL'] } : {}),
          ...(fetchImpl !== undefined ? { fetchImpl } : {}),
        }),
        context,
        reason: '',
      };
    }

    return { scm: null, context, reason: '当前不在 GitHub Actions / GitLab CI 环境中' };
  } catch (err) {
    return { scm: null, context, reason: toPerfPilotError(err).message };
  }
}
