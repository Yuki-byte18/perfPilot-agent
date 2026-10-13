import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  createAdapterRegistry,
  createCheckRunnerAdapter,
  createExecutorRegistry,
  createGitAdapter,
  createMemory,
  createScmFromEnv,
  createSharpAssetProcessor,
  createSourceMapAdapter,
  closeMemory,
  loadSharp,
  repoSlugOf,
  type AdapterRegistryOptions,
  type CiContext,
  type FetchLike,
} from '@yuki-byte18/adapters';
import {
  VERIFIABLE_CHECK_KINDS,
  type VerifiableCheckKind,
} from '@yuki-byte18/shared';
import {
  CORE_VERSION,
  DecisionEngine,
  Diagnoser,
  ExecutorOrchestrator,
  Pipeline,
  Planner,
  Verifier,
  createFileRunStore,
  createLlmGateway,
  createPinoLogger,
  createReporters,
  collect,
} from '@yuki-byte18/core';
import {
  createInMemoryMemory,
  createNullErrorScan,
  createNullGit,
  LlmConfigSchema,
  type AdapterRegistry,
  type CheckRunnerPort,
  type CollectorPort,
  type ErrorScanPort,
  type ExecutionContext,
  type ExecutorRegistry,
  type GitPort,
  type LogLevel,
  type LoggerPort,
  type MemoryPort,
  type PerfPilotConfig,
  type ReporterPort,
  type ChecksConfig,
  type LlmPort,
  type RunStorePort,
  type ScmPort,
  type SourceMapPort,
} from '@yuki-byte18/shared';
import { loadConfig, type LoadedConfig } from './config-loader.js';

export interface BootstrapOptions {
  cwd: string;
  configPath?: string;
  logLevel?: LogLevel;
  /** 覆盖配置里的目标 URL（CLI `--url`） */
  url?: string;
  /** 覆盖配置里的路由（CLI `--routes`） */
  routes?: string[];
  /** 覆盖配置里的基线 ref（CLI `--baseline`） */
  baselineRef?: string;
  /**
   * 注入 adapter 实现。测试用它把三个 adapter 全部换成 fixture runner，
   * 于是 `perfpilot diagnose` 的整条链路可以在零网络、零浏览器下被端到端验证。
   */
  adapters?: AdapterRegistryOptions;
  /** 注入注册表（测试用，优先级高于 adapters 选项） */
  registry?: AdapterRegistry;
  /** 注入 logger（测试用，避免测试输出混进 pino 日志） */
  logger?: LoggerPort;
  /** 注入 source map 解析（测试用，避免依赖真实 .map 文件） */
  sourceMap?: SourceMapPort | null;
  /** 关闭诊断阶段（只想采集一次数据时） */
  diagnose?: boolean;
  /** 关闭方案生成阶段（想先看看诊断结论时） */
  plan?: boolean;
  /** 关闭决策阶段 */
  decide?: boolean;
  /** 注入 LLM 端口（测试用 mock） */
  llm?: LlmPort;
  /** 注入记忆层；M6 之前用内存实现 */
  memory?: MemoryPort | null;
  /** 注入 git 端口（测试用，避免依赖真实仓库） */
  git?: GitPort | null;
  /** 注入检查运行器（测试用，避免真的跑 pnpm test） */
  checkRunner?: CheckRunnerPort;
  /** 注入执行器注册表（测试用） */
  executorRegistry?: ExecutorRegistry;
  /** 注入错误扫描端口 */
  errorScan?: ErrorScanPort;
  /** 注入 SCM 端口（测试用，避免真的去调平台 API） */
  scm?: ScmPort | null;
  /** 注入 CI 上下文（配合 `scm` 使用） */
  ci?: CiContext;
  /** 注入 fetch（测试用，断言请求体长什么样） */
  fetchImpl?: FetchLike;
  /**
   * 报告服务地址，用于生成 MR 评论里的"完整报告"链接。
   * 不传时评论里只写本地路径。
   */
  reportUrl?: string;
  /**
   * 是否启用「改动 + 验证 + 回滚」这一段（M5）。
   *
   * 默认 `true`：`perfpilot run` 就是完整闭环。`diagnose` 命令走 false，
   * 因为它承诺「不修改任何代码」。
   */
  apply?: boolean;
  /** 资产改动是否真的写盘。默认 false：只评估、不动用户的工作区 */
  writeAssets?: boolean;
  /** 允许在工作区不干净时改动 */
  allowDirtyWorktree?: boolean;
  /** 覆盖默认的四项检查（例如某个项目没有 E2E） */
  checkKinds?: readonly VerifiableCheckKind[];
}

/**
 * CLI 上下文。
 *
 * **这是整个项目唯一的组合根**（硬约束 3/4）：
 * 在这里把 adapters 的具体实现 new 出来，注入给只认识 `CollectorPort` 的 core。
 * core 自己永远看不到 lighthouse / sharp / git 的存在，
 * 因此它的测试不需要网络、不需要浏览器、不需要真实仓库。
 */
export interface CliContext {
  config: PerfPilotConfig;
  configPath: string;
  root: string;
  logger: LoggerPort;
  registry: AdapterRegistry;
  collectors: CollectorPort[];
  reporters: ReporterPort[];
  store: RunStorePort;
  sourceMap: SourceMapPort | null;
  diagnoser: Diagnoser | null;
  llm: LlmPort;
  planner: Planner | null;
  decider: DecisionEngine | null;
  /** M5：执行编排（产出 patch） */
  executor: ExecutorOrchestrator | null;
  /** M5：验证器（保留 / 回滚） */
  verifier: Verifier | null;
  /** M5：回滚要用它；没有仓库时为 null */
  git: GitPort | null;
  /** M6 之前用内存实现 */
  memory: MemoryPort | null;
  /**
   * 代码托管平台端口。没接上时为 null —— 此时 MR 评论会落盘但不发布，
   * 并且会明确告诉用户"为什么没发出去"。
   */
  scm: ScmPort | null;
  /** 从 CI 环境变量里读出来的上下文（provider / MR 编号 / 分支） */
  ci: CiContext;
  pipeline: Pipeline;
  version: string;
  /**
   * 释放组合根打开的资源（目前只有 SQLite 连接）。
   *
   * **必须调用。** SQLite 会持有 `.perfpilot/memory.db` 的文件句柄，
   * 不关掉的话进程退出前这个文件一直被锁着 —— 在 Windows 上表现为
   * 删不掉临时目录（`EBUSY: resource busy or locked`），在 CI 里表现为
   * "清理步骤偶发失败"，而错误信息完全不指向真正的原因。
   *
   * 反复调用是安全的：命令层用 `finally` 调它，宿主也可能再调一次。
   */
  dispose: () => void;
}

export async function bootstrap(options: BootstrapOptions): Promise<CliContext> {
  const loaded: LoadedConfig = await loadConfig({
    cwd: options.cwd,
    ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
  });

  const config = applyOverrides(loaded.config, options);
  const logger = options.logger ?? createPinoLogger({ level: options.logLevel ?? 'info' });

  // 存储目录先建好：adapter 采集时要往里写原始产物
  const baseDir = join(loaded.root, '.perfpilot');
  await mkdir(baseDir, { recursive: true });

  const registry =
    options.registry ??
    createAdapterRegistry({
      root: loaded.root,
      distDir: join(loaded.root, 'dist'),
      ...options.adapters,
    });

  /**
   * **传全部适配器，不做预过滤。**
   *
   * 探活在 `core/collector` 里做，那里会为每个不可用的来源记一条 degraded 告警，
   * 报告里因此会明确写出「lighthouse 不可用，LCP 未采集」。
   *
   * 如果在这里用 `registry.available()` 先滤掉，collector 永远看不到它们，
   * 那条告警路径就成了死代码 —— 用户只会看到指标少了几项、状态还是 success，
   * 于是把「没测」读成「没问题」。这正是这个项目最需要避免的失效模式。
   */
  const collectors = registry.all();
  const reporters = createReporters(config.report.format);
  const store = createFileRunStore({ baseDir });

  /**
   * Source Map 解析器。
   *
   * 它是**服务**不是采集器：只在诊断把压缩位置还原到源码时才被调用，
   * 调用次数取决于命中多少条规则。放进注册表会让采集阶段白读一堆 map。
   */
  const sourceMap =
    options.sourceMap !== undefined
      ? options.sourceMap
      : createSourceMapAdapter({
          root: loaded.root,
          // trace/HAR 给的是部署 URL（`assets/index.js`），而 .map 通常躺在
          // 构建产物目录里（`dist/assets/index.js.map`）—— 两个根都要试
          searchRoots: [loaded.root, join(loaded.root, 'dist')],
        });

  /**
   * LLM 网关。
   *
   * `createLlmGateway` 在 `provider: none`（默认）时返回空实现，
   * 在 SDK 未安装 / key 未配置时降级为空实现并记 warning ——
   * 两种情况诊断与方案生成都照常走规则库。
   *
   * **放在 diagnoser / planner 之前**：诊断 agent 与方案生成共用这一个网关，
   * 也因此共享同一份累计成本预算（预算散在两个实例上就等于没有预算）。
   */
  const llm =
    options.llm ??
    createLlmGateway({
      // config.llm 为 null（默认）= 不接 LLM；用 schema 的默认值构造等价配置，
      // 而不是手写一个字面量 —— 手写的那份在 schema 加字段时会静默漏掉
      config: config.llm ?? LlmConfigSchema.parse({}),
      logger,
    });

  const diagnoser =
    options.diagnose === false
      ? null
      : new Diagnoser({
          config,
          sourceMap,
          logger,
          llm,
        });

  /**
   * 记忆层。
   *
   * M5 起它承担失败记忆的写入，planner 的召回也要读它。M6 起**默认落 SQLite**
   * （`.perfpilot/memory.db`）—— 记忆的全部价值在于跨 run 累积，
   * 用内存实现等于每轮都从零开始，"这个改法上次失败过"永远不会生效。
   *
   * `options.memory` 仍然可以注入（测试、或明确不想留下痕迹的场景）。
   */
  const memory: MemoryPort =
    options.memory === undefined
      ? createMemory({ config: config.memory, root: loaded.root })
      : options.memory === null
        ? createInMemoryMemory()
        : options.memory;

  const planner =
    options.plan === false
      ? null
      : new Planner({
          config,
          llm,
          memory,
          logger,
        });

  const decider = options.decide === false ? null : new DecisionEngine({ config, logger });

  /**
   * SCM 接入。
   *
   * 从环境变量自动识别 GitHub Actions / GitLab CI。识别不到时返回 null，
   * **不假装接了平台** —— 调用方据此输出"评论已写入文件但未发布"，
   * 而不是静默什么都不做然后让人以为发出去了。
   *
   * `options.scm` 是测试注入点（避免真去打平台 API）。
   */
  const detected =
    options.scm !== undefined
      ? { scm: options.scm, context: options.ci ?? NO_CI_CONTEXT, reason: '' }
      : createScmFromEnv(process.env, options.fetchImpl, {
          // 不在 CI 里时（或 CI 环境变量不全时）用配置里的仓库信息兜底：
          // 本地想试 auto_pr / comment_mr 时不必伪造一堆环境变量
          ...(config.target.repo !== '' ? { repo: repoSlugOf(config.target.repo) } : {}),
          ...(config.target.branch !== '' ? { baseBranch: config.target.branch } : {}),
        });
  const scm = detected.scm;
  const ci = detected.context;

  if (options.scm === undefined && ci.provider !== 'none') {
    logger.debug('检测到 CI 环境', {
      provider: ci.provider,
      mrId: ci.mrId,
      event: ci.eventName,
      scm: scm !== null,
      reason: detected.reason,
    });
  }

  /**
   * M5：执行 / 验证 / 回滚的装配。
   *
   * 默认 `apply: true` —— `perfpilot run` 的语义就是「完整闭环」。
   * `diagnose` 命令显式传 `apply: false`，因为它对用户的承诺是「不修改代码」。
   *
   * git 负责回滚、checkRunner 负责跑检查、recollect 负责拿到「改动后」的指标、
   * assetProcessor 负责二进制。硬约束 8/9 要求「改了必须验证、失败必须回滚」，
   * 所以其中任何一个拿不到时，流水线会拒绝应用改动 —— 只出补丁，不动工作区。
   */
  const apply = options.apply ?? true;

  /**
   * 可选依赖缺了，得有人知道。
   *
   * sharp 装不上时图片类候选会在执行阶段被跳过（原因写进执行摘要），
   * 但那要等跑到那一步、且工程里真有大图才看得见 —— 用户看到的现象
   * 是"我的图怎么没被优化"，而不是"少装了一个包"。启动时说一句就够了。
   *
   * 只在会真的应用改动的路径上提示（且用自建注册表时）：
   * `history`、`diagnose`、`init` 不需要为此多一行噪音。
   */
  if (options.executorRegistry === undefined && apply && (await loadSharp()) === null) {
    logger.warn('未检测到可选依赖 sharp，图片类优化候选会被跳过', {
      hint: '需要图片优化时安装：pnpm add -D sharp',
    });
  }

  const git =
    options.git !== undefined ? options.git : apply ? createGitAdapter({ cwd: loaded.root }) : null;

  const executorRegistry =
    options.executorRegistry ??
    createExecutorRegistry({
      assetProcessor: createSharpAssetProcessor(),
      /**
       * 资产改动默认写盘（M5 时为 false，核实回滚能覆盖之后打开）。
       *
       * 为什么现在敢打开：
       * 1. 回滚是 `git reset --hard <baseRef>` + `git clean -fd` ——
       *    覆盖"改了已有文件"与"新增了文件"两种情况，真仓库上验过。
       * 2. 只有 `apply` 裁决的候选能拿到 `writeFile`（见 core/executor），
       *    B 类候选只评估不写盘，不会留下没人管的文件。
       * 3. 原地压缩（文件名不变）重新采集**测得到真实收益**，
       *    因此它能真正走完"应用 → 验证 → 保留/回滚"。
       *
       * 反过来，如果这里仍是 false，`OVERSIZED_IMAGE` 这类候选永远只会
       * 产出"能省 220KB"的评估、进不了验证闭环 —— 一个能自动做的事被关着。
       */
      writeAssets: options.writeAssets ?? true,
    });

  const executor = new ExecutorOrchestrator({
    registry: executorRegistry,
    store,
    logger,
    createContext: () => createExecutionContext(loaded.root),
  });

  const verifier = apply
    ? new Verifier({
        config,
        checkRunner:
          options.checkRunner ??
          createCheckRunnerAdapter({
            packageManager: await resolvePackageManager(
              config.checks.package_manager,
              loaded.root,
            ),
            scripts: toScriptOverrides(config.checks.scripts),
          }),
        // apply 时 git 一定存在（上面刚创建）；这里的兜底只为让类型收敛
        git: git ?? createNullGit(),
        errorScan: options.errorScan ?? createNullErrorScan(),
        store,
        logger,
        memory,
        projectRoot: loaded.root,
        checkKinds: options.checkKinds ?? config.checks.kinds,
      })
    : null;

  const pipeline = new Pipeline({
    config,
    collectors,
    reporters,
    store,
    logger,
    version: CORE_VERSION,
    diagnoser,
    planner,
    decider,
    executor,
    verifier,
    git,
    // 画像与诊断历史由流水线写；失败记忆与方案库由 verifier 写（各自最清楚的部分）
    memory,
    ...(options.allowDirtyWorktree !== undefined
      ? { allowDirtyWorktree: options.allowDirtyWorktree }
      : {}),
    // diagnose 只跑到报告：显式声明实现到哪一段，比"少传端口"更能说明意图
    ...(apply ? {} : { implementedStages: STAGES_WITHOUT_MUTATION }),
    recollect: async ({ runId, route, device }) => {
      // 重采集写进独立目录：覆盖 run 目录里的原始产物会让「改动前」的证据变成「改动后」的
      const dir = join(baseDir, 'runs', runId, 'recollect');
      await mkdir(dir, { recursive: true });
      const again = await collect({
        collectors,
        logger,
        thresholds: config.baseline.metrics,
        outputDir: dir,
        url: config.target.url,
        route,
        device,
        timeoutMs: config.collect.timeoutMs,
        // 重采集只跑一轮：它的用途是"改动后比一次"，多轮只会让验证慢 N 倍，
        // 而降噪的价值在这里有限——门禁判的是差值是否超过阈值，不是精确排名
        runs: 1,
      });
      return again.metrics;
    },
  });

  logger.debug('组合根装配完成', {
    configPath: loaded.path,
    root: loaded.root,
    adapters: collectors.map((c) => c.id),
    reporters: reporters.map((r) => r.format),
    apply,
  });

  return {
    config,
    configPath: loaded.path,
    root: loaded.root,
    logger,
    registry,
    collectors,
    reporters,
    store,
    sourceMap,
    diagnoser,
    llm,
    planner,
    decider,
    executor,
    verifier,
    git,
    memory,
    scm,
    ci,
    pipeline,
    version: CORE_VERSION,
    dispose: () => closeMemory(memory),
  };
}
/**
 * 判断用哪个包管理器跑检查脚本。
 *
 * 检查是靠 `<包管理器> run <script>` 跑的，而项目用哪个包管理器**不是**我们能选的：
 * 拿 pnpm 去跑一个 npm 项目，在没装 pnpm 的机器上会直接失败 —— 而失败会被记成
 * 「检查未通过」，于是整轮优化被回滚，报出来的理由是"单测没过"，
 * 与真正的原因（包管理器不对）毫无关系。
 *
 * 因此默认 `auto`：按 lockfile 判断；显式配置优先。
 * 顺序即优先级 —— monorepo 里常见多个 lockfile 并存，以 pnpm 为先。
 * 都认不出来时回落到 pnpm（本仓库自己的默认）。
 */
export async function resolvePackageManager(
  configured: ChecksConfig['package_manager'],
  root: string,
): Promise<'pnpm' | 'npm' | 'yarn' | 'bun'> {
  if (configured !== 'auto') return configured;

  const candidates = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['bun.lockb', 'bun'],
    ['bun.lock', 'bun'],
    ['package-lock.json', 'npm'],
  ] as const;

  for (const [file, pm] of candidates) {
    if (await exists(join(root, file))) return pm;
  }
  return 'pnpm';
}

/**
 * 把配置里的脚本覆盖表收敛成适配器要的形状。
 *
 * 逐个键复制而不是直接传对象：配置里没写的键在 zod 下是 `undefined`，
 * 而 `exactOptionalPropertyTypes` 不允许把 `undefined` 当成"存在但为空"。
 */
function toScriptOverrides(
  scripts: ChecksConfig['scripts'],
): Partial<Record<VerifiableCheckKind, string | null>> {
  const overrides: Partial<Record<VerifiableCheckKind, string | null>> = {};
  for (const kind of VERIFIABLE_CHECK_KINDS) {
    const script = scripts[kind];
    if (script !== undefined) overrides[kind] = script;
  }
  return overrides;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * `diagnose` 的实现阶段：止步于报告。
 *
 * 显式列出来而不是「少传几个端口」：阶段表是报告里给用户看的进度，
 * 写成「execute 阶段 skipped，原因：本次是 diagnose」比
 * 「execute 阶段 skipped，原因：未注入执行编排」诚实得多 ——
 * 后者会让人以为是配置缺了东西。
 */
const STAGES_WITHOUT_MUTATION = [
  'collect',
  'compare',
  'diagnose',
  'plan',
  'decide',
  'report',
] as const;

/** 不在 CI 里时的空上下文：所有字段为 null，调用方据此跳过发布 */
const NO_CI_CONTEXT: CiContext = {
  provider: 'none',
  mrId: null,
  baseBranch: null,
  headBranch: null,
  commitSha: null,
  repo: null,
  serverUrl: null,
  eventName: null,
};

/**
 * 执行上下文。
 *
 * 文件读写在这里实现，而不是让执行器直接用 fs：
 * `core/executor` 里的编排不碰文件系统，执行器只通过注入的
 * `readFile` / `readBinary` / `writeFile` 访问文件 ——
 * 单测因此可以注入内存实现（见 `ExecutionContext` 的说明）。
 *
 * 相对路径一律以**项目根**为基准解析：改动描述里的 `src/App.tsx`
 * 是相对仓库根的，不是相对进程当前目录。`resolve` 因此不能省。
 */
function createExecutionContext(root: string): ExecutionContext {
  const resolve = (path: string): string => (isAbsolute(path) ? path : join(root, path));

  return {
    projectRoot: root,
    readFile: async (path) => {
      try {
        return await readFile(resolve(path), 'utf8');
      } catch {
        return null;
      }
    },
    readBinary: async (path) => {
      try {
        return new Uint8Array(await readFile(resolve(path)));
      } catch {
        return null;
      }
    },
    writeFile: async (path, content) => {
      await writeFile(resolve(path), content);
    },
  };
}

/**
 * CLI 参数覆盖配置文件。
 *
 * 覆盖只作用于**本次运行**，不写回配置文件 ——
 * CI 里用 `--url` 指向预览环境是常见需求，但那不该改变仓库里的基准配置。
 */
export function applyOverrides(
  config: PerfPilotConfig,
  options: Pick<BootstrapOptions, 'url' | 'routes' | 'baselineRef'>,
): PerfPilotConfig {
  const routes = options.routes?.filter((r) => r.trim() !== '');

  return {
    ...config,
    target: {
      ...config.target,
      ...(options.url !== undefined ? { url: options.url } : {}),
      ...(routes !== undefined && routes.length > 0 ? { routes } : {}),
    },
    baseline: {
      ...config.baseline,
      ...(options.baselineRef !== undefined ? { ref: options.baselineRef } : {}),
    },
  };
}
