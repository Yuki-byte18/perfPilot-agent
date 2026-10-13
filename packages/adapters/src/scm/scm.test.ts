import { describe, expect, it } from 'vitest';
import {
  createGithubScm,
  createGitlabScm,
  createScmFromEnv,
  detectCiContext,
  type FetchLike,
} from './index.js';

/**
 * SCM 适配器（M7 验收 3/4）。
 *
 * 这里不建真的 PR —— 但**必须验请求体**：平台 API 的字段名错一个
 * （`source_branch` 写成 `sourceBranch`）不会在本地报错，
 * 只会在 CI 里换来一个 400，而那时你正在看性能报告，不会想到是这里。
 */

interface Call {
  url: string;
  method: string | undefined;
  headers: Record<string, string> | undefined;
  body: unknown;
}

/** 记录请求的假 fetch；可指定某个请求失败 */
function recordingFetch(failWith?: number): { calls: Call[]; fetchImpl: FetchLike } {
  const calls: Call[] = [];

  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method,
      headers: init?.headers,
      body: init?.body === undefined ? undefined : JSON.parse(init.body),
    });

    if (failWith !== undefined) {
      return {
        ok: false,
        status: failWith,
        text: async () => '{"message":"Bad credentials"}',
        json: async () => ({}),
      };
    }

    return {
      ok: true,
      status: 201,
      text: async () => '',
      json: async () => ({ html_url: 'https://github.com/o/r/pull/7', web_url: 'https://gitlab.com/mr/7' }),
    };
  };

  return { calls, fetchImpl };
}

describe('M7 验收 3 — MR 评论', () => {
  it('GitHub：打到 issues/{n}/comments，带 Bearer 认证', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const scm = createGithubScm({ repo: 'owner/repo', token: 'ghp_x', fetchImpl });

    await scm.commentOnMr('42', '报告正文');

    expect(calls[0]?.url).toBe('https://api.github.com/repos/owner/repo/issues/42/comments');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers?.['authorization']).toBe('Bearer ghp_x');
    expect(calls[0]?.body).toEqual({ body: '报告正文' });
  });

  it('GitLab：打到 merge_requests/{iid}/notes，认证头是 PRIVATE-TOKEN', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const scm = createGitlabScm({ projectId: '123', token: 'glpat-x', fetchImpl });

    await scm.commentOnMr('7', '报告正文');

    expect(calls[0]?.url).toBe('https://gitlab.com/api/v4/projects/123/merge_requests/7/notes');
    // GitLab 不认 Bearer：这个差异写错就是 401
    expect(calls[0]?.headers?.['private-token']).toBe('glpat-x');
    expect(calls[0]?.body).toEqual({ body: '报告正文' });
  });

  it('平台返回错误时抛 AdapterError，且不把 token 写进错误信息', async () => {
    const { fetchImpl } = recordingFetch(401);
    const scm = createGithubScm({ repo: 'owner/repo', token: 'ghp_secret', fetchImpl });

    await expect(scm.commentOnMr('42', 'x')).rejects.toThrow(/401/);
    // 错误详情里可以有响应正文，但绝不能有凭据
    await expect(scm.commentOnMr('42', 'x')).rejects.not.toThrow(/ghp_secret/);
  });
});

describe('M7 验收 4 — 自动 PR', () => {
  it('GitHub：字段名是 head / base', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const scm = createGithubScm({ repo: 'owner/repo', token: 't', fetchImpl });

    const url = await scm.createPullRequest({
      title: 'perfpilot: 优化',
      body: '正文',
      head: 'perfpilot/run_1',
      base: 'main',
    });

    expect(calls[0]?.url).toBe('https://api.github.com/repos/owner/repo/pulls');
    expect(calls[0]?.body).toEqual({
      title: 'perfpilot: 优化',
      body: '正文',
      head: 'perfpilot/run_1',
      base: 'main',
    });
    expect(url).toBe('https://github.com/o/r/pull/7');
  });

  it('GitLab：字段名是 source_branch / target_branch', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const scm = createGitlabScm({ projectId: 'g%2Fp', token: 't', fetchImpl });

    const url = await scm.createPullRequest({
      title: 'perfpilot: 优化',
      body: '正文',
      head: 'perfpilot/run_1',
      base: 'main',
    });

    // 平台字段名不同这一点，只有真的断言请求体才能发现
    expect(calls[0]?.body).toEqual({
      title: 'perfpilot: 优化',
      description: '正文',
      source_branch: 'perfpilot/run_1',
      target_branch: 'main',
    });
    expect(url).toBe('https://gitlab.com/mr/7');
  });

  it('提交状态的取值也要转换（GitHub failure ↔ GitLab failed）', async () => {
    const gh = recordingFetch();
    await createGithubScm({ repo: 'o/r', token: 't', fetchImpl: gh.fetchImpl }).setCommitStatus(
      'sha1',
      'failure',
      '门禁未通过',
    );
    expect(gh.calls[0]?.body).toMatchObject({ state: 'failure', context: 'perfpilot' });

    const gl = recordingFetch();
    await createGitlabScm({ projectId: '1', token: 't', fetchImpl: gl.fetchImpl }).setCommitStatus(
      'sha1',
      'failure',
      '门禁未通过',
    );
    expect(gl.calls[0]?.body).toMatchObject({ state: 'failed', name: 'perfpilot' });
  });
});

describe('M7/M8 — 评论 upsert（不追加）', () => {
  /** 列表端点返回既有评论；其余端点记录调用 */
  function upsertFetch(existing: Array<{ id: number; body: string }>): {
    calls: Call[];
    fetchImpl: FetchLike;
  } {
    const calls: Call[] = [];

    const fetchImpl: FetchLike = async (url, init) => {
      const method = init?.method ?? 'GET';
      calls.push({
        url,
        method,
        headers: init?.headers,
        body: init?.body === undefined ? undefined : JSON.parse(init.body),
      });

      if (method === 'GET') {
        return { ok: true, status: 200, text: async () => '', json: async () => existing };
      }
      return { ok: true, status: 200, text: async () => '', json: async () => ({}) };
    };

    return { calls, fetchImpl };
  }

  const MARKER = '<!-- perfpilot-report -->';

  it('GitHub：有旧评论时走 PATCH 更新（用 comment id，不是 issue 编号）', async () => {
    const { calls, fetchImpl } = upsertFetch([{ id: 999, body: `${MARKER}\n旧内容` }]);
    const scm = createGithubScm({ repo: 'owner/repo', token: 't', fetchImpl });

    const action = await scm.upsertComment('42', MARKER, `${MARKER}\n新内容`);

    expect(action).toBe('updated');
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PATCH']);
    // 更新的是 comment id 999，而不是 issue 42
    expect(calls[1]?.url).toBe('https://api.github.com/repos/owner/repo/issues/comments/999');
  });

  it('GitHub：没有旧评论时新建', async () => {
    const { calls, fetchImpl } = upsertFetch([{ id: 1, body: '别人写的评论' }]);
    const scm = createGithubScm({ repo: 'owner/repo', token: 't', fetchImpl });

    const action = await scm.upsertComment('42', MARKER, `${MARKER}\n内容`);

    expect(action).toBe('created');
    expect(calls[1]?.url).toBe('https://api.github.com/repos/owner/repo/issues/42/comments');
    expect(calls[1]?.method).toBe('POST');
  });

  it('GitLab：更新走 PUT（GitHub 是 PATCH）', async () => {
    const { calls, fetchImpl } = upsertFetch([{ id: 7, body: `${MARKER}\n旧` }]);
    const scm = createGitlabScm({ projectId: '123', token: 't', fetchImpl });

    const action = await scm.upsertComment('5', MARKER, `${MARKER}\n新`);

    expect(action).toBe('updated');
    expect(calls[1]?.method).toBe('PUT');
    expect(calls[1]?.url).toBe('https://gitlab.com/api/v4/projects/123/merge_requests/5/notes/7');
  });

  it('列表端点挂掉时退化成新建，而不是让整轮 CI 失败', async () => {
    const calls: Call[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, headers: init?.headers, body: undefined });

      if (method === 'GET') {
        // 权限不足 / 端点变了
        return { ok: false, status: 403, text: async () => 'forbidden', json: async () => ({}) };
      }
      return { ok: true, status: 201, text: async () => '', json: async () => ({}) };
    };

    const scm = createGithubScm({ repo: 'o/r', token: 't', fetchImpl });
    const action = await scm.upsertComment('1', MARKER, '内容');

    // 评论只是分发渠道，不是门禁结论本身 —— 拿不到旧评论就新建一条
    expect(action).toBe('created');
    expect(calls.map((c) => c.method)).toEqual(['GET', 'POST']);
  });
});

describe('CI 环境识别', () => {
  it('识别 GitHub Actions', () => {
    const context = detectCiContext({
      GITHUB_ACTIONS: 'true',
      GITHUB_REPOSITORY: 'owner/repo',
      GITHUB_EVENT_NAME: 'pull_request',
      PR_NUMBER: '42',
      GITHUB_BASE_REF: 'main',
      GITHUB_HEAD_REF: 'feature/x',
      GITHUB_SHA: 'abc123',
    });

    expect(context.provider).toBe('github');
    expect(context.repo).toBe('owner/repo');
    expect(context.mrId).toBe('42');
    expect(context.baseBranch).toBe('main');
  });

  it('识别 GitLab CI，并优先于 GitHub 变量', () => {
    const context = detectCiContext({
      GITLAB_CI: 'true',
      CI_MERGE_REQUEST_IID: '7',
      CI_PROJECT_ID: '123',
      CI_COMMIT_SHA: 'def456',
      // 两个平台的变量同时存在时（比如 GitHub 上跑 GitLab 镜像），GitLab 的 MR 变量更明确
      GITHUB_ACTIONS: 'true',
    });

    expect(context.provider).toBe('gitlab');
    expect(context.repo).toBe('123');
  });

  it('不在 CI 里时 provider=none，而不是猜一个', () => {
    expect(detectCiContext({}).provider).toBe('none');
  });

  it('缺 token 时不创建适配器，并说清缺什么', () => {
    const result = createScmFromEnv({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'o/r' });

    expect(result.scm).toBeNull();
    expect(result.reason).toContain('GITHUB_TOKEN');
  });

  it('GitLab 允许用 CI_JOB_TOKEN 兜底', () => {
    const result = createScmFromEnv({
      GITLAB_CI: 'true',
      CI_PROJECT_ID: '123',
      CI_JOB_TOKEN: 'job-token',
    });

    expect(result.scm?.provider).toBe('gitlab');
    expect(result.reason).toBe('');
  });
});
