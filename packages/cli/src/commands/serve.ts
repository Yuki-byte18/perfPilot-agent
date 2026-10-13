import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReportServer } from '@yuki-byte18/server';
import { EXIT_CODES, toPerfPilotError, type ExitCode } from '@yuki-byte18/shared';
import { createPinoLogger } from '@yuki-byte18/core';
import { loadConfig } from '../config-loader.js';

export interface ServeOptions {
  cwd: string;
  config?: string;
  port?: string;
  host?: string;
  /** 报告页构建产物目录；不传则自动探测 */
  webDir?: string | null;
  /**
   * 访问令牌。不传时读环境变量 `PERFPILOT_TOKEN`。
   *
   * 监听 `127.0.0.1`（默认）时不需要；一旦 `--host 0.0.0.0` 暴露出去，
   * 报告里的内部 URL / 资源体积 / 源码位置就等于公开了。
   */
  token?: string;
  /** 测试注入：拿到地址后立即返回，不阻塞等待信号 */
  onListening?: (url: string) => void;
  /** 测试注入：起完就关（用于验证端点） */
  once?: boolean;
  verbose?: boolean;
}

/**
 * `perfpilot serve` —— 起一个只读的报告服务（M7 最小 API，M8 报告托管）。
 *
 * **它只读 `.perfpilot/runs/`。** 不触发采集、不执行改动、不写任何东西：
 * 一旦服务端能触发运行，它就同时成了新的攻击面，以及新的
 * "为什么 CI 里跑了两遍"的来源。
 *
 * 默认只监听 `127.0.0.1`。报告里含内部 URL、资源体积、源码位置，
 * 默认对外暴露是不合适的；要暴露得显式传 `--host 0.0.0.0`。
 */
export async function serve(options: ServeOptions): Promise<ExitCode> {
  const logger = createPinoLogger({ level: options.verbose === true ? 'debug' : 'info' });

  try {
    const loaded = await loadConfig({
      cwd: options.cwd,
      ...(options.config !== undefined ? { configPath: options.config } : {}),
    });

    const port = parsePort(options.port);
    const token = options.token ?? process.env['PERFPILOT_TOKEN'] ?? null;
    const exposed = options.host !== undefined && options.host !== '127.0.0.1' && options.host !== 'localhost';

    const server = await createReportServer({
      baseDir: join(loaded.root, '.perfpilot'),
      // 报告页构建产物：与 server 包同级（monorepo 布局）。
      // 找不到时只提供 API —— 那是个合法状态，不是启动错误。
      webDir: options.webDir ?? findWebDir(),
      token,
      ...(options.host !== undefined ? { host: options.host } : {}),
      ...(port !== undefined ? { port } : {}),
      logger,
    });

    process.stdout.write(
      `\n# PerfPilot 报告服务\n\n` +
        `> ${server.url}\n\n` +
        '| 端点 | 说明 |\n| --- | --- |\n' +
        `| \`GET ${server.url}/healthz\` | 健康检查 |\n` +
        `| \`GET ${server.url}/api/runs\` | 运行记录列表 |\n` +
        `| \`GET ${server.url}/api/runs/:id\` | 单次运行的完整数据（含诊断 / 候选 / 决策 / 验证） |\n` +
        `| \`GET ${server.url}/api/runs/:id/report\` | 该次运行的 Markdown 报告 |\n\n` +
        `> 读取目录 \`${join(loaded.root, '.perfpilot')}\` · 按 Ctrl+C 退出\n\n`,
    );

    /**
     * 暴露到网络上却没设令牌时**明确警告**。
     *
     * 报告里含内部 URL、资源体积、源码位置；一个"以为只有自己能看"的
     * 0.0.0.0 监听是这个服务最危险的默认值。不阻止启动（有人就是要在内网共享），
     * 但必须说出来 —— 而且给出具体命令。
     */
    if (exposed && (token === null || token === '')) {
      process.stdout.write(
        '⚠️  正在监听非本机地址，但没有设置访问令牌 —— 任何能访问该端口的人都能看到完整报告。\n' +
          '   要么加 `--token <随机串>`，要么改回 `--host 127.0.0.1` 只在本机看。\n\n',
      );
    }

    options.onListening?.(server.url);

    if (options.once === true) {
      await server.close();
      return EXIT_CODES.OK;
    }

    // 等到收到信号：这是一个常驻进程，不该自己退出
    await new Promise<void>((resolve) => {
      const stop = (): void => {
        void server.close().then(resolve);
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });

    return EXIT_CODES.OK;
  } catch (err) {
    const error = toPerfPilotError(err);
    process.stdout.write(`\n❌ ${error.code}: ${error.message}\n`);
    return EXIT_CODES.CONFIG_ERROR;
  }
}

/** 端口是外部输入：`--port abc` 必须当场报错，而不是监听一个默认端口 */
function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
    throw toPerfPilotError(
      new Error(`--port 必须是 0-65535 之间的整数，收到 "${raw}"`),
      'CONFIG_INVALID',
    );
  }
  return parsed;
}

/**
 * 找报告页构建产物。
 *
 * 两种形态都要找得到，而且**以 npm 装下来的形态为准**：
 *
 * 1. **从 npm 安装**（`npm i -D @yuki-byte18/cli`）：`@yuki-byte18/web` 是 cli 的依赖，
 *    躺在 `node_modules/@yuki-byte18/web/` 下。用 `createRequire` 顺着 Node 自己的
 *    解析规则去找，而不是数 `../` 的层数 —— 层数在不同包管理器布局下不一样，
 *    而且从 `<root>/node_modules/@yuki-byte18/cli/dist/commands/` 往上数，
 *    永远数不到 `<root>/packages/web/dist`。之前就是那么写的：
 *    源码树里跑得好好的，一发布成包，报告页就 404、只剩 API。
 * 2. **在仓库里跑源码**（`pnpm perfpilot serve`）：往上找 `packages/web/dist`。
 *
 * 找不到返回 null，由 server 决定"只提供 API"。
 */
function findWebDir(): string | null {
  const candidates: string[] = [];

  try {
    // 刻意不用 import.meta.resolve：非 flag 版在 Node 20 上不可用，
    // 而 createRequire 从 Node 12 起就是稳定的。
    const manifest = createRequire(import.meta.url).resolve('@yuki-byte18/web/package.json');
    candidates.push(join(dirname(manifest), 'dist'));
  } catch {
    // 没装 @yuki-byte18/web：退回源码树布局继续找
  }

  const here = dirname(fileURLToPath(import.meta.url));
  // cli 的 dist 或 src 都在 packages/cli 下，往上两层就是 packages/
  candidates.push(
    join(here, '..', '..', '..', 'web', 'dist'),
    join(here, '..', '..', 'web', 'dist'),
    join(here, '..', '..', '..', '..', 'packages', 'web', 'dist'),
  );

  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'index.html'))) return candidate;
  }
  return null;
}
