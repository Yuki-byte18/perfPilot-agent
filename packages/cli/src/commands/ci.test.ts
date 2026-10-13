import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAdapterRegistry } from '@yuki-byte18/adapters';
import type { ScmPort } from '@yuki-byte18/shared';
import { createSilentLogger } from '@yuki-byte18/core';
import { execute } from './execute.js';

/**
 * `run --ci` 与发布链路（M7 验收 1/3）。
 *
 * 走的是**真实的 `execute`**：bootstrap → 流水线 → 门禁 → 发布。
 * 只把采集器与 SCM 换成替身 —— 前者避免依赖网络与浏览器，
 * 后者避免真的去 GitHub 上建一个 PR。
 */

let dir = '';
let stdout: string[] = [];
/**
 * 恢复 stdout 的函数。
 *
 * 不写成 `ReturnType<typeof vi.spyOn>` 那样的类型标注：`process.stdout.write`
 * 是重载函数，spy 的类型参数在这种写法下推不出可用的形态。存一个恢复函数
 * 反而更简单，也不依赖 vitest 的类型细节。
 */
let restoreStdout: (() => void) | null = null;

afterEach(async () => {
  restoreStdout?.();
  restoreStdout = null;
  if (dir !== '') await rm(dir, { recursive: true, force: true });
  dir = '';
  stdout = [];
});

async function makeProject(options: { url?: string } = {}): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), 'perfpilot-ci-'));
  await writeFile(
    join(dir, '.perfpilot.yml'),
    [
      'project:',
      '  name: demo',
      'target:',
      '  url: https://staging.example.com',
      '  routes:',
      '    - /',
      'baseline:',
      '  ref: last-run',
      'report:',
      '  format:',
      '    - markdown',
      `  comment_mr: ${options.url === undefined ? 'false' : 'true'}`,
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(join(dir, 'package.json'), '{"name":"demo","private":true}\n', 'utf8');

  const capture = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  restoreStdout = () => capture.mockRestore();
}

/** 记录调用的 SCM 替身。`existingMarker` 用来模拟"MR 上已经有旧评论" */
function recordingScm(options: { existingMarker?: boolean } = {}): ScmPort & {
  comments: Array<{ mrId: string; body: string }>;
  updates: Array<{ mrId: string; body: string }>;
} {
  const comments: Array<{ mrId: string; body: string }> = [];
  const updates: Array<{ mrId: string; body: string }> = [];

  return {
    provider: 'github',
    comments,
    updates,
    async commentOnMr(mrId, body) {
      comments.push({ mrId, body });
    },
    async upsertComment(mrId, marker, body) {
      // 模拟平台的"找旧评论"：找到了就更新，找不到才新建
      if (options.existingMarker === true) {
        void marker;
        updates.push({ mrId, body });
        return 'updated';
      }
      comments.push({ mrId, body });
      return 'created';
    },
    async createPullRequest() {
      return 'https://github.com/o/r/pull/1';
    },
    async setCommitStatus() {
      /* no-op */
    },
  };
}

const CI_CONTEXT = {
  provider: 'github' as const,
  mrId: '42',
  baseBranch: 'main',
  headBranch: 'feature/x',
  commitSha: 'abc123',
  repo: 'o/r',
  serverUrl: 'https://github.com',
  eventName: 'pull_request',
};

interface RunOptions {
  /** 观测到的 LCP 值；连续两次调用用不同的值来制造"改善/回归" */
  samples?: number[];
  ci?: boolean;
  scm?: ScmPort | null;
}

/**
 * 用**真实的 adapter 注册表**，只把"跑 Lighthouse"换成读 fixture。
 *
 * 与 e2e.test.ts 同一套做法：手搓一个 CollectorPort 看起来更简单，
 * 但它绕过了真实解析链路（fixture → parse → Metric），
 * 于是测试全绿而 CLI 其实是坏的 —— 这个坑在本仓库已经踩过一次。
 */
async function run(options: RunOptions = {}) {
  const samples = options.samples ?? [3500];
  let call = 0;

  const registry = createAdapterRegistry({
    root: dir,
    runners: {
      lighthouse: async (ctx) => {
        const value = samples[Math.min(call, samples.length - 1)] ?? 3500;
        call += 1;
        return [
          {
            adapter: 'lighthouse',
            kind: 'lighthouse-result',
            payload: {
              lighthouseVersion: '12.2.1',
              finalUrl: 'https://staging.example.com/',
              configSettings: { formFactor: 'mobile' },
              audits: { 'largest-contentful-paint': { numericValue: value } },
            },
            collectedAt: '2026-01-17T14:25:30.000Z',
            route: ctx.route,
            device: ctx.device,
            file: null,
          },
        ];
      },
    },
    probes: {
      // 其他来源一律不可用：这一组只关心门禁，多来源只会引入噪音
      lighthouse: async () => true,
      'web-vitals': async () => false,
      'bundle-analyzer': async () => false,
      har: async () => false,
      trace: async () => false,
    },
  });

  const code = await execute({
    cwd: dir,
    apply: false,
    ci: options.ci ?? true,
    bootstrap: {
      logger: createSilentLogger(),
      registry,
      // CI 用例不碰改动与回滚：那一段已经在 M5 验过了
      apply: false,
      memory: null,
      scm: options.scm ?? null,
      ci: CI_CONTEXT,
      reportUrl: 'https://reports.example.com/run',
    },
  });

  return code;
}

describe('M7 验收 1 — run --ci 的退出码', () => {
  it('首次运行（无基线）→ 0：没有可比数据，就没有"回归"这回事', async () => {
    await makeProject();
    expect(await run({ samples: [3500] })).toBe(0);
  });

  it('出现回归 → 1，并在输出里说清门禁为什么没过', async () => {
    await makeProject();
    // 第一次 2000ms（好）成为基线，第二次 3500ms（差）→ 回归
    expect(await run({ samples: [2000] })).toBe(0);
    expect(await run({ samples: [3500] })).toBe(1);

    const text = stdout.join('');
    expect(text).toContain('门禁未通过');
    expect(text).toContain('regression');
  });

  it('未传 --ci 时同样的回归返回 0（本地跑不该被门禁挂掉）', async () => {
    await makeProject();
    await run({ samples: [2000] });
    expect(await run({ samples: [3500], ci: false })).toBe(0);
  });

  it('门禁结论落盘成 gate.json（可复现性靠它，而不是靠重看报告）', async () => {
    await makeProject();
    await run({ samples: [2000] });
    await run({ samples: [3500] });

    const runsDir = join(dir, '.perfpilot', 'runs');
    const { readdir } = await import('node:fs/promises');
    const ids = await readdir(runsDir);

    const gates = await Promise.all(
      ids.map(async (id) => {
        const text = await readFile(join(runsDir, id, 'gate.json'), 'utf8').catch(() => null);
        return text === null ? null : (JSON.parse(text) as { passed: boolean; checks: unknown[] });
      }),
    );

    const parsed = gates.filter((g): g is { passed: boolean; checks: unknown[] } => g !== null);
    expect(parsed).toHaveLength(2);
    // 一次通过、一次不通过，且结构一致（同一个纯函数算出来的）
    expect(parsed.map((g) => g.passed).sort()).toEqual([false, true]);
    expect(parsed[0]?.checks.length).toBe(parsed[1]?.checks.length);
  });
});

describe('M7 验收 3 — MR 评论', () => {
  it('comment_mr=true 且有 SCM 时发布结构化评论', async () => {
    await makeProject({ url: 'x' });
    const scm = recordingScm();

    await run({ samples: [2000], scm });

    expect(scm.comments).toHaveLength(1);
    expect(scm.comments[0]?.mrId).toBe('42');

    const body = scm.comments[0]?.body ?? '';
    expect(body).toContain('PerfPilot 性能门禁'); // 指标表在标题下面
    expect(body).toContain('LCP');
    expect(body).toContain('<!-- perfpilot-report -->'); // 去重标记
  });

  it('未接入 SCM 时评论仍落盘，并说明为什么没发出去', async () => {
    await makeProject({ url: 'x' });

    await run({ samples: [2000], scm: null });

    const runsDir = join(dir, '.perfpilot', 'runs');
    const { readdir } = await import('node:fs/promises');
    const ids = await readdir(runsDir);
    const comment = await readFile(join(runsDir, ids[0] as string, 'mr-comment.md'), 'utf8');

    expect(comment).toContain('<!-- perfpilot-report -->');
    expect(stdout.join('')).toContain('未接入 SCM');
  });

  it('发评论失败不会把门禁判成不通过', async () => {
    await makeProject({ url: 'x' });
    const failing: ScmPort = {
      provider: 'github',
      async commentOnMr() {
        throw new Error('Bad credentials');
      },
      async upsertComment() {
        throw new Error('Bad credentials');
      },
      async createPullRequest() {
        return '';
      },
      async setCommitStatus() {
        /* no-op */
      },
    };

    // 无基线 → 门禁本来就该过；评论失败不该改变这个结论
    const code = await run({ samples: [3500], scm: failing });

    expect(code).toBe(0);
    expect(stdout.join('')).toContain('MR 评论发布失败');
  });
});
