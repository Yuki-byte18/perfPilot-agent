import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createGitAdapter, probeLighthouse } from '@yuki-byte18/adapters';
import {
  EXIT_CODES,
  PerfPilotConfigSchema,
  parseExternal,
  parseJsonText,
  toPerfPilotError,
  type ExitCode,
  type GitPort,
  type PerfPilotConfig,
  type VerifiableCheckKind,
} from '@yuki-byte18/shared';
import { detectFacts, type PackageJsonLike, type ProjectFacts } from '../init/detect.js';
import { resolvePackageManager } from '../bootstrap.js';
import { loadConfig } from '../config-loader.js';

/**
 * `perfpilot doctor` —— 一条命令体检，每条结论都给可执行的修法。
 *
 * ## 为什么要有它
 *
 * 这个工具的使用门槛不在命令语法上，而在**环境前提**上：要是 git 仓库、
 * 工作区要干净、`.perfpilot/` 不该进版本库、测量地址得真的能打开、
 * Lighthouse 得装、LLM 的 key 得在环境里。任何一条没满足，`run` 都
 * **不会报错**，而是"安静地什么都不做"（改动不应用、指标测不到、agent 降级）。
 *
 * 真实使用中，一晚上就踩了三个：`.perfpilot/` 在加 ignore 之前被提交过（85 个
 * 文件被跟踪，工作区永远是脏的）、预览服务没起（Lighthouse 报"Chrome 拦在了
 * 错误页"）、`DEEPSEEK_API_KEY` 没设（agent 静默降级）。这三个都不是 bug，
 * 但都要靠"看日志猜"才能发现 —— 所以把它们变成一条命令的显式结论。
 *
 * ## 结构：IO 在外面做完，检查是纯函数
 *
 * `gatherFacts()` 负责所有读取（文件、git、网络、环境变量），`runChecks()`
 * 只吃这些事实、吐结论。这样"哪条会红、红的时候说什么"能真的被测试覆盖，
 * 而不是只测"它没崩"。
 */

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  id: string;
  /** 检测到了什么（一句话，带具体数字/路径） */
  detail: string;
  status: CheckStatus;
  /** 怎么修；给不出可执行建议时为 null */
  fix: string | null;
}

export interface DoctorFacts {
  nodeVersion: string;
  config: {
    path: string;
    exists: boolean;
    /** 通过 zod 校验时的配置；不合法时为 null */
    value: PerfPilotConfig | null;
    error: string | null;
  };
  git: { isRepo: boolean; clean: boolean; branch: string | null };
  gitignore: { exists: boolean; coversArtifacts: boolean };
  target: { url: string | null; status: number | null; error: string | null };
  lighthouse: boolean;
  llm: { provider: string; apiKeyEnv: string | null; apiKeyPresent: boolean };
  /** 配置里声明的检查脚本，在 package.json 里是不是真的存在 */
  checkScripts: { declared: Array<{ kind: VerifiableCheckKind; script: string }>; missing: string[] };
  ci: { path: string | null; hasPlaceholder: boolean };
  /** 起预览服务需要的信息（地址是本机的才有意义） */
  preview: { script: string | null; port: string | null };
}

export interface DoctorOptions {
  cwd: string;
  configPath?: string;
  out?: (text: string) => void;
  /** 测试注入：只替换需要控制的那些读取 */
  deps?: Partial<DoctorDeps>;
}

export interface DoctorDeps {
  nodeVersion: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  readTextFile: (path: string) => Promise<string | null>;
  readPackageJson: (cwd: string) => Promise<PackageJsonLike | null>;
  git: (cwd: string) => GitPort;
  probeLighthouse: () => Promise<boolean>;
  probeUrl: (url: string) => Promise<{ status: number | null; error: string | null }>;
  loadConfig: (input: {
    cwd: string;
    configPath?: string;
  }) => Promise<Awaited<ReturnType<typeof loadConfig>>>;
}

/** Node 22.13 起 `node:sqlite` 不再需要 `--experimental-sqlite` */
const MIN_NODE: readonly [number, number] = [22, 13];

/** 起服务要用的端口：从测量地址里读，读不到就 null */
function portOf(url: string | null): string | null {
  if (url === null) return null;
  try {
    const port = new URL(url).port;
    return port === '' ? null : port;
  } catch {
    return null;
  }
}

/**
 * 所有检查。**纯函数**：只读 `facts`，不碰任何 IO。
 *
 * 顺序是刻意的：从"最底层、修起来最便宜"到"最上层" —— Node 版本不对的话
 * 后面所有检查的结论都不可信；而 CI 文件的占位符不影响本地使用，所以放最后。
 */
export function runChecks(facts: DoctorFacts, platform: NodeJS.Platform = process.platform): CheckResult[] {
  const checks: CheckResult[] = [];

  // ── 1. Node 版本 ────────────────────────────────────────────────
  const [major = 0, minor = 0] = facts.nodeVersion.split('.').map((part) => Number(part));
  const nodeOk = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  checks.push({
    id: 'node',
    status: nodeOk ? 'ok' : 'fail',
    detail: nodeOk
      ? `Node ${facts.nodeVersion}（要求 ≥ ${MIN_NODE[0]}.${MIN_NODE[1]}）`
      : `Node ${facts.nodeVersion} 太低：记忆层用的 node:sqlite 在 ${MIN_NODE[0]}.${MIN_NODE[1]} 之前需要 --experimental-sqlite`,
    fix: nodeOk ? null : `升级 Node 到 ${MIN_NODE[0]}.${MIN_NODE[1]} 或更高（nvm install ${MIN_NODE[0]}）`,
  });

  // ── 2. 配置文件 ────────────────────────────────────────────────
  if (!facts.config.exists) {
    checks.push({
      id: 'config',
      status: 'fail',
      detail: `找不到配置文件 ${facts.config.path}`,
      fix: 'perfpilot init --url http://127.0.0.1:4173   # 自动检测项目并生成配置',
    });
  } else if (facts.config.value === null) {
    checks.push({
      id: 'config',
      status: 'fail',
      detail: `配置不合法：${facts.config.error ?? '未知错误'}`,
      fix: '按提示改配置，或 perfpilot init --force 重新生成一份',
    });
  } else {
    checks.push({
      id: 'config',
      status: 'ok',
      detail: `配置合法：${facts.config.path}（项目 ${facts.config.value.project.name}）`,
      fix: null,
    });
  }

  // ── 3. git 仓库 ────────────────────────────────────────────────
  checks.push(
    facts.git.isRepo
      ? {
          id: 'git-repo',
          status: 'ok',
          detail: `git 仓库（分支 ${facts.git.branch ?? '未知'}）`,
          fix: null,
        }
      : {
          id: 'git-repo',
          status: 'fail',
          detail: '不是 git 仓库 —— 改动一旦应用就没法回滚',
          fix: 'git init && git add -A && git commit -m "init"',
        },
  );

  // ── 4. 工作区干净 ──────────────────────────────────────────────
  checks.push(
    facts.git.clean
      ? { id: 'worktree', status: 'ok', detail: '工作区干净', fix: null }
      : {
          id: 'worktree',
          status: 'fail',
          detail:
            '工作区有未提交的改动 —— 这种情况下 run 不会应用任何补丁' +
            '（回滚是 git reset --hard，会把未提交的改动一起抹掉）',
          fix: '先提交或暂存：git add -A && git commit -m "wip"   （或 git stash）',
        },
  );

  // ── 5. 运行产物是否被忽略 ──────────────────────────────────────
  //
  // 这一条曾经是 fail（跟踪的产物会让守卫永远拒绝改动），现在守卫已经
  // 把 `.perfpilot/**` 排除在外，所以它降级成"卫生问题"：产物本来就不该进版本库。
  checks.push(
    facts.gitignore.coversArtifacts
      ? { id: 'gitignore', status: 'ok', detail: '.gitignore 已忽略 .perfpilot/', fix: null }
      : {
          id: 'gitignore',
          status: 'warn',
          detail: facts.gitignore.exists
            ? '.gitignore 里没有 .perfpilot/ —— 运行记录与基线库会被当成项目文件'
            : '没有 .gitignore，运行记录与基线库会被当成项目文件',
          fix: 'echo ".perfpilot/" >> .gitignore',
        },
  );

  // ── 6. 测量地址能不能打开（最常踩的一条）──────────────────────
  if (facts.target.url === null) {
    checks.push({
      id: 'target',
      status: 'fail',
      detail: '配置里没有 target.url，不知道该测哪里',
      fix: '在 .perfpilot.yml 里填 target.url，或用 --url 指定',
    });
  } else if (facts.target.status === null) {
    const startCommand =
      facts.preview.script === null
        ? null
        : `npm run ${facts.preview.script}${facts.preview.port === null ? '' : ` -- --port ${facts.preview.port}`}`;

    checks.push({
      id: 'target',
      status: 'fail',
      detail:
        `测量地址打不开：${facts.target.url}（${facts.target.error ?? '未知原因'}）` +
        ' —— Lighthouse 会因此报"Chrome 拦在了错误页"，LCP/CLS/TBT 全部缺失',
      fix:
        startCommand === null
          ? `先把这个地址跑起来（本地地址就用项目的 preview 脚本），再 curl ${facts.target.url} 确认返回 200`
          : `另开一个终端：${startCommand}\n      然后用 curl ${facts.target.url} 确认返回 200`,
    });
  } else {
    const ok = facts.target.status >= 200 && facts.target.status < 400;
    checks.push({
      id: 'target',
      status: ok ? 'ok' : 'fail',
      detail: `测量地址返回 HTTP ${facts.target.status}：${facts.target.url}`,
      fix: ok ? null : `这个状态码说明测的不是一个正常页面，先确认地址对不对`,
    });
  }

  // ── 7. Lighthouse ──────────────────────────────────────────────
  checks.push(
    facts.lighthouse
      ? { id: 'lighthouse', status: 'ok', detail: 'Lighthouse 可用（LCP / CLS / TBT 能测）', fix: null }
      : {
          id: 'lighthouse',
          status: 'warn',
          detail:
            'Lighthouse 不可用：LCP / CLS / TBT 会整块缺失，只剩产物体积类指标' +
            '（报告会如实写"未采集"，但门禁的判断依据会少一大半）',
          fix: 'npm i -g lighthouse   # 还需要 Chrome',
        },
  );

  // ── 8. LLM（配了却没 key 会静默降级）───────────────────────────
  if (facts.llm.provider === 'none') {
    checks.push({
      id: 'llm',
      status: 'ok',
      detail: 'LLM 未启用（provider: none）—— 零调用、零成本，只用规则库',
      fix: null,
    });
  } else if (facts.llm.apiKeyEnv === null) {
    checks.push({
      id: 'llm',
      status: 'warn',
      detail: `配了 ${facts.llm.provider} 但没写 api_key_env：SDK 会去找它自己的默认环境变量`,
      fix: '在 .perfpilot.yml 的 llm 段写 api_key_env: <你的环境变量名>',
    });
  } else if (!facts.llm.apiKeyPresent) {
    checks.push({
      id: 'llm',
      status: 'warn',
      detail: `环境变量 ${facts.llm.apiKeyEnv} 没有设置 —— LLM 会降级为纯规则库并计入告警`,
      fix:
        platform === 'win32'
          ? `$env:${facts.llm.apiKeyEnv} = "<你的 key>"   （只对当前终端有效）`
          : `export ${facts.llm.apiKeyEnv}=<你的 key>`,
    });
  } else {
    checks.push({
      id: 'llm',
      status: 'ok',
      detail: `LLM 已就绪（${facts.llm.provider}，key 来自 ${facts.llm.apiKeyEnv}）`,
      fix: null,
    });
  }

  // ── 9. 验证阶段要跑的检查脚本 ──────────────────────────────────
  checks.push(
    facts.checkScripts.missing.length === 0
      ? {
          id: 'check-scripts',
          status: 'ok',
          detail:
            facts.checkScripts.declared.length === 0
              ? '没有声明额外的检查脚本（验证阶段只比对指标）'
              : `声明的检查脚本都存在：${facts.checkScripts.declared.map((d) => d.script).join(', ')}`,
          fix: null,
        }
      : {
          id: 'check-scripts',
          status: 'warn',
          detail: `配置里声明要跑的脚本在 package.json 里不存在：${facts.checkScripts.missing.join(', ')} —— 这些检查会被跳过`,
          fix: '补上脚本，或从 .perfpilot.yml 的 checks.scripts 里去掉它',
        },
  );

  // ── 10. CI 文件里的占位符 ──────────────────────────────────────
  if (facts.ci.path !== null && facts.ci.hasPlaceholder) {
    checks.push({
      id: 'ci-placeholder',
      status: 'warn',
      detail: `${facts.ci.path} 里还有 CHANGE_ME 占位符（检出 PerfPilot 的仓库地址）`,
      fix: `把 repository 改成你的 PerfPilot 仓库地址`,
    });
  } else if (facts.ci.path !== null) {
    checks.push({ id: 'ci-placeholder', status: 'ok', detail: `CI 文件就绪：${facts.ci.path}`, fix: null });
  }

  return checks;
}

// ─────────────────────────────────────────────────────────────────────
// IO：把所有事实读出来
// ─────────────────────────────────────────────────────────────────────

async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function readPackageJson(cwd: string): Promise<PackageJsonLike | null> {
  const raw = await readTextFile(join(cwd, 'package.json'));
  if (raw === null) return null;
  try {
    return parseJsonText(raw) as PackageJsonLike;
  } catch {
    return null;
  }
}

/**
 * 只发一个 GET，把"能不能打开"变成状态码。
 *
 * 用 GET 而不是 HEAD：不少 dev/preview 服务器对 HEAD 的实现不完整，
 * 那会把"服务器其实是好的"误报成失败。
 */
async function probeUrl(url: string): Promise<{ status: number | null; error: string | null }> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'follow' });
    return { status: response.status, error: null };
  } catch (err) {
    return { status: null, error: toPerfPilotError(err).message };
  }
}

const defaultDeps: DoctorDeps = {
  nodeVersion: process.versions.node,
  platform: process.platform,
  env: process.env,
  readTextFile,
  readPackageJson,
  git: (cwd) => createGitAdapter({ cwd }),
  probeLighthouse: () => probeLighthouse(),
  probeUrl,
  loadConfig: (input) => loadConfig(input),
};

export async function gatherFacts(options: DoctorOptions, deps: DoctorDeps): Promise<DoctorFacts> {
  const { cwd } = options;
  const configPath = options.configPath ?? join(cwd, '.perfpilot.yml');

  // 配置
  let value: PerfPilotConfig | null = null;
  let configError: string | null = null;
  let configExists = (await deps.readTextFile(configPath)) !== null;

  try {
    const loaded = await deps.loadConfig({
      cwd,
      ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    });
    value = loaded.config;
    configExists = true;
  } catch (err) {
    configError = toPerfPilotError(err).message;
  }

  // git
  const gitPort = deps.git(cwd);
  let isRepo = false;
  let clean = false;
  let branch: string | null = null;
  try {
    branch = await gitPort.currentBranch();
    isRepo = true;
    clean = await gitPort.isClean();
  } catch {
    // 不是 git 仓库：三种读取都会失败，这是正常状态
  }

  // .gitignore
  const gitignoreRaw = await deps.readTextFile(join(cwd, '.gitignore'));
  const coversArtifacts = (gitignoreRaw ?? '')
    .split(/\r?\n/)
    .some((line) => line.trim() === '.perfpilot/' || line.trim() === '.perfpilot');

  // 项目事实（要用它的 preview 脚本信息 + 检查脚本存在性）
  const packageManager = await resolvePackageManager('auto', cwd);
  const packageJson = await deps.readPackageJson(cwd);
  const facts: ProjectFacts = detectFacts({
    packageJson,
    dirName: cwd.split(/[\\/]/).filter(Boolean).pop() ?? 'app',
    packageManager,
    gitRemote: null,
    gitBranch: branch,
    gitignore: gitignoreRaw,
  });

  // 测量地址
  const url = value?.target.url ?? null;
  const target = url === null ? { status: null, error: null } : await deps.probeUrl(url);

  // 检查脚本：只验"配置里显式声明的那个脚本名"在 package.json 里是否存在。
  // 没显式声明的走 check-runner 的内置约定，那是它自己的事。
  const declared: Array<{ kind: VerifiableCheckKind; script: string }> = [];
  const missing: string[] = [];
  const scripts = (packageJson?.scripts ?? {}) as Record<string, string>;
  for (const [kind, script] of Object.entries(value?.checks.scripts ?? {})) {
    if (typeof script !== 'string' || script === '') continue;
    declared.push({ kind: kind as VerifiableCheckKind, script });
    if (!(script in scripts)) missing.push(`${kind} → ${script}`);
  }

  // CI 文件
  const ciRelative = '.github/workflows/perfpilot.yml';
  const ciRaw = await deps.readTextFile(join(cwd, ciRelative));

  return {
    nodeVersion: deps.nodeVersion,
    config: { path: configPath, exists: configExists, value, error: configError },
    git: { isRepo, clean, branch },
    gitignore: { exists: gitignoreRaw !== null, coversArtifacts },
    target: { url, status: target.status, error: target.error },
    lighthouse: await deps.probeLighthouse(),
    llm: {
      provider: value?.llm?.provider ?? 'none',
      apiKeyEnv: value?.llm?.api_key_env ?? null,
      apiKeyPresent:
        value?.llm?.api_key_env === null || value?.llm?.api_key_env === undefined
          ? false
          : (deps.env[value.llm.api_key_env] ?? '') !== '',
    },
    checkScripts: { declared, missing },
    ci: { path: ciRaw === null ? null : ciRelative, hasPlaceholder: (ciRaw ?? '').includes('CHANGE_ME') },
    preview: { script: facts.previewScript, port: portOf(url) },
  };
}

// ─────────────────────────────────────────────────────────────────────
// 渲染与入口
// ─────────────────────────────────────────────────────────────────────

const MARK: Record<CheckStatus, string> = { ok: '✅', warn: '⚠️ ', fail: '❌' };

export function renderChecks(
  checks: readonly CheckResult[],
  out: (text: string) => void,
  configPath: string,
): void {
  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;

  out(`\n# PerfPilot 体检\n\n> 项目目录下的环境与配置检查 · 配置 ${configPath}\n\n`);

  for (const check of checks) {
    out(`${MARK[check.status]} ${check.detail}\n`);
    if (check.fix !== null) out(`   修：${check.fix}\n`);
  }

  const needWork = fails + warns;
  out(
    needWork === 0
      ? '\n全部通过。可以开始：`perfpilot run --url <测量地址>`\n'
      : `\n需要处理 ${needWork} 项（❌ 必须修 ${fails} / ⚠️ 建议修 ${warns}）。` +
          '按上面的"修"逐条做，然后再跑 `perfpilot run`。\n' +
          (fails > 0
            ? '❌ 的项不修的话，run 会**安静地什么都不做**（改动不应用、指标测不到、agent 降级）。\n'
            : ''),
  );
}

/**
 * 体检命令。
 *
 * 退出码：有 ❌ 返回 `CONFIG_ERROR`（环境/配置没准备好，属于这一类），
 * 只有 ⚠️ 返回 0 —— 警告项不影响使用，不该让脚本以为失败了。
 */
export async function doctor(options: DoctorOptions): Promise<ExitCode> {
  const out = options.out ?? ((text: string) => process.stdout.write(text));
  const deps: DoctorDeps = { ...defaultDeps, ...options.deps };

  try {
    const facts = await gatherFacts(options, deps);
    const checks = runChecks(facts, deps.platform);
    renderChecks(checks, out, facts.config.path);

    return checks.some((check) => check.status === 'fail') ? EXIT_CODES.CONFIG_ERROR : EXIT_CODES.OK;
  } catch (err) {
    const error = toPerfPilotError(err);
    out(`\n❌ ${error.code}: ${error.message}\n`);
    return EXIT_CODES.INTERNAL;
  }
}

/** 供测试使用：校验一份 fixture 配置（避免测试里手写 zod 细节） */
export function parseFixtureConfig(input: unknown): PerfPilotConfig {
  return parseExternal(PerfPilotConfigSchema, input, { what: 'fixture 配置' });
}
