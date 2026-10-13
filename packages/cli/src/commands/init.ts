import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { createGitAdapter } from '@yuki-byte18/adapters';
import {
  EXIT_CODES,
  PerfPilotConfigSchema,
  parseExternal,
  parseJsonText,
  toPerfPilotError,
  type ExitCode,
} from '@yuki-byte18/shared';
import { resolvePackageManager } from '../bootstrap.js';
import { DEFAULT_CONFIG_FILES } from '../config-loader.js';
import {
  detectFacts,
  isLikelyDevServer,
  isLocalUrl,
  type PackageJsonLike,
  type ProjectFacts,
} from '../init/detect.js';
import {
  PERFPILOT_CHECKOUT_DIR,
  buildCiPlan,
  detectCiPlatform,
  type CiDelivery,
  type CiPlan,
  type CiPlatform,
} from '../init/ci.js';
import {
  LLM_PRESETS,
  envHintCommand,
  presetOf,
  sdkInstallCommand,
  type LlmChoice,
} from '../init/llm.js';
import {
  gitignorePatch,
  missingGitignoreEntries,
  renderConfig,
  type GitignoreEntry,
} from '../init/render.js';

export interface InitOptions {
  cwd: string;
  /** 显式指定配置文件路径 */
  configPath?: string;
  /** 测量地址；给了就不再交互询问 */
  url?: string;
  /** 逗号分隔的路由列表 */
  routes?: string;
  /**
   * LLM 服务商：`none` | `deepseek` | `openai` | `anthropic`。
   *
   * 不传时：交互模式下会问，非交互模式下按 `none`（**付费能力绝不默认开启**）。
   */
  llm?: string;
  /**
   * 生成 CI 集成文件：`auto` | `github` | `gitlab` | `none`。
   *
   * 不传时：能检测到平台就生成（GitHub 写新文件、GitLab 写 `ci/perfpilot.yml`），
   * 检测不到就什么都不做并提示怎么显式指定。`none` 明确表示不要。
   */
  ci?: string;
  /** 非交互：全部用检测值与建议值，不问任何问题 */
  yes?: boolean;
  /** 覆盖已存在的配置 */
  force?: boolean;
  /** 测试注入：交互式提问 */
  ask?: (question: string) => Promise<string>;
  /** 测试注入：输出 */
  out?: (text: string) => void;
}

/**
 * `perfpilot init` —— 生成 `.perfpilot.yml`。
 *
 * ## 为什么要有这个命令
 *
 * 手写配置最难的地方不是语法，而是十几项**本来就能从项目里问出来**的信息：
 * 包管理器、已有的检查脚本、git 远端与当前分支。让用户抄一遍这些，
 * 既容易写错（`typecheck` 还是 `type-check`），又会因为写错而让整条链路
 * **静默**失效 —— 检查脚本名不对会被记成"跳过"，于是验证阶段形同虚设。
 *
 * ## 交互的边界
 *
 * 只问**问不出来**的那一项：`target.url`。
 * 本机 dev 地址、预发地址、线上地址都是合法选择，而它们测出来的数字含义
 * 完全不同（dev server 发的是未打包源码）。这一项必须由人回答，
 * 因此这里会把"别指向 dev server"直接写在提问里。
 *
 * 没有 TTY（CI、管道）或传了 `--yes` 时不提问：用建议值 + TODO 注释，
 * 绝不因为"没人回答"而卡住。
 */
export async function init(options: InitOptions): Promise<ExitCode> {
  const out = options.out ?? ((text: string): void => void process.stdout.write(text));

  try {
    const target = resolveConfigTarget(options);

    if ((await fileExists(target)) && options.force !== true) {
      out(
        `\n⚠️  配置已存在：${target}\n\n` +
          '   覆盖它会丢掉你手写的字段。要覆盖请加 `--force`。\n' +
          '   只想改某一项的话，直接编辑那个文件更快。\n',
      );
      return EXIT_CODES.CONFIG_ERROR;
    }

    const facts = await gatherFacts(options.cwd);
    const interactive = isInteractive(options);
    const ask = options.ask ?? defaultAsk();

    const url = await resolveUrl(options, facts, out, interactive, ask);
    if (url === null) return EXIT_CODES.CONFIG_ERROR;

    const llm = await resolveLlm(options, interactive, ask, out);
    if (llm === null) return EXIT_CODES.CONFIG_ERROR;

    const routes = resolveRoutes(options);
    const content = renderConfig({
      facts,
      url,
      routes,
      generatedAt: new Date().toISOString().slice(0, 19).replace('T', ' '),
      ...(llm.choice === undefined ? {} : { llm: llm.choice }),
    });

    /**
     * **写之前先自己校验一遍。**
     *
     * 生成的配置过不了 zod 的话，用户拿到的是一个"启动就报错"的文件，
     * 而错误信息指向的是他的项目 —— 排查方向完全错了。
     * 这里失败只有一个原因：渲染逻辑有 bug，必须当场暴露。
     */
    try {
      parseExternal(PerfPilotConfigSchema, parseYamlLoose(content), { what: '生成的配置' });
    } catch (err) {
      out(
        `\n❌ INTERNAL: 生成的配置没通过校验（这是 PerfPilot 的 bug，不是你的项目问题）\n` +
          `   ${toPerfPilotError(err).message}\n`,
      );
      return EXIT_CODES.INTERNAL;
    }

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');

    out(`\n✅ 已生成配置：${target}\n`);
    printFacts(facts, url, out);

    out(await ensureGitignored(options.cwd, facts, [MEMORY_IGNORE], out));

    if (llm.choice !== undefined) out(llmHints(llm.choice, llm.presetName ?? ''));
    else if (interactive) out(llmNotEnabledHint());

    // ── CI 集成文件 ────────────────────────────────────────────────
    const ciPlan = await resolveCiPlan({ options, facts, cwd: options.cwd, url, interactive, ask, out });
    if (ciPlan !== null) {
      out(await writeCiFile(options.cwd, ciPlan, options.force === true));

      /**
       * CI 模板把 PerfPilot 源码检出到 `tools/perfpilot`，而**那个目录就在被测仓库里**。
       * 不忽略它：`git status` 永远是脏的 → 改动守卫永远拒绝应用补丁 →
       * 报告里写"工作区不干净"，指向的却是用户自己的改动。
       *
       * 只在真的生成了 CI 文件、且是 checkout 形态时才补这一行：
       * 不给不用 CI 的项目塞一条它看不懂的规则。
       */
      if (detectDelivery() === 'checkout') {
        out(await ensureGitignored(options.cwd, facts, [TOOLS_IGNORE], out));
      }
    }

    printNextSteps(url, out);
    return EXIT_CODES.OK;
  } catch (err) {
    const error = toPerfPilotError(err);
    out(`\n❌ ${error.code}: ${error.message}\n`);
    return EXIT_CODES.CONFIG_ERROR;
  }
}

// ─────────────────────────────────────────────────────────────────────
// 检测
// ─────────────────────────────────────────────────────────────────────

/**
 * 收集项目事实。
 *
 * git 相关的一切都走 `GitPort`（硬约束 5：CLI 不认识 `git` 可执行文件），
 * 并且**都不是必须成功**：不是 git 仓库、没有 origin 都是正常状态，
 * 只影响生成文件里那两行注释。
 */
async function gatherFacts(cwd: string): Promise<ProjectFacts> {
  const packageJson = await readPackageJson(cwd);
  const packageManager = await resolvePackageManager('auto', cwd);
  const gitignore = await readTextFile(join(cwd, '.gitignore'));

  let gitRemote: string | null = null;
  let gitBranch: string | null = null;
  try {
    const git = createGitAdapter({ cwd });
    gitRemote = await git.remoteUrl();
    gitBranch = await git.currentBranch();
  } catch {
    // 不是 git 仓库 / 没装 git：正常状态，留空即可
  }

  return detectFacts({
    packageJson,
    dirName: basename(resolve(cwd)),
    packageManager,
    gitRemote,
    gitBranch,
    gitignore,
  });
}

async function readPackageJson(cwd: string): Promise<PackageJsonLike | null> {
  const text = await readTextFile(join(cwd, 'package.json'));
  if (text === null) return null;

  try {
    // 必须走 parseJsonText（它会先剥 BOM）：Windows 上 PowerShell / 记事本 /
    // 不少 CI 脚本写出的 package.json 都带 BOM，而 JSON.parse 会直接抛错 ——
    // 表现成"检测不到任何依赖"，于是建议不出地址、也识别不出技术栈
    const parsed = parseJsonText(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as PackageJsonLike) : null;
  } catch {
    // package.json 都解析不了的话，后面的检查脚本检测也就无从谈起
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────
// 交互
// ─────────────────────────────────────────────────────────────────────

/**
 * 会不会提问：只有"有 TTY 且没要求非交互"时才问。
 *
 * 一个在 CI 里卡住等输入的 `init` 是最糟的体验，所以判定要保守。
 * 注入了 `ask`（测试）时视为可交互 —— 那时本来就没有真实 TTY。
 */
function isInteractive(options: InitOptions): boolean {
  if (options.yes === true) return false;
  if (options.ask !== undefined) return true;
  return process.stdin.isTTY === true;
}

/**
 * 定下测量地址。优先级：`--url` > 交互询问 > 检测到的建议值 > 报错让用户给。
 */
async function resolveUrl(
  options: InitOptions,
  facts: ProjectFacts,
  out: (text: string) => void,
  interactive: boolean,
  ask: (question: string) => Promise<string>,
): Promise<string | null> {
  if (options.url !== undefined && options.url !== '') return normalizeUrl(options.url);

  if (interactive) {
    const suggested = facts.suggestedUrl;
    const hint =
      suggested === null
        ? '例如 https://staging.example.com/'
        : `${suggested}   # ${facts.suggestedUrlReason ?? ''}`;

    out(
      '\n测哪个地址？（建议指向**预览/预发环境**，不要指向 dev server：\n' +
        'dev server 发的是未打包源码，测出的 LCP 与传输体积没有意义）\n',
    );

    const answer = (await ask(`  url [${hint}]: `)).trim();
    if (answer !== '') return normalizeUrl(answer);
    if (suggested !== null) return suggested;
  }

  if (facts.suggestedUrl !== null) {
    out(`\nℹ️  未提供 --url，使用建议值：${facts.suggestedUrl}（${facts.suggestedUrlReason ?? ''}）\n`);
    return facts.suggestedUrl;
  }

  out(
    '\n❌ 无法确定测量地址：这个项目里没找到可推断的构建工具。\n' +
      '   请显式指定，例如：perfpilot init --url http://127.0.0.1:4173/\n',
  );
  return null;
}

// ─────────────────────────────────────────────────────────────────────
// LLM
// ─────────────────────────────────────────────────────────────────────

interface LlmResolution {
  /** undefined 表示不接（provider: none） */
  choice: LlmChoice | undefined;
  presetName: string | null;
}

/**
 * 定下 LLM 选项。优先级：`--llm` > 交互询问 > 不接。
 *
 * **交互里问的是"从哪个环境变量读 key"，绝不问 key 本身。** 这个文件会进 git，
 * 把密钥写进去等于写进历史 —— 一次误提交就得轮换。
 *
 * 非交互（`--yes` / CI）时一律不接：付费能力不该被"没人回答"顺手打开。
 */
async function resolveLlm(
  options: InitOptions,
  interactive: boolean,
  ask: (question: string) => Promise<string>,
  out: (text: string) => void,
): Promise<LlmResolution | null> {
  if (options.llm !== undefined && options.llm !== '') {
    if (options.llm === 'none') return { choice: undefined, presetName: null };

    const preset = presetOf(options.llm);
    if (preset === null) {
      out(
        `\n❌ 不认识的 --llm 值：${options.llm}\n` +
          `   可选：none、${LLM_PRESETS.map((p) => p.name).join('、')}\n`,
      );
      return null;
    }
    return { choice: preset.choice, presetName: preset.name };
  }

  if (!interactive) return { choice: undefined, presetName: null };

  out(
    '\n要接 LLM 吗？\n' +
      '  接了之后：诊断 agent 会读原始证据做归因复核与补充，方案生成也不只依赖规则库。\n' +
      '  代价：每轮会产生 API 调用（上限由 maxCostUsd 控制），并且要装一个可选依赖。\n' +
      '  ⚠️ key 不会写进配置文件（这个文件会进 git）—— 只记环境变量的名字。\n',
  );

  const wanted = (await ask('  接 LLM？[y/N]: ')).trim().toLowerCase();
  if (wanted !== 'y' && wanted !== 'yes') return { choice: undefined, presetName: null };

  out(`\n  可选服务商：${LLM_PRESETS.map((p) => `${p.name}（${p.label}）`).join('、')}\n`);
  const providerAnswer = (await ask('  provider [deepseek]: ')).trim();
  const preset = presetOf(providerAnswer === '' ? 'deepseek' : providerAnswer);
  if (preset === null) {
    out(`\n⚠️  不认识的服务商「${providerAnswer}」，按 deepseek 处理。\n`);
  }
  const chosen = preset ?? LLM_PRESETS[0];
  if (chosen === undefined) return { choice: undefined, presetName: null };

  const baseUrlAnswer = (
    await ask(`  base_url [${chosen.choice.baseUrl ?? '（用 SDK 默认）'}]: `)
  ).trim();
  const modelAnswer = (await ask(`  model [${chosen.choice.model}]: `)).trim();
  const envAnswer = (await ask(`  读 key 的环境变量名 [${chosen.choice.apiKeyEnv}]: `)).trim();

  return {
    choice: {
      ...chosen.choice,
      baseUrl: baseUrlAnswer === '' ? chosen.choice.baseUrl : baseUrlAnswer,
      model: modelAnswer === '' ? chosen.choice.model : modelAnswer,
      apiKeyEnv: envAnswer === '' ? chosen.choice.apiKeyEnv : envAnswer,
    },
    presetName: chosen.name,
  };
}

/** 接上 LLM 之后必须告诉用户的两件事：装依赖、设 key */
function llmHints(choice: LlmChoice, presetName: string): string {
  const preset = presetOf(presetName);
  const hasKey = (process.env[choice.apiKeyEnv] ?? '') !== '';

  return (
    '\n已写入 LLM 配置。跑之前还需要两步：\n' +
    `  1. 装可选依赖：${sdkInstallCommand(preset?.sdkPackages ?? '@ai-sdk/openai')}\n` +
    `  2. 设 key：${envHintCommand(choice.apiKeyEnv)}\n` +
    (hasKey
      ? ''
      : `     ⚠️ 当前环境里读不到 ${choice.apiKeyEnv} —— 没设的话 LLM 会静默降级为空实现\n`)
  );
}

function llmNotEnabledHint(): string {
  return (
    '\nℹ️  LLM 保持关闭（provider: none，一次调用都不会发生）。\n' +
      '   想接的话：perfpilot init --force --llm deepseek\n'
  );
}

function defaultAsk(): (question: string) => Promise<string> {
  return async (question: string): Promise<string> => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  };
}

function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  // 只给了域名时补上协议：`staging.example.com` 这种写法太常见了
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function resolveRoutes(options: InitOptions): string[] {
  const parsed = options.routes
    ?.split(',')
    .map((route) => route.trim())
    .filter((route) => route !== '');

  return parsed !== undefined && parsed.length > 0 ? parsed : ['/'];
}

// ─────────────────────────────────────────────────────────────────────
// CI 集成文件
// ─────────────────────────────────────────────────────────────────────

/** CLI 的包名：生成的流水线用它（`npx perfpilot` 来自这个包） */
const CLI_PACKAGE = '@yuki-byte18/cli';

/**
 * 定下 CI 平台并生成流水线内容。
 *
 * 平台推断的顺序：显式 `--ci` > 目录痕迹（`.github/` / `.gitlab-ci.yml`）>
 * 远端地址（gitlab.com / github.com）。**推断不出来就不生成** ——
 * 放错平台的流水线文件比没有更糟：它不会报错，只是永远不跑。
 */
async function resolveCiPlan(input: {
  options: InitOptions;
  facts: ProjectFacts;
  cwd: string;
  url: string;
  interactive: boolean;
  ask: (question: string) => Promise<string>;
  out: (text: string) => void;
}): Promise<CiPlan | null> {
  const { options, facts, out } = input;
  const explicit = options.ci;

  if (explicit === 'none') return null;

  const detected = detectCiPlatform({
    hasGithubDir: await pathExists(join(input.cwd, '.github')),
    hasGitlabCi: await pathExists(join(input.cwd, '.gitlab-ci.yml')),
    gitRemote: facts.repo === '' ? null : facts.repo,
  });

  let platform: CiPlatform = detected;

  if (explicit !== undefined && explicit !== '' && explicit !== 'auto') {
    if (explicit !== 'github' && explicit !== 'gitlab') {
      out(`\n⚠️  不认识的 --ci 值：${explicit}（可选 auto / github / gitlab / none），本次不生成\n`);
      return null;
    }
    platform = explicit;
  } else if (input.interactive) {
    if (detected === 'none') {
      const answer = (
        await input.ask('  生成 CI 门禁文件吗？平台（github / gitlab / 跳过）[跳过]: ')
      )
        .trim()
        .toLowerCase();
      if (answer !== 'github' && answer !== 'gitlab') return null;
      platform = answer;
    } else {
      const label = detected === 'github' ? 'GitHub Actions' : 'GitLab CI';
      const answer = (
        await input.ask(
          `  生成 ${label} 的性能门禁流水线？之后 PR 就会自动跑一轮\n    [Y/n]: `,
        )
      )
        .trim()
        .toLowerCase();
      if (answer === 'n' || answer === 'no') return null;
    }
  }

  if (platform === 'none') {
    out(
      '\nℹ️  没能判断你用的是 GitHub 还是 GitLab（既没有 .github/ 也没有 .gitlab-ci.yml）。\n' +
        '   要生成 CI 文件，显式指定即可：perfpilot init --ci github（或 --ci gitlab）\n',
    );
    return null;
  }

  const preview = previewOf(input.url, facts.previewScript);
  if (preview === null && isLocalUrl(input.url)) {
    // 这条必须说：CI 里没人起服务的话，采集会以"页面打不开"告终，
    // 而报告里只会写"数据源不可用"
    out(
      `\n⚠️  测量地址是本机的 ${input.url}，但这个项目里没找到 preview / dev 脚本 ——\n` +
        '   生成的流水线没法自己把服务起起来。要么补一个 `preview` 脚本，\n' +
        '   要么把地址改成预发环境。\n',
    );
  }

  return buildCiPlan({
    platform,
    delivery: detectDelivery(),
    packageManager: facts.packageManager,
    url: input.url,
    preview,
    perfpilotRepo: null,
    cliPackage: CLI_PACKAGE,
  });
}

/** 测量地址是本机时，CI 需要自己起服务：给出脚本名与端口 */
function previewOf(url: string, script: string | null): { script: string; port: string } | null {
  if (script === null || !isLocalUrl(url)) return null;

  try {
    const parsed = new URL(url);
    // 没写端口就是 80/443，那种情况不需要 --port
    return parsed.port === '' ? null : { script, port: parsed.port };
  } catch {
    return null;
  }
}

/**
 * 这份 CLI 是"从 npm 装出来的"还是"仓库里跑起来的"。
 *
 * 生成的流水线要与之匹配：装出来的用 `npx perfpilot`，
 * 仓库里的得先检出并构建 PerfPilot 源码。判据是 CLI 自身路径里有没有
 * `node_modules` —— 简单、且不依赖用户回答。
 */
function detectDelivery(): CiDelivery {
  const here = fileURLToPath(import.meta.url);
  return here.split(/[\\/]/).includes('node_modules') ? 'package' : 'checkout';
}

async function writeCiFile(cwd: string, plan: CiPlan, force: boolean): Promise<string> {
  const path = join(cwd, plan.path);

  // 已存在就不动：这可能是用户自己改过的流水线
  if ((await fileExists(path)) && !force) {
    return `\n⚠️  CI 文件已存在，未覆盖：${plan.path}（要覆盖加 --force）\n`;
  }

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, plan.content, 'utf8');

  return (
    `\n✅ 已生成 CI 文件：${plan.path}\n\n   ${plan.instruction.replace(/\n/g, '\n   ')}\n` +
    (plan.prerequisite === null ? '' : `\n   ⚠️ 还需要：${plan.prerequisite}\n`)
  );
}

// ─────────────────────────────────────────────────────────────────────
// .gitignore
// ─────────────────────────────────────────────────────────────────────

/**
 * `.gitignore` 里必须被忽略的两样东西。
 *
 * 两条都属于"不加就会自锁"那一类，不是洁癖：漏掉任何一条，工作区就会变脏，
 * 而改动守卫因此拒绝应用任何补丁 —— 用户看到的是"跑得好好的，但从来不优化"，
 * 报告里给出的原因（"工作区不干净"）还指向他自己的代码改动。
 */
const MEMORY_IGNORE: GitignoreEntry = {
  pattern: '.perfpilot/',
  why: 'PerfPilot 的运行记录与记忆（基线就存在这里）',
};

const TOOLS_IGNORE: GitignoreEntry = {
  pattern: `${PERFPILOT_CHECKOUT_DIR}/`,
  why:
    `CI 会把 PerfPilot 源码检出到 ${PERFPILOT_CHECKOUT_DIR}/，而它就在这个仓库里。\n` +
    '# 不忽略的话，"工作区必须干净"的检查会永远失败，于是永远不应用任何优化',
};

/**
 * 确保 `.gitignore` 覆盖给定的条目，返回一句给用户看的话。
 *
 * **这不是便利，是正确性**（理由见上面两条常量）。只写缺的那些，
 * 因此重复运行是安全的，也不会把用户自己写过的等价规则又追加一遍。
 */
async function ensureGitignored(
  cwd: string,
  facts: ProjectFacts,
  entries: readonly GitignoreEntry[],
  out: (text: string) => void,
): Promise<string> {
  const path = join(cwd, '.gitignore');
  const existing = await readTextFile(path);

  /**
   * 已有 `.gitignore` 就补缺少的行；没有的话，只在确认是 git 仓库时才创建。
   *
   * 早先的版本在"没检测到 git 仓库"时一律跳过 —— 那会漏掉一种真实状态：
   * 目录里有 `.gitignore` 但尚未 `git init`（例如刚导出的项目）。
   * 补一行是**无害且必要**的，与有没有仓库无关。
   */
  if (existing === null && !facts.isGitRepo) {
    return 'ℹ️  没检测到 git 仓库，也没有 .gitignore —— 跳过（改动闭环需要 git，先 `git init`）\n';
  }

  const missing = missingGitignoreEntries(existing ?? '', entries);
  if (missing.length === 0) {
    return `✅ .gitignore 已忽略 ${entries.map((entry) => entry.pattern).join('、')}\n`;
  }

  const names = missing.map((entry) => entry.pattern).join('、');

  try {
    await writeFile(path, (existing ?? '') + gitignorePatch(existing ?? '', missing), 'utf8');
    out(`✅ 已把 ${names} 加进 .gitignore（为什么必须加，写在文件里的注释里）\n`);
    return '';
  } catch (err) {
    return `⚠️  未能写入 .gitignore（${toPerfPilotError(err).message}）—— 请手动加上 ${names}\n`;
  }
}

// ─────────────────────────────────────────────────────────────────────
// 输出
// ─────────────────────────────────────────────────────────────────────

function printFacts(facts: ProjectFacts, url: string, out: (text: string) => void): void {
  const scriptLines = Object.entries(facts.scripts).map(([kind, name]) => `${kind}=${name}`);

  out(
    '\n检测到的项目信息（都写进配置了，可自行修改）：\n' +
      `  · 项目名    ${facts.name}\n` +
      `  · 包管理器  ${facts.packageManager}（项目根有对应 lockfile；没有则回落 pnpm）\n` +
      `  · 技术栈    ${[facts.framework, facts.buildTool ?? ''].filter(Boolean).join(' + ') || '未识别'}\n` +
      `  · 检查脚本  ${scriptLines.length > 0 ? scriptLines.join('、') : '一个都没找到（验证阶段会全部跳过）'}\n` +
      `  · 仓库      ${facts.repo === '' ? '未设置（留了 TODO）' : facts.repo}\n` +
      `  · 分支      ${facts.branch}\n`,
  );

  if (isLikelyDevServer(url)) {
    out(
      '\n⚠️  注意：这个地址看起来是**本地 dev server**。dev server 发的是未打包源码，\n' +
        '   测出来的 LCP / 传输体积与线上没有可比性。正式使用请改成预览或预发地址。\n',
    );
  }
}

function printNextSteps(url: string, out: (text: string) => void): void {
  out(
    '\n接下来：\n' +
      '  1. perfpilot diagnose           # 只采集 + 诊断，不改任何代码\n' +
      '  2. perfpilot run --dry-run      # 看会改什么（补丁落盘，不动工作区）\n' +
      '  3. perfpilot run                # 完整闭环（工作区必须干净）\n' +
      '  4. perfpilot serve --port 3099  # 打开网页报告\n\n' +
      `  测的是 ${url}。要测 LCP/CLS 还得装 Lighthouse：npm i -g lighthouse\n`,
  );
}

// ─────────────────────────────────────────────────────────────────────
// 工具
// ─────────────────────────────────────────────────────────────────────

function resolveConfigTarget(options: InitOptions): string {
  if (options.configPath !== undefined) {
    return isAbsolute(options.configPath)
      ? options.configPath
      : resolve(options.cwd, options.configPath);
  }
  return join(options.cwd, DEFAULT_CONFIG_FILES[0]);
}

async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

async function fileExists(path: string): Promise<boolean> {
  return (await readTextFile(path)) !== null;
}

/** 目录也算存在（`.github/` 是个目录） */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 用 YAML 解析器读回来校验。
 *
 * 不直接 `PerfPilotConfigSchema.parse(content)`：那是把 YAML **文本**当对象传，
 * 永远失败。这里与真实加载路径走同一步（先 parse YAML 再校验），
 * 因此能真的验出"生成的 YAML 语法有问题"。
 */
function parseYamlLoose(content: string): unknown {
  return parseYaml(content);
}
