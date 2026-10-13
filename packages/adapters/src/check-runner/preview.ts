import { spawn } from 'node:child_process';

/**
 * 起项目的预览服务、等它就绪、用完停掉。
 *
 * ## 为什么由工具来起
 *
 * 实测最常踩的坑就是这个：忘了起预览服务 → Chrome 打不开地址 → Lighthouse 报
 * "Chrome 拦在了错误页" → LCP/CLS/TBT **整块缺失**，而报告只会写"该来源不可用"。
 * 用户得从日志里反推出"哦，我忘了起服务"。
 *
 * 工具明明知道要测哪个地址、也知道项目里有哪个 preview 脚本 —— 那就自己起、
 * 自己等、自己收。缺的从来不是能力，而是有人把这三步串起来。
 *
 * 硬约束 5：外部进程只能在这里（adapter 层）调用，core 不认识它。
 */

const PM_BINARY: Record<string, string> = {
  pnpm: 'pnpm',
  npm: 'npm',
  yarn: 'yarn',
  bun: 'bun',
};

export interface PreviewServerOptions {
  /** 项目根（要在那里跑脚本） */
  root: string;
  packageManager: 'pnpm' | 'npm' | 'yarn' | 'bun';
  /** package.json 里的脚本名，如 `preview` 或 `dev` */
  script: string;
  /** 端口；给了就传给脚本（`--port <n> --strictPort`） */
  port?: string;
  /** 就绪探测用的地址 */
  url: string;
  /** 等待就绪的上限，默认 90 秒 */
  timeoutMs?: number;
  /** 服务进程的输出（默认丢弃；传了就用它记日志） */
  onOutput?: (chunk: string) => void;
}

export interface PreviewServer {
  /** 实际执行的命令（出错时把它写进日志，用户才知道该自己怎么起） */
  command: string;
  stop(): Promise<void>;
}

/** 就绪判定：任何非 5xx 的 HTTP 响应都算"服务活着" */
async function isUp(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'manual' });
    return response.status < 500;
  } catch {
    return false;
  }
}

export async function startPreviewServer(options: PreviewServerOptions): Promise<PreviewServer> {
  const binary = PM_BINARY[options.packageManager] ?? 'npm';
  const args = [
    'run',
    options.script,
    ...(options.port === undefined ? [] : ['--', '--port', options.port, '--strictPort']),
  ];
  const command = `${binary} ${args.join(' ')}`;

  const child = spawn(binary, args, {
    cwd: options.root,
    // Windows 上包管理器是 .cmd 垫片，脱离 shell 起不来（与 lighthouse / check-runner 同一处理）
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const onOutput = options.onOutput;
  if (onOutput !== undefined) {
    child.stdout?.on('data', (chunk: Buffer) => onOutput(chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => onOutput(chunk.toString('utf8')));
  } else {
    child.stdout?.resume();
    child.stderr?.resume();
  }

  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.killed) return;

    if (process.platform === 'win32' && child.pid !== undefined) {
      /**
       * Windows 上必须连子孙一起杀：包管理器本身就是一层壳，真正的
       * 预览服务器是它的子进程 —— 只杀 `child` 会留下一个占着端口的孤儿，
       * 下一次运行的 `--strictPort` 就会因为"端口被占"直接失败。
       */
      await new Promise<void>((resolve) => {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.on('close', () => resolve());
        killer.on('error', () => resolve());
      });
      return;
    }

    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  };

  const deadline = Date.now() + (options.timeoutMs ?? 90_000);

  while (Date.now() < deadline) {
    if (await isUp(options.url)) return { command, stop };

    // 进程已经死了就别等了：把原因（端口被占、脚本不存在）留给调用方报
    if (child.exitCode !== null) {
      await stop();
      throw new Error(`预览服务退出（exit ${child.exitCode}）：${command}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  await stop();
  throw new Error(`预览服务在 ${Math.round((options.timeoutMs ?? 90_000) / 1000)} 秒内没有就绪：${command}`);
}
