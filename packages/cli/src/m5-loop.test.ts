import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createExecutorRegistry,
  createGitAdapter,
  createMemory,
  closeMemory,
} from '@yuki-byte18/adapters';
import {
  ExecutorOrchestrator,
  Pipeline,
  Verifier,
  createFileRunStore,
  createJsonReporter,
  createSilentLogger,
} from '@yuki-byte18/core';
import { fix } from './commands/fix.js';
import {
  SCHEMA_VERSION,
  buildMetric,
  candidateFingerprint,
  createFakeCheckRunner,
  createInMemoryMemory,
  createNullAssetProcessor,
  createNullErrorScan,
  type Candidate,
  type Decision,
  type MemoryPort,
  type Metric,
  type MetricName,
  type PerfPilotConfig,
  type RunRecord,
} from '@yuki-byte18/shared';

/**
 * M5 闭环测试 —— **在真实 git 仓库里**跑完 execute → apply → verify → keep/rollback。
 *
 * 为什么值得用真实仓库而不是替身：
 * 验收 5 的原话是「断言 `status === 'rolled_back'` **且 git 工作区干净**」。
 * 用假的 GitPort 只能断言「调用过 resetHard」，断不了「工作区真的回到了原样」——
 * 而后者才是硬约束 9（失败必须回滚）真正要求的东西。
 * `git clean -fd` 清不掉新文件、`reset --hard` 漏掉未跟踪目录这类问题，
 * 只有在真仓库上才会暴露。
 *
 * 这个测试放在 cli 包而不是 core：只有 cli 能同时看到 core 与 adapters
 * （core 不允许 import 具体 adapter，硬约束 4）。
 */

const execFileAsync = promisify(execFile);
const logger = createSilentLogger();

const RUN_ID = 'run_20260117T142530_m5loop';
const STARTED_AT = '2026-01-17T14:25:30.000Z';

const BASELINE: readonly Metric[] = [metric('LCP', 3500)];
/** 与 NO_GAIN 只差 60ms：分数变化约 −2，达不到 min_gain 5 */
const NEAR_BASELINE: readonly Metric[] = [metric('LCP', 2500)];
const IMPROVED: readonly Metric[] = [metric('LCP', 2000)];
const NO_GAIN: readonly Metric[] = [metric('LCP', 2560)];

let dir = '';

afterEach(async () => {
  if (dir !== '') await rm(dir, { recursive: true, force: true });
  dir = '';
});

function metric(name: MetricName, value: number): Metric {
  return buildMetric({
    name,
    value,
    route: '/',
    device: 'mobile',
    source: 'lighthouse',
    collectedAt: STARTED_AT,
  });
}

/** 够用的测试配置：四项检查和这里的闭环无关，因此不设 report 之外的偏好 */
function testConfig(): PerfPilotConfig {
  return {
    project: { name: 'demo', root: '.' },
    target: { url: 'https://staging.example.com', routes: ['/'], repo: '', branch: 'main' },
    baseline: { ref: 'last-run', metrics: {} },
    optimization: { auto_fix: [], manual_confirm: [], suggest_only: [] },
    decision: {
      jev: true,
      thresholds: {
        min_gain: 5,
        max_regression: 2,
        max_new_errors: 0,
        apply_score: 30,
        confirm_score: 10,
      },
      weights: { metrics: {}, risk_aversion: 1 },
    },
    report: { format: ['json'], comment_mr: false, auto_pr: false },
    collect: { timeoutMs: 120_000, runs: 1 },
    checks: {
      package_manager: 'pnpm',
      kinds: ['unit-test', 'type-check', 'lint', 'e2e'],
      scripts: {},
    },
    llm: null,
    memory: { driver: 'sqlite', url: '.perfpilot/memory.db' },
  };
}

async function git(args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], { cwd: dir, windowsHide: true });
  return stdout.trim();
}

const log = (): Promise<string> => git(['log', '--pretty=%s']);

/**
 * 建一个最小的真实仓库。
 *
 * `.gitignore` 里必须有 `.perfpilot/` —— 这不是测试的方便之举，而是**真实使用的前提**：
 * 流水线把 run 产物写在项目目录里，若不被忽略，第一次运行就会让工作区变脏，
 * 于是「工作区不干净」的保护会永久拦住所有自动改动。
 */
async function makeRepo(): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), 'perfpilot-m5-'));
  await writeFile(
    join(dir, '.gitignore'),
    ['node_modules/', '.perfpilot/', 'dist/'].join('\n'),
    'utf8',
  );
  await writeFile(
    join(dir, '.perfpilot.yml'),
    [
      'project:',
      '  name: demo',
      '  root: .',
      'target:',
      '  url: https://staging.example.com',
      '  routes:',
      '    - /',
      'report:',
      '  format:',
      '    - markdown',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    join(dir, 'tsconfig.json'),
    `${JSON.stringify({ compilerOptions: { target: 'ES2019', module: 'ESNext' } }, null, 2)}\n`,
    'utf8',
  );
  await writeFile(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: 'demo', private: true }, null, 2)}\n`,
    'utf8',
  );

  await git(['init', '-q']);
  await git(['config', 'user.email', 'test@local']);
  await git(['config', 'user.name', 'Test']);
  await git(['add', '-A']);
  await git(['commit', '-q', '-m', 'init']);
}

/** 一个真实的 A 类改动：把编译目标提到 ES2022，减少降级语法转换的体积 */
function candidate(): Candidate {
  return {
    id: 'cand_target',
    runId: RUN_ID,
    bottleneckIds: ['bn_1'],
    class: 'A',
    title: '把编译目标提升到 ES2022',
    description: '目标浏览器已支持 ES2022，去掉不必要的降级转换可减小产物体积',
    origin: 'rule',
    ruleId: 'raise-compile-target',
    promptVersion: null,
    changes: [
      {
        type: 'config',
        file: 'tsconfig.json',
        key: 'compilerOptions.target',
        before: 'ES2019',
        after: 'ES2022',
      },
    ],
    expectedGain: { JS_SIZE: 30_000 },
    confidence: 0.9,
    risk: 'low',
    effort: 'low',
    reversible: true,
    recalledFrom: [],
    bottleneckKinds: ['LEGACY_LIBRARY'],
  };
}

function decision(): Decision {
  return {
    id: 'dec_1',
    runId: RUN_ID,
    candidateId: 'cand_target',
    verdict: 'apply',
    route: 'config-editor',
    score: 42,
    utility: { expectedGain: 55, confidence: 0.9, cost: 4, risk: 2 },
    riskLevel: 'low',
    reasons: ['规则库命中，A 类且完全可逆'],
    thresholds: {
      minGain: 5,
      maxRegression: 2,
      maxNewErrors: 0,
      applyScore: 30,
      confirmScore: 10,
    },
    decidedAt: STARTED_AT,
  };
}

function runRecord(metrics: readonly Metric[] = BASELINE): RunRecord {
  return {
    schemaVersion: SCHEMA_VERSION,
    llmCostUsd: 0,
    id: RUN_ID,
    project: 'demo',
    route: '/',
    device: 'mobile',
    url: 'https://staging.example.com',
    status: 'success',
    startedAt: STARTED_AT,
    finishedAt: '2026-01-17T14:25:31.000Z',
    durationMs: 1000,
    perfpilotVersion: '0.1.0',
    stages: [],
    metrics: [...metrics],
    baseline: null,
    deltas: [],
    warnings: [],
    artifacts: [],
  };
}

interface LoopOptions {
  /** recollect 返回的「改动后」指标 */
  after: readonly Metric[];
  /** 上一轮 run 记录里的基线指标（默认 BASELINE） */
  before?: readonly Metric[];
  memory?: MemoryPort;
  /** 应用前把工作区弄脏（模拟用户手上还有未提交的改动） */
  dirty?: boolean;
  dryRun?: boolean;
}

/**
 * 装配一条只含 M5 那两段的流水线：把"上一轮 run"（候选 + 决策 + 基线指标）
 * 直接播种进存储，然后调用 `pipeline.fix`。
 *
 * 不重跑 collect/diagnose/plan/decide：这一课要验的是执行与验证，
 * 让 planner 参与进来只会让断言依赖"哪条规则恰好命中"。
 */
async function runLoop(options: LoopOptions) {
  const config = testConfig();
  const baseDir = join(dir, '.perfpilot');
  await mkdir(baseDir, { recursive: true });

  const store = createFileRunStore({ baseDir });
  const gitPort = createGitAdapter({ cwd: dir });

  await store.prepare(RUN_ID);
  await store.save(runRecord(options.before));
  await store.saveJson(RUN_ID, 'candidates.json', [candidate()]);
  await store.saveJson(RUN_ID, 'decisions.json', [decision()]);

  const readProjectFile = async (path: string): Promise<string | null> =>
    readFile(join(dir, path), 'utf8').catch(() => null);

  const executor = new ExecutorOrchestrator({
    registry: createExecutorRegistry({ assetProcessor: createNullAssetProcessor() }),
    store,
    logger,
    createContext: () => ({
      projectRoot: dir,
      readFile: readProjectFile,
      readBinary: async () => null,
      writeFile: async (path, content) => {
        await writeFile(join(dir, path), content);
      },
    }),
  });

  const verifier = new Verifier({
    config,
    checkRunner: createFakeCheckRunner(true),
    git: gitPort,
    errorScan: createNullErrorScan(),
    store,
    logger,
    memory: options.memory ?? null,
    projectRoot: dir,
  });

  const pipeline = new Pipeline({
    config,
    collectors: [],
    reporters: [createJsonReporter()],
    store,
    logger,
    version: '0.1.0',
    executor,
    verifier,
    git: gitPort,
    recollect: async () => [...options.after],
  });

  if (options.dirty === true) {
    /**
     * 用一个**不相关的新文件**把工作区弄脏，而不是改 `tsconfig.json`。
     *
     * 改后者会让候选的补丁根本生成不出来（config-editor 发现现值与预期不符就拒绝改写），
     * 于是这条用例会变成在测"执行器很谨慎"，而不是在测"脏工作区保护"。
     */
    await writeFile(join(dir, 'scratch.txt'), '用户还没提交的改动\n', 'utf8');
  }

  const outcome = await pipeline.fix({
    runId: RUN_ID,
    ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
  });

  const tsconfig = JSON.parse((await readProjectFile('tsconfig.json')) ?? '{}') as {
    compilerOptions?: { target?: string };
  };

  return { outcome, tsconfig, gitPort, store };
}

describe('M5 闭环 — 真实 git 仓库里的执行 / 验证 / 回滚', () => {
  it('指标达标 → 保留：改动提交进仓库，工作区干净', async () => {
    await makeRepo();
    const { outcome, tsconfig, gitPort } = await runLoop({ after: IMPROVED });

    expect(outcome.executions).toHaveLength(1);
    expect(outcome.executions[0]?.patch).toContain('tsconfig.json');
    expect(outcome.verifications).toHaveLength(1);
    expect(outcome.verifications[0]?.status).toBe('kept');

    // 改动真的落地了
    expect(tsconfig.compilerOptions?.target).toBe('ES2022');
    // 且被提交 —— 「保留」的语义是"进入仓库历史"，不是"留在工作区"
    expect(await log()).toContain('perfpilot: 应用优化');
    expect(await gitPort.isClean()).toBe(true);

    // 补丁留痕，报告里能指向它，人也能直接 `git apply`
    const patch = await readFile(
      join(dir, '.perfpilot', 'runs', RUN_ID, 'patches', 'cand_target.patch'),
      'utf8',
    );
    expect(patch).toContain('--- a/tsconfig.json');
    expect(patch).toContain('+    "target": "ES2022"');
  });

  it('指标没达标 → 回滚：文件回到原样，工作区干净，且留下失败记忆', async () => {
    await makeRepo();
    const memory = createInMemoryMemory();
    const { outcome, tsconfig, gitPort } = await runLoop({
      before: NEAR_BASELINE,
      after: NO_GAIN,
      memory,
    });

    expect(outcome.verifications).toHaveLength(1);
    const verification = outcome.verifications[0];
    expect(verification?.status).toBe('rolled_back');
    expect(verification?.git?.reverted).toBe(true);
    expect(verification?.gate.failedRules.join(' ')).toContain('min_gain');

    // **核心断言**：文件真的回到原样了
    expect(tsconfig.compilerOptions?.target).toBe('ES2019');
    // 未通过就不该留下提交
    expect(await log()).not.toContain('perfpilot: 应用优化');
    // 工作区干净：reset --hard + clean 之后没有任何残留
    expect(await gitPort.isClean()).toBe(true);

    // 失败原因进了记忆，下一轮 planner 会按指纹拦下同一个改法
    const failures = await memory.listFailures('demo', 10);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.failureReason).toContain('min_gain');
  });

  it('工作区不干净 → 一个补丁都不应用，只产出 patch', async () => {
    await makeRepo();
    const { outcome, tsconfig } = await runLoop({ after: IMPROVED, dirty: true });

    // 补丁照常产出（人可以直接拿去用）
    expect(outcome.executions).toHaveLength(1);
    // 但没有任何验证发生，因为改动根本没落地
    expect(outcome.verifications).toHaveLength(0);
    expect(outcome.warnings.map((w) => w.code)).toContain('WORKTREE_DIRTY');

    const verifyStage = outcome.stages.find((s) => s.name === 'verify');
    expect(verifyStage?.status).toBe('skipped');
    expect(verifyStage?.note).toContain('工作区不干净');

    // 用户那份未提交的改动原封不动
    expect(await readFile(join(dir, 'scratch.txt'), 'utf8')).toContain('用户还没提交');
    // 目标文件也没被动过
    expect(tsconfig.compilerOptions?.target).toBe('ES2019');
  });

  it('dry-run → 只产出 patch，不动工作区', async () => {
    await makeRepo();
    const { outcome, tsconfig, gitPort } = await runLoop({ after: IMPROVED, dryRun: true });

    expect(outcome.executions).toHaveLength(1);
    expect(outcome.verifications).toHaveLength(0);
    expect(outcome.stages.find((s) => s.name === 'verify')?.note).toContain('dry-run');

    expect(tsconfig.compilerOptions?.target).toBe('ES2019');
    expect(await gitPort.isClean()).toBe(true);
  });
});

/**
 * `perfpilot fix` 的真实装配路径。
 *
 * 上面那几条测的是 `pipeline.fix`；这一条把 `commands/fix.ts` → `bootstrap.ts`
 * 也串起来 —— 组合根里漏接一个端口（比如忘了把 git 传进 Pipeline），
 * 单测全绿而命令根本跑不起来，这类问题只有走一遍命令才会暴露。
 */
/**
 * 「这个临时项目没有任何采集来源」必须**显式声明**。
 *
 * 这里曾经靠"跑测试的机器上恰好没装 Lighthouse"来成立，于是装上 Lighthouse
 * 的机器（正是用户按文档操作之后的常态）会让重采集真的去拉起浏览器：
 * `fix` 从毫秒级变成秒级，用例直接超时 —— 而且报出来的是"SQLite 文件锁"这种
 * 完全不指向真因的错误。
 */
const NO_SOURCES = {
  lighthouse: async () => false,
  'web-vitals': async () => false,
  'bundle-analyzer': async () => false,
  har: async () => false,
  trace: async () => false,
};

describe('perfpilot fix — 命令装配', () => {
  it('读回上一轮 run 的候选，走完执行与验证，退出码 0', async () => {
    await makeRepo();
    const baseDir = join(dir, '.perfpilot');
    await mkdir(baseDir, { recursive: true });

    // 播种一份"上一轮的 run"
    const seed = createFileRunStore({ baseDir });
    await seed.prepare(RUN_ID);
    await seed.save(runRecord(NEAR_BASELINE));
    await seed.saveJson(RUN_ID, 'candidates.json', [candidate()]);
    await seed.saveJson(RUN_ID, 'decisions.json', [decision()]);

    const stdout: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });

    try {
      const code = await fix({
        cwd: dir,
        run: RUN_ID,
        bootstrap: {
          logger: createSilentLogger(),
          // 不在临时项目里真的跑 pnpm test
          checkRunner: createFakeCheckRunner(true),
          adapters: { probes: NO_SOURCES },
        },
      });

      expect(code).toBe(0);
      const text = stdout.join('');
      expect(text).toContain('# PerfPilot fix');
      expect(text).toContain('tsconfig.json');
    } finally {
      spy.mockRestore();
    }

    /**
     * 组合根里的重采集用的是**真实的 collector 注册表**，而这个临时项目里
     * 一个采集来源都没有（没有 Lighthouse、没有 dist、没有 vitals.json），
     * 因此重采集拿不到任何指标 → 验证必然回滚。
     *
     * 这正是期望的行为：**拿不到"改动后"的指标就不该保留改动**。
     * 顺带证明了 git 那一段是通的 —— 文件回到了原样，工作区干净。
     */
    const tsconfig = JSON.parse(await readFile(join(dir, 'tsconfig.json'), 'utf8')) as {
      compilerOptions: { target: string };
    };
    expect(tsconfig.compilerOptions.target).toBe('ES2019');

    const gitPort = createGitAdapter({ cwd: dir });
    expect(await gitPort.isClean()).toBe(true);
  });

  /**
   * 记忆闭环（M6 验收 4 的"真实"那一半）。
   *
   * 单测里验的是 `recallAndAdjust` 拿到失败记忆后会剔除候选；
   * 这里验的是**那条记忆真的落到了磁盘上**：`fix` 走真实的组合根
   * （真实 SQLite、真实 git、真实 verifier），回滚之后重新打开数据库，
   * 应当能读到这个候选的指纹与失败原因。
   *
   * 少了这一条，"记忆生效"就只是内存里的一个单元测试结论 ——
   * 而跨进程存活才是记忆存在的全部理由。
   */
  it('回滚后的失败记忆真的落到 SQLite，重新打开仍在', async () => {
    await makeRepo();
    const baseDir = join(dir, '.perfpilot');
    await mkdir(baseDir, { recursive: true });

    const seed = createFileRunStore({ baseDir });
    await seed.prepare(RUN_ID);
    await seed.save(runRecord(NEAR_BASELINE));
    await seed.saveJson(RUN_ID, 'candidates.json', [candidate()]);
    await seed.saveJson(RUN_ID, 'decisions.json', [decision()]);

    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    let code: number;
    try {
      code = await fix({
        cwd: dir,
        run: RUN_ID,
        bootstrap: {
          logger: createSilentLogger(),
          checkRunner: createFakeCheckRunner(true),
          adapters: { probes: NO_SOURCES },
        },
      });
    } finally {
      spy.mockRestore();
    }
    expect(code).toBe(0);

    // 重新打开库（相当于下一轮运行的进程）：记忆应当还在
    const memory = createMemory({ config: testConfig().memory, root: dir });
    try {
      const fingerprint = candidateFingerprint(candidate());
      expect(await memory.hasFailedFailure(fingerprint, 'demo')).toBe(true);

      const failures = await memory.listFailures('demo', 10);
      expect(failures).toHaveLength(1);
      // 失败原因必须能说清"差在哪"，否则下一轮只知道"失败过"而不知道该改什么
      expect(failures[0]?.failureReason).toContain('min_gain');
      expect(failures[0]?.bottleneckKind).toBe('LEGACY_LIBRARY');
    } finally {
      closeMemory(memory);
    }

    // 方案库同时记了一条"未成功的尝试"，带上实际收益供后续标定
    const library = createMemory({ config: testConfig().memory, root: dir });
    try {
      const recalled = await library.recallCandidates({
        project: 'demo',
        bottleneckKinds: ['LEGACY_LIBRARY'],
        techStack: 'unknown',
        limit: 10,
      });
      expect(recalled.byKind).toHaveLength(1);
      expect(recalled.byKind[0]?.succeeded).toBe(false);
      // 重采集拿不到指标 → 实际收益是 0（而不是省略这个字段）
      expect(recalled.byKind[0]?.actualGain).toBe(0);
    } finally {
      closeMemory(library);
    }
  });
});
