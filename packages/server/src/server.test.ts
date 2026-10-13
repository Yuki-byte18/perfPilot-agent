import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createFileRunStore, createSilentLogger } from '@yuki-byte18/core';
import { SCHEMA_VERSION, buildMetric, type Metric, type RunRecord } from '@yuki-byte18/shared';
import { createReportServer, type ReportServer } from './index.js';

/**
 * 报告服务（M7 最小 API）。
 *
 * 端点少，但每一条都有一种"看起来对、实际错"的坏法：
 * 路径穿越、不存在的 run、没采集到指标的空 run。
 * 这些都必须返回**正确的状态码**，而不是 500 —— 上游脚本要靠状态码
 * 区分"报告不存在"和"服务挂了"。
 */

const RUN_ID = 'run_20260117T142530_serve01';

let dir = '';
let server: ReportServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
  if (dir !== '') await rm(dir, { recursive: true, force: true });
  dir = '';
});

/** 自带一份最简 run 记录：server 包不去 import core 的内部 fixtures */
function lcp(value: number): Metric {
  return buildMetric({
    name: 'LCP',
    value,
    route: '/',
    device: 'mobile',
    source: 'lighthouse',
    collectedAt: '2026-01-17T14:25:30.000Z',
  });
}

function sampleRun(metrics: Metric[] = [lcp(2800)]): RunRecord {
  return {
    schemaVersion: SCHEMA_VERSION,
    // 未接 LLM 的一轮：成本记 0（字段是必填的，schema 默认给 0）
    llmCostUsd: 0,
    id: RUN_ID,
    project: 'demo',
    route: '/',
    device: 'mobile',
    url: 'https://staging.example.com',
    status: 'success',
    startedAt: '2026-01-17T14:25:30.000Z',
    finishedAt: '2026-01-17T14:25:31.000Z',
    durationMs: 1000,
    perfpilotVersion: '0.1.0',
    stages: [],
    metrics,
    baseline: null,
    deltas: [],
    warnings: [],
    artifacts: [],
  };
}

async function start(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'perfpilot-serve-'));
  const baseDir = join(dir, '.perfpilot');
  const store = createFileRunStore({ baseDir });

  await store.prepare(RUN_ID);
  await store.save(sampleRun());
  await store.saveJson(RUN_ID, 'candidates.json', []);
  await store.saveJson(RUN_ID, 'decisions.json', []);

  server = await createReportServer({ baseDir, port: 0, logger: createSilentLogger() });
  return server.url;
}

/** 递归列出目录下的所有文件，用于断言"服务什么都没写" */
async function listFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else found.push(full.slice(root.length));
    }
  };
  await walk(root);
  return found.sort();
}

describe('M7 — 报告服务端点', () => {
  it('GET /healthz 返回 ok', async () => {
    const url = await start();
    const response = await fetch(`${url}/healthz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it('GET /api/runs 列出运行记录', async () => {
    const url = await start();
    const body = (await (await fetch(`${url}/api/runs`)).json()) as { runs: Array<{ id: string }> };

    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]?.id).toBe(RUN_ID);
  });

  it('GET /api/runs/:id 返回完整一份数据（报告页最关心的那个）', async () => {
    const url = await start();
    const response = await fetch(`${url}/api/runs/${RUN_ID}`);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body['run']).toBeDefined();
    // 这几项即使为空也必须是数组：报告页会直接 .map()，null 会当场炸
    expect(body['candidates']).toEqual([]);
    expect(body['decisions']).toEqual([]);
    expect(body['executions']).toEqual([]);
    expect(body['verifications']).toEqual([]);
    expect(body['diagnosis']).toBeNull();
  });

  it('GET /api/runs/:id/report 返回可渲染的 Markdown', async () => {
    const url = await start();
    const response = await fetch(`${url}/api/runs/${RUN_ID}/report`);
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/markdown');
    expect(text).toContain('# PerfPilot 性能报告');
  });

  it('不存在的 run → 404，而不是 500', async () => {
    const url = await start();
    const response = await fetch(`${url}/api/runs/run_20990101T000000_nope00`);

    expect(response.status).toBe(404);
    expect((await response.json()) as Record<string, unknown>).toMatchObject({
      error: 'not_found',
    });
  });

  it('路径穿越被挡在 400（runId 是外部输入）', async () => {
    const url = await start();
    // `isSafeId` 会拒绝带分隔符的 id，因此它连文件路径都进不去
    const response = await fetch(`${url}/api/runs/${encodeURIComponent('../../etc/passwd')}`);

    expect(response.status).toBe(400);
  });

  it('非 GET 方法 → 405：这个服务是只读的', async () => {
    const url = await start();
    expect((await fetch(`${url}/api/runs`, { method: 'POST' })).status).toBe(405);
  });

  it('未知路径 → 404', async () => {
    const url = await start();
    expect((await fetch(`${url}/nope`)).status).toBe(404);
  });
});

describe('M7 — 服务是只读的', () => {
  it('读过一轮之后，磁盘上的文件一个都没变', async () => {
    /**
     * 这条不是在测代码，是在**锁住设计约束**：服务端一旦能触发运行或写入，
     * 它就同时成了新的攻击面，以及新的"为什么 CI 里跑了两遍"的来源。
     */
    const url = await start();
    const baseDir = join(dir, '.perfpilot');
    const before = await listFiles(baseDir);

    await fetch(`${url}/api/runs`);
    await fetch(`${url}/api/runs/${RUN_ID}`);
    await fetch(`${url}/api/runs/${RUN_ID}/report`);
    await fetch(`${url}/healthz`);

    expect(await listFiles(baseDir)).toEqual(before);
  });
});

describe('M8 — 跨 run 指标趋势', () => {
  it('GET /api/metrics 返回按时间升序的序列', async () => {
    dir = await mkdtemp(join(tmpdir(), 'perfpilot-serve-'));
    const baseDir = join(dir, '.perfpilot');
    const store = createFileRunStore({ baseDir });

    // 两次 run，LCP 从 3500 改善到 2000
    const runs: Array<[string, string, number]> = [
      ['run_20260117T100000_aaaaaa', '2026-01-17T10:00:00.000Z', 3500],
      ['run_20260118T100000_bbbbbb', '2026-01-18T10:00:00.000Z', 2000],
    ];
    for (const [id, startedAt, value] of runs) {
      await store.prepare(id);
      await store.save({ ...sampleRun([lcp(value)]), id, startedAt });
    }

    server = await createReportServer({ baseDir, port: 0, logger: createSilentLogger() });
    const body = (await (await fetch(`${server.url}/api/metrics`)).json()) as {
      series: Array<{ name: string; change: number | null; points: unknown[] }>;
    };

    expect(body.series).toHaveLength(1);
    expect(body.series[0]?.name).toBe('LCP');
    expect(body.series[0]?.points).toHaveLength(2);
    // 3500 → 2000：变化量是 -1500
    expect(body.series[0]?.change).toBe(-1500);
  });

  it('limit 是外部输入，会被夹到合理区间', async () => {
    const url = await start();
    // 一个 limit=100000 会让我们把所有历史读进内存再排序
    expect((await fetch(`${url}/api/metrics?limit=100000`)).status).toBe(200);
  });

  it('route / device 过滤生效', async () => {
    const url = await start();
    const body = (await (
      await fetch(`${url}/api/metrics?route=${encodeURIComponent('/nonexistent')}`)
    ).json()) as { series: unknown[] };

    expect(body.series).toEqual([]);
  });
});

describe('M8 — 报告页托管', () => {
  /** 造一份最小的前端产物：只需要 index.html + 一个资源文件 */
  async function makeDist(): Promise<string> {
    const webDir = join(dir, 'web-dist');
    await mkdir(join(webDir, 'assets'), { recursive: true });
    await writeFile(join(webDir, 'index.html'), '<div id="root"></div>\n', 'utf8');
    await writeFile(join(webDir, 'assets', 'app.js'), 'console.log(1)\n', 'utf8');
    return webDir;
  }

  it('根路径返回报告页，资源带正确的 content-type', async () => {
    dir = await mkdtemp(join(tmpdir(), 'perfpilot-serve-'));
    const baseDir = join(dir, '.perfpilot');
    await mkdir(baseDir, { recursive: true });
    const webDir = await makeDist();

    server = await createReportServer({ baseDir, webDir, port: 0, logger: createSilentLogger() });

    const index = await fetch(`${server.url}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toContain('text/html');
    expect(await index.text()).toContain('id="root"');

    const asset = await fetch(`${server.url}/assets/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('text/javascript');
  });

  it('未知路径回落到 index.html（客户端路由刷新不该 404）', async () => {
    dir = await mkdtemp(join(tmpdir(), 'perfpilot-serve-'));
    const baseDir = join(dir, '.perfpilot');
    await mkdir(baseDir, { recursive: true });
    const webDir = await makeDist();

    server = await createReportServer({ baseDir, webDir, port: 0, logger: createSilentLogger() });

    const response = await fetch(`${server.url}/report/run_1`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('id="root"');
  });

  it('API 路径打错时返回 JSON 404，而不是回落到 HTML', async () => {
    dir = await mkdtemp(join(tmpdir(), 'perfpilot-serve-'));
    const baseDir = join(dir, '.perfpilot');
    await mkdir(baseDir, { recursive: true });
    const webDir = await makeDist();

    server = await createReportServer({ baseDir, webDir, port: 0, logger: createSilentLogger() });

    const response = await fetch(`${server.url}/api/nope`);
    // 回落到 HTML 的话，调用方 JSON.parse 报的错跟真正的原因（路径写错）毫无关系
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
  });

  it('路径穿越拿不到 webDir 之外的文件', async () => {
    dir = await mkdtemp(join(tmpdir(), 'perfpilot-serve-'));
    const baseDir = join(dir, '.perfpilot');
    await mkdir(baseDir, { recursive: true });
    const webDir = await makeDist();
    // 放在 webDir 外面的一个"秘密"文件
    await writeFile(join(dir, 'secret.txt'), 'TOP SECRET\n', 'utf8');

    server = await createReportServer({ baseDir, webDir, port: 0, logger: createSilentLogger() });

    const response = await fetch(`${server.url}/${encodeURIComponent('../secret.txt')}`);
    expect(await response.text()).not.toContain('TOP SECRET');
  });

  it('没构建前端时给出可操作的提示，而不是裸 404', async () => {
    const url = await start(); // 不传 webDir

    const response = await fetch(`${url}/`);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('web build');
  });
});

describe('M8 — 可选访问令牌', () => {
  it('没设令牌时全放行（默认只监听本机，本地看报告不该再要一次密码）', async () => {
    const url = await start();
    expect((await fetch(`${url}/api/runs`)).status).toBe(200);
  });

  it('设了令牌后：不带凭据 → 401，并带 WWW-Authenticate', async () => {
    dir = await mkdtemp(join(tmpdir(), 'perfpilot-serve-'));
    const baseDir = join(dir, '.perfpilot');
    await mkdir(baseDir, { recursive: true });

    server = await createReportServer({
      baseDir,
      port: 0,
      token: 's3cret',
      logger: createSilentLogger(),
    });

    const response = await fetch(`${server.url}/api/runs`);
    expect(response.status).toBe(401);
    // 告诉调用方"这需要凭据"，而不是让它以为是 404
    expect(response.headers.get('www-authenticate')).toContain('Bearer');
  });

  it('Authorization: Bearer 通过', async () => {
    dir = await mkdtemp(join(tmpdir(), 'perfpilot-serve-'));
    const baseDir = join(dir, '.perfpilot');
    await mkdir(baseDir, { recursive: true });

    server = await createReportServer({ baseDir, port: 0, token: 's3cret', logger: createSilentLogger() });

    const response = await fetch(`${server.url}/api/runs`, {
      headers: { authorization: 'Bearer s3cret' },
    });
    expect(response.status).toBe(200);
  });

  it('?token= 也能通过（浏览器要打开页面就得有这条路）', async () => {
    dir = await mkdtemp(join(tmpdir(), 'perfpilot-serve-'));
    const baseDir = join(dir, '.perfpilot');
    await mkdir(baseDir, { recursive: true });

    server = await createReportServer({ baseDir, port: 0, token: 's3cret', logger: createSilentLogger() });

    expect((await fetch(`${server.url}/api/runs?token=s3cret`)).status).toBe(200);
  });

  it('令牌错误 → 401（而不是 500 或者放行）', async () => {
    dir = await mkdtemp(join(tmpdir(), 'perfpilot-serve-'));
    const baseDir = join(dir, '.perfpilot');
    await mkdir(baseDir, { recursive: true });

    server = await createReportServer({ baseDir, port: 0, token: 's3cret', logger: createSilentLogger() });

    expect(
      (await fetch(`${server.url}/api/runs`, { headers: { authorization: 'Bearer wrong' } })).status,
    ).toBe(401);
    // 长度不同也要挡住（常数时间比较在长度不等时直接返回 false）
    expect(
      (await fetch(`${server.url}/api/runs`, { headers: { authorization: 'Bearer s3cret-longer' } }))
        .status,
    ).toBe(401);
  });

  it('健康检查同样受保护（不给未授权者探测的机会）', async () => {
    dir = await mkdtemp(join(tmpdir(), 'perfpilot-serve-'));
    const baseDir = join(dir, '.perfpilot');
    await mkdir(baseDir, { recursive: true });

    server = await createReportServer({ baseDir, port: 0, token: 's3cret', logger: createSilentLogger() });

    expect((await fetch(`${server.url}/healthz`)).status).toBe(401);
  });
});
