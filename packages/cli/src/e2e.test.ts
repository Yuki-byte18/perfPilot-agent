import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAdapterRegistry } from '@yuki-byte18/adapters';
import type { AdapterId, RawArtifact, RawRunner } from '@yuki-byte18/shared';
import { createSilentLogger } from '@yuki-byte18/core';

/**
 * 端到端测试：**真实 adapter 的解析代码 + 真实文件存储 + 真实报告渲染**，
 * 只把「跑外部工具」这一步换成读 fixture。
 *
 * 放在 cli 包而不是 core 包，是因为这里才是 adapters 与 core 的合法汇合点：
 * core 不得 import 具体 adapter（硬约束 4，由 eslint 边界规则强制）。
 *
 * 它验证的是 M1 验收标准第 1/2/4/5 条：
 *   - 多来源采集合并成 Metric[]
 *   - run.json 与 report.md 真的落盘
 *   - 单个 adapter 失败时链路降级继续
 *   - 全链路零网络
 */
import { execute } from './commands/execute.js';

const LIGHTHOUSE_RESULT = {
  lighthouseVersion: '12.2.1',
  finalUrl: 'https://staging.example.com/',
  configSettings: { formFactor: 'mobile' },
  audits: {
    'largest-contentful-paint': { numericValue: 3800 },
    'cumulative-layout-shift': { numericValue: 0.18 },
    'first-contentful-paint': { numericValue: 2100 },
    'server-response-time': { numericValue: 720 },
    'total-blocking-time': { numericValue: 480 },
    'speed-index': { numericValue: 4100 },
    'total-byte-weight': { numericValue: 2_450_000 },
    'resource-summary': {
      details: {
        items: [
          { resourceType: 'script', resourceSize: 486_000, requestCount: 14 },
          { resourceType: 'stylesheet', resourceSize: 92_000, requestCount: 3 },
          { resourceType: 'image', resourceSize: 1_320_000, requestCount: 22 },
          { resourceType: 'total', resourceSize: 2_100_000, requestCount: 68 },
        ],
      },
    },
  },
};

const VITALS_REPORT = {
  url: 'https://staging.example.com/',
  metrics: {
    LCP: { value: 3100 },
    CLS: { value: 0.14 },
    // 150ms < good(200ms) → 应该被评为 good，用来验证评级与展示链路
    INP: { value: 150 },
  },
};

const BUNDLE_SCAN = {
  distDir: '/repo/dist',
  source: 'stats',
  files: [
    { path: 'assets/index.js', size: 512_000 },
    { path: 'assets/index.css', size: 84_000 },
  ],
  modules: [
    { name: './node_modules/.pnpm/lodash@4.17.21/node_modules/lodash/lodash.js', size: 71_000 },
    { name: './node_modules/legacy-widget/node_modules/lodash/lodash.js', size: 71_000 },
  ],
  packageJson: { name: 'demo-shop', sideEffects: false, dependencies: {}, devDependencies: {} },
};

/** 最小但结构完整的 HAR：主文档 + 一个脚本 + 一张超大未压缩图片 */
const HAR_FILE = {
  log: {
    version: '1.2',
    entries: [
      {
        startedDateTime: '2026-01-17T14:25:30.000Z',
        time: 120,
        request: { method: 'GET', url: 'https://staging.example.com/' },
        response: {
          status: 200,
          headers: [{ name: 'content-type', value: 'text/html' }],
          content: { size: 1_800, mimeType: 'text/html' },
          _transferSize: 2_200,
        },
        _resourceType: 'document',
      },
      {
        startedDateTime: '2026-01-17T14:25:30.120Z',
        time: 300,
        request: { method: 'GET', url: 'https://staging.example.com/assets/index.js' },
        response: {
          status: 200,
          headers: [{ name: 'content-encoding', value: 'br' }],
          content: { size: 486_000, mimeType: 'application/javascript' },
          _transferSize: 140_000,
        },
        _resourceType: 'script',
        _initiator: { type: 'parser' },
      },
      {
        startedDateTime: '2026-01-17T14:25:30.400Z',
        time: 900,
        request: { method: 'GET', url: 'https://staging.example.com/assets/hero.png' },
        response: {
          status: 200,
          headers: [],
          content: { size: 1_240_000, mimeType: 'image/png' },
          _transferSize: 1_244_000,
        },
        _resourceType: 'image',
        _initiator: { type: 'parser' },
      },
    ],
  },
};

/** 最小 trace：一个 180ms 长任务，罪魁帧落在 index.js 第 142 行的 renderList */
const TRACE_FILE = {
  traceEvents: [
    {
      name: 'RunTask',
      cat: 'devtools.timeline',
      ph: 'X',
      ts: 1_000_000,
      dur: 180_000,
      pid: 1,
      tid: 1,
      args: {},
    },
    {
      name: 'FunctionCall',
      cat: 'devtools.timeline',
      ph: 'X',
      ts: 1_010_000,
      dur: 150_000,
      pid: 1,
      tid: 1,
      args: {
        data: {
          functionName: 'renderList',
          url: 'https://staging.example.com/assets/index.js',
          lineNumber: 141,
          columnNumber: 10,
        },
      },
    },
  ],
};

function runnerOf(payload: unknown, adapter: AdapterId, kind: string): RawRunner {
  return async (ctx): Promise<RawArtifact[]> => [
    {
      adapter,
      kind,
      payload,
      collectedAt: '2026-01-17T14:25:30.000Z',
      route: ctx.route,
      device: ctx.device,
      file: null,
    },
  ];
}

interface RegistryOptions {
  lighthouse?: RawRunner | 'fail';
  vitals?: RawRunner | 'fail';
  bundle?: RawRunner | 'fail';
  har?: RawRunner | 'fail';
  trace?: RawRunner | 'fail';
  /** 明确标记为不可用的来源（探活返回 false） */
  unavailable?: AdapterId[];
}

function fixtureRegistry(options: RegistryOptions = {}) {
  const failing: RawRunner = async () => {
    throw new Error('模拟外部工具崩溃');
  };
  const pick = (value: RawRunner | 'fail' | undefined, fallback: RawRunner): RawRunner =>
    value === 'fail' ? failing : (value ?? fallback);

  const down = new Set<AdapterId>(options.unavailable ?? []);
  const probe = (id: AdapterId) => async (): Promise<boolean> => !down.has(id);

  return createAdapterRegistry({
    root: '/repo',
    runners: {
      lighthouse: pick(options.lighthouse, runnerOf(LIGHTHOUSE_RESULT, 'lighthouse', 'lighthouse-result')),
      'web-vitals': pick(options.vitals, runnerOf(VITALS_REPORT, 'web-vitals', 'web-vitals')),
      'bundle-analyzer': pick(options.bundle, runnerOf(BUNDLE_SCAN, 'bundle-analyzer', 'bundle-scan')),
      har: pick(options.har, runnerOf(HAR_FILE, 'har', 'har')),
      trace: pick(options.trace, runnerOf(TRACE_FILE, 'trace', 'trace')),
    },
    probes: {
      lighthouse: probe('lighthouse'),
      'web-vitals': probe('web-vitals'),
      'bundle-analyzer': probe('bundle-analyzer'),
      har: probe('har'),
      trace: probe('trace'),
    },
  });
}

let dir: string;
let stdout: string[];

const CONFIG = `
project:
  name: demo-shop
  root: .
target:
  url: https://staging.example.com
  routes:
    - /
  repo: https://github.com/org/demo-shop
  branch: main
baseline:
  ref: last-run
report:
  format: [markdown, json]
`;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'perfpilot-e2e-'));
  await writeFile(join(dir, '.perfpilot.yml'), CONFIG, 'utf8');
  stdout = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown): boolean => {
    stdout.push(String(chunk));
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

const output = (): string => stdout.join('');

/**
 * 跑一次 CLI。
 *
 * 默认 `apply: false`：这一组端到端测试验的是「采集 → 诊断 → 报告」这条只读链路
 * （对应 `perfpilot diagnose`）。闭环那一条走 `runOnceWithFix`，见文件末尾的 M5 用例。
 */
async function runOnce(registry = fixtureRegistry()) {
  return execute({
    cwd: dir,
    apply: false,
    bootstrap: { registry, logger: createSilentLogger() },
  });
}

const runsDir = (): string => join(dir, '.perfpilot', 'runs');

/** 读回全部 run.json。不依赖目录顺序 —— 两次 run 可能落在同一毫秒 */
async function readRuns(): Promise<Array<Record<string, unknown>>> {
  const ids = await readdir(runsDir());
  return Promise.all(
    ids.map(async (id) => JSON.parse(await readFile(join(runsDir(), id, 'run.json'), 'utf8')) as Record<string, unknown>),
  );
}

/** 首次运行没有基线，第二次有 —— 用它来区分先后，而不是靠时间戳或目录名 */
function splitByBaseline(runs: Array<Record<string, unknown>>): {
  first: Record<string, unknown>;
  second: Record<string, unknown>;
} {
  const first = runs.find((r) => r.baseline === null);
  const second = runs.find((r) => r.baseline !== null);
  if (first === undefined || second === undefined) {
    throw new Error(`无法区分两次运行：baseline 分布为 ${JSON.stringify(runs.map((r) => r.baseline))}`);
  }
  return { first, second };
}

describe('perfpilot diagnose — 端到端', () => {
  it('三个来源合并为 Metric[] 并产出报告文件（验收 1、2、5）', async () => {
    const code = await runOnce();

    expect(code).toBe(0);
    // LCP 3800ms 落在 good(2500) 与 poor(4000) 之间 → needs-improvement
    expect(output()).toContain('| 🟡 LCP');
    // INP 150ms < good(200) → good
    expect(output()).toContain('| 🟢 INP');
    expect(output()).toContain('`web-vitals`');

    expect(existsSync(runsDir())).toBe(true);

    const runIds = await readdir(runsDir());
    expect(runIds).toHaveLength(1);

    const runId = runIds[0] as string;
    const runFile = join(runsDir(), runId, 'run.json');
    const reportFile = join(runsDir(), runId, 'report.md');
    const jsonReportFile = join(runsDir(), runId, 'report.json');
    expect(existsSync(runFile)).toBe(true);
    expect(existsSync(reportFile)).toBe(true);
    expect(existsSync(jsonReportFile)).toBe(true);
    // 原始产物落盘，供 M2 下钻取证
    expect(existsSync(join(runsDir(), runId, 'artifacts', 'index.json'))).toBe(true);
    // 诊断结论单独落盘：run.json 是测量数据，diagnosis.json 是结论
    expect(existsSync(join(runsDir(), runId, 'diagnosis.json'))).toBe(true);

    const run = JSON.parse(await readFile(runFile, 'utf8')) as {
      metrics: Array<{ name: string; source: string; value: number }>;
      stages: Array<{ name: string; status: string }>;
      status: string;
      project: string;
      route: string;
      device: string;
    };

    expect(run.project).toBe('demo-shop');
    expect(run.route).toBe('/');
    expect(run.device).toBe('mobile');
    expect(run.status).toBe('success');

    const byName = Object.fromEntries(run.metrics.map((m) => [m.name, m]));
    // LCP/CLS 优先 lighthouse，INP 只能来自 web-vitals，体积来自 bundle-analyzer
    expect(byName.LCP?.source).toBe('lighthouse');
    expect(byName.CLS?.source).toBe('lighthouse');
    expect(byName.INP?.source).toBe('web-vitals');
    expect(byName.JS_SIZE?.source).toBe('bundle-analyzer');
    expect(byName.DUPLICATE_DEPS?.value).toBe(1);

    // 阶段表反映真实进度
    const stages = Object.fromEntries(run.stages.map((s) => [s.name, s.status]));
    expect(stages.collect).toBe('ok');
    expect(stages.compare).toBe('ok');
    expect(stages.report).toBe('ok');
    expect(stages.diagnose).toBe('ok');
    expect(stages.plan).toBe('ok');
    expect(stages.decide).toBe('ok');
    expect(stages.execute).toBe('skipped');
  });

  it('Markdown 报告含指标表、评级与来源追溯', async () => {
    await runOnce();
    const runIds = await readdir(runsDir());
    const md = await readFile(join(runsDir(), runIds[0] as string, 'report.md'), 'utf8');

    expect(md).toContain('# PerfPilot 性能报告 — demo-shop');
    expect(md).toContain('| 指标 | 当前 | 评级 | 分数 | 基线 | Δ | Δ% | 分数变化 | 来源 |');
    expect(md).toContain('| 🟡 LCP');
    expect(md).toContain('| 🟢 INP');
    expect(md).toContain('无基线可比');
    expect(md).toContain('## 流水线阶段');
  });

  it('第二次运行自动以上一次成功运行为基线并算出回归', async () => {
    await runOnce();

    // 第二次 LCP 变慢到 5200ms
    const slower = fixtureRegistry({
      lighthouse: runnerOf(
        {
          ...LIGHTHOUSE_RESULT,
          audits: { ...LIGHTHOUSE_RESULT.audits, 'largest-contentful-paint': { numericValue: 5200 } },
        },
        'lighthouse',
        'lighthouse-result',
      ),
    });
    await runOnce(slower);

    const runs = await readRuns();
    expect(runs).toHaveLength(2);
    const { first, second } = splitByBaseline(runs);

    const baseline = second.baseline as { runId: string };
    expect(baseline.runId).toBe(first.id);

    const deltas = second.deltas as Array<{ name: string; scoreDelta: number | null }>;
    expect(deltas.find((d) => d.name === 'LCP')?.scoreDelta).toBeLessThan(0);
    expect(output()).toContain('## ⚠️ 回归指标');
  });
});

describe('perfpilot diagnose — 降级（验收 4）', () => {
  it('单个 adapter 崩溃时其余指标照常产出，退出码仍为 0', async () => {
    const code = await runOnce(fixtureRegistry({ vitals: 'fail' }));

    expect(code).toBe(0);
    expect(output()).toContain('ADAPTER_FAILED');

    const runIds = await readdir(runsDir());
    const run = JSON.parse(
      await readFile(join(runsDir(), runIds[0] as string, 'run.json'), 'utf8'),
    ) as { status: string; metrics: Array<{ name: string }>; warnings: Array<{ code: string }> };

    expect(run.status).toBe('partial');
    expect(run.warnings.some((w) => w.code === 'ADAPTER_FAILED')).toBe(true);
    // INP 消失了，LCP 还在
    expect(run.metrics.some((m) => m.name === 'LCP')).toBe(true);
    expect(run.metrics.some((m) => m.name === 'INP')).toBe(false);
    // 报告里必须明说 INP 没采到，而不是留空让人以为正常
    expect(output()).toContain('未采集的核心指标');
  });

  it('全部 adapter 崩溃时退出码为 3，且不产出「零指标成功」记录', async () => {
    const code = await runOnce(
      fixtureRegistry({
        lighthouse: 'fail',
        vitals: 'fail',
        bundle: 'fail',
        har: 'fail',
        trace: 'fail',
      }),
    );

    expect(code).toBe(3);
    expect(output()).toContain('COLLECT_FAILED');

    const runIds = existsSync(runsDir()) ? await readdir(runsDir()) : [];
    // 目录可能已建（adapter 要往里写产物），但不能有 run.json
    for (const id of runIds) {
      expect(existsSync(join(runsDir(), id, 'run.json'))).toBe(false);
    }
  });
});

describe('perfpilot diagnose — 来源不可见性（回归）', () => {
  it('不可用的适配器必须出现在告警里，而不是被悄悄过滤掉', async () => {
    // 只让 bundle-analyzer 可用，其余四个探活返回 false
    const registry = fixtureRegistry({
      unavailable: ['lighthouse', 'web-vitals', 'har', 'trace'],
    });

    const code = await runOnce(registry);
    expect(code).toBe(0);

    const runIds = await readdir(runsDir());
    const run = JSON.parse(
      await readFile(join(runsDir(), runIds[0] as string, 'run.json'), 'utf8'),
    ) as {
      status: string;
      warnings: Array<{ adapter: string | null; code: string; severity: string }>;
      metrics: Array<{ name: string }>;
    };

    // 关键：不是「少了几项指标但一切正常」，而是明确标为不完整
    expect(run.status).toBe('partial');
    const unavailable = run.warnings.filter((w) => w.code === 'ADAPTER_UNAVAILABLE');
    expect(unavailable.map((w) => w.adapter).sort()).toEqual([
      'har',
      'lighthouse',
      'trace',
      'web-vitals',
    ]);
    expect(unavailable.every((w) => w.severity === 'degraded')).toBe(true);

    // 报告正文里也要写出来
    expect(output()).toContain('ADAPTER_UNAVAILABLE');
    expect(output()).toContain('## ⚡ 采集告警');

    // 可用的那个来源照常产出
    expect(run.metrics.some((m) => m.name === 'JS_SIZE')).toBe(true);
  });

  /**
   * 五个来源全不可用 = 一条指标都没采到。
   *
   * 这条曾经输出「共 1 条路由：1 条成功」并返回退出码 0：`ok` 当时只表示
   * "流水线没抛异常"，而采集全线失败时流水线**照常返回** —— 探活没过的
   * adapter 连"失败"都不算（见 `assertCollectionUsable` 的 attempted 口径），
   * 于是零指标的报告被汇总成"成功"。CI 上这就是把"根本没测成"读成绿灯。
   */
  it('全部来源都不可用 → 退出码 3，且不谎报成功', async () => {
    const code = await runOnce(
      fixtureRegistry({
        unavailable: ['lighthouse', 'web-vitals', 'bundle-analyzer', 'har', 'trace'],
      }),
    );

    expect(code).toBe(3);

    const text = output();
    expect(text).toContain('0 条成功');
    expect(text).toContain('一条指标都没采到');
  });
});

describe('perfpilot diagnose — 配置错误（验收 3）', () => {
  it('配置缺失时退出码为 2', async () => {
    await rm(join(dir, '.perfpilot.yml'));
    const code = await runOnce();

    expect(code).toBe(2);
    expect(output()).toContain('CONFIG_NOT_FOUND');
  });

  it('配置字段拼错时退出码为 2，并指出出错路径', async () => {
    await writeFile(
      join(dir, '.perfpilot.yml'),
      `
project:
  name: demo
target:
  url: https://staging.example.com
decision:
  thresholds:
    minGain: 5
`,
      'utf8',
    );

    const code = await runOnce();

    expect(code).toBe(2);
    expect(output()).toContain('CONFIG_INVALID');
    expect(output()).toContain('Unrecognized key');
  });

  it('YAML 语法错误时退出码为 2', async () => {
    await writeFile(join(dir, '.perfpilot.yml'), 'project: [unclosed\n', 'utf8');
    expect(await runOnce()).toBe(2);
  });

  it('--device 取值非法时退出码为 2（CLI 参数同样是外部输入）', async () => {
    const code = await execute({
      cwd: dir,
      apply: false,
      device: 'tablet',
      bootstrap: { registry: fixtureRegistry(), logger: createSilentLogger() },
    });

    expect(code).toBe(2);
    expect(output()).toContain('--device');
  });

  it('--url 覆盖配置文件而不写回', async () => {
    await execute({
      cwd: dir,
      apply: false,
      url: 'https://preview.example.com',
      bootstrap: { registry: fixtureRegistry(), logger: createSilentLogger() },
    });

    const runIds = await readdir(runsDir());
    const run = JSON.parse(
      await readFile(join(runsDir(), runIds[0] as string, 'run.json'), 'utf8'),
    ) as { url: string };

    expect(run.url).toBe('https://preview.example.com');
    // 配置文件保持原样
    expect(await readFile(join(dir, '.perfpilot.yml'), 'utf8')).toContain(
      'https://staging.example.com',
    );
  });
});
