import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  AdapterError,
  parseJsonText,
  type RawArtifact,
  type RawRunner,
} from '@yuki-byte18/shared';
import { resolveRouteUrl, routeSlug } from '../internal/url.js';

const execFileAsync = promisify(execFile);

export const LIGHTHOUSE_OUTPUT_KIND = 'lighthouse-result';

export interface LighthouseRunnerOptions {
  /** lighthouse 可执行文件，默认走 PATH */
  bin?: string;
  /** 追加到命令行的额外参数（如 `--preset=desktop`） */
  extraArgs?: string[];
}

/**
 * Lighthouse 真实采集。
 *
 * 用 CLI 而不是 `lighthouse` npm 包：npm 包会把 ChromeLauncher 与整棵
 * 依赖树拖进 CI 镜像，而我们只是要一份 JSON。CLI 输出的就是我们要的东西。
 *
 * 这是 adapter 层唯一接触外部进程的地方，被隔离在 `*.runner.ts` 里，
 * 因此它不进覆盖率分母（见 vitest.config.ts），其解析侧由录制的 fixture 覆盖。
 */
export function createLighthouseRunner(options: LighthouseRunnerOptions = {}): RawRunner {
  const bin = resolveLighthouseBin(options.bin);

  return async (ctx): Promise<RawArtifact[]> => {
    const url = resolveRouteUrl(ctx.url, ctx.route);
    const file = `lighthouse-${routeSlug(ctx.route)}.json`;
    const outputPath = join(ctx.outputDir, file);

    const args = [
      url,
      '--output=json',
      `--output-path=${outputPath}`,
      '--quiet',
      `--form-factor=${ctx.device}`,
      '--chrome-flags=--headless=new --no-sandbox --disable-dev-shm-usage',
      ...(options.extraArgs ?? []),
    ];

    try {
      await execFileAsync(bin, args, {
        timeout: ctx.timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        // 仅 Windows 需要：npm 装出来的 lighthouse 是 .cmd 垫片（见下方注释）
        shell: process.platform === 'win32',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AdapterError(`lighthouse 执行失败: ${message}`, {
        code: 'ADAPTER_FAILED',
        stage: 'collect',
        retryable: true,
        details: { url, bin },
        cause: err,
      });
    }

    let payload: unknown;
    try {
      payload = parseJsonText(await readFile(outputPath, 'utf8'));
    } catch (err) {
      throw new AdapterError(`lighthouse 输出无法读取或不是合法 JSON: ${outputPath}`, {
        code: 'ADAPTER_OUTPUT_INVALID',
        stage: 'collect',
        retryable: false,
        cause: err,
      });
    }

    return [
      {
        adapter: 'lighthouse',
        kind: LIGHTHOUSE_OUTPUT_KIND,
        payload,
        collectedAt: new Date().toISOString(),
        route: ctx.route,
        device: ctx.device,
        file,
      },
    ];
  };
}

/** 探活：`lighthouse --version` 能跑通即认为可用 */
export async function probeLighthouse(bin?: string): Promise<boolean> {
  try {
    await execFileAsync(resolveLighthouseBin(bin), ['--version'], {
      timeout: 20_000,
      windowsHide: true,
      shell: process.platform === 'win32',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 把 `lighthouse` 这个名字解析成 Windows 上真的拉得起来的形状。
 *
 * npm 全局安装的可执行文件在 Windows 上是 `.cmd` 垫片，于是直接 spawn 会连
 * 撞两堵墙：`execFile('lighthouse')` **不做 PATHEXT 解析**，得到 ENOENT；
 * 而显式写成 `lighthouse.cmd` 又会被 Node 20 起的安全策略拒绝（`.cmd`/`.bat`
 * 不允许脱离 shell 直接 spawn），得到 EINVAL。两种写法都表现为「探活失败 →
 * 数据源不可用」，用户会误以为是没装或装错了地方 —— 其实是这里的问题。
 *
 * 因此：补一个 `.cmd` 扩展名，再在调用处开 `shell`（与 check-runner 同一处理）。
 * 注意**不要**在这里给路径加引号：实测 `execFile('"npm.cmd"', { shell: true })`
 * 反而会失败，引号会被 cmd.exe 当成文件名的一部分。
 *
 * 已知限制：带空格的 bin 路径在 shell 模式下无法正确传递，请改用 PATH 上的裸名。
 */
export function resolveLighthouseBin(
  bin?: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const raw = (bin ?? process.env.PERFPILOT_LIGHTHOUSE_BIN ?? 'lighthouse').trim();
  const name = raw === '' ? 'lighthouse' : raw;

  if (platform !== 'win32') return name;
  if (/\.(cmd|exe|bat)$/i.test(name)) return name;

  return `${name}.cmd`;
}
