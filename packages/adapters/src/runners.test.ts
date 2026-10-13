import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AdapterError, type CollectContext, type LoggerPort } from '@yuki-byte18/shared';
import { createBundleAnalyzerRunner, probeBundleAnalyzer } from './bundle-analyzer/runner.js';
import { createWebVitalsRunner, probeWebVitals } from './web-vitals/runner.js';
import { createLighthouseRunner } from './lighthouse/runner.js';

/**
 * `runner` 层是真会碰外部世界的那一半：spawn 进程、遍历目录、读文件。
 *
 * 这里覆盖前两者之外的部分 —— 目录遍历与文件读取用临时目录就能真实测，
 * Lighthouse 那条路径需要 Chrome，因此只测「工具不存在时给出正确错误」这一条：
 * 那是 CI 里最常撞到的失败模式（忘了装 lighthouse），错误码必须准确。
 */

const silentLogger: LoggerPort = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  child: () => silentLogger,
};

function ctx(outputDir: string): CollectContext {
  return {
    url: 'https://staging.example.com',
    route: '/dashboard',
    device: 'mobile',
    outputDir,
    timeoutMs: 5_000,
    logger: silentLogger,
  };
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'perfpilot-runner-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('web-vitals runner', () => {
  it('读取上报文件并产出原始产物', async () => {
    const file = join(dir, 'vitals.json');
    await writeFile(file, JSON.stringify({ metrics: { INP: { value: 180 } } }), 'utf8');

    const artifacts = await createWebVitalsRunner({ file })(ctx(dir));

    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.adapter).toBe('web-vitals');
    expect(artifacts[0]?.kind).toBe('web-vitals');
    expect(artifacts[0]?.route).toBe('/dashboard');
    expect(artifacts[0]?.device).toBe('mobile');
    // 上报文件是外部输入，不落盘副本；payload 原样带上
    expect(artifacts[0]?.payload).toEqual({ metrics: { INP: { value: 180 } } });
  });

  it('文件不存在时抛错（由 collector 降级为 warning），而不是静默返回空', async () => {
    const runner = createWebVitalsRunner({ file: join(dir, 'missing.json') });
    await expect(runner(ctx(dir))).rejects.toThrow();
  });

  it('文件存在但不是合法 JSON 时同样抛错', async () => {
    const file = join(dir, 'broken.json');
    await writeFile(file, '{ not json', 'utf8');
    await expect(createWebVitalsRunner({ file })(ctx(dir))).rejects.toThrow();
  });

  it('probe：文件可解析为 JSON 才认为可用', async () => {
    expect(await probeWebVitals({ file: join(dir, 'missing.json') })).toBe(false);

    const broken = join(dir, 'broken.json');
    await writeFile(broken, 'nope', 'utf8');
    expect(await probeWebVitals({ file: broken })).toBe(false);

    const good = join(dir, 'good.json');
    await writeFile(good, '{}', 'utf8');
    expect(await probeWebVitals({ file: good })).toBe(true);
  });

  it('带 UTF-8 BOM 的上报文件必须照常工作（Windows 上极常见）', async () => {
    const file = join(dir, 'bom.json');
    // PowerShell 的 `Set-Content -Encoding utf8`、记事本都会写出这个 BOM。
    // 不剥掉的话 JSON.parse 会抛错，适配器被判为「不可用」，
    // 用户只看到「INP 未采集」，根本想不到是文件开头三个字节的问题。
    await writeFile(file, `\uFEFF${JSON.stringify({ metrics: { INP: { value: 180 } } })}`, 'utf8');

    expect(await probeWebVitals({ file })).toBe(true);

    const artifacts = await createWebVitalsRunner({ file })(ctx(dir));
    expect(artifacts[0]?.payload).toEqual({ metrics: { INP: { value: 180 } } });
  });
});

describe('bundle-analyzer runner', () => {
  async function makeDist(files: Record<string, string>, stats?: unknown): Promise<string> {
    const dist = join(dir, 'dist');
    await mkdir(join(dist, 'assets'), { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(dist, name), content, 'utf8');
    }
    if (stats !== undefined) {
      await writeFile(join(dist, 'stats.json'), JSON.stringify(stats), 'utf8');
    }
    return dist;
  }

  it('遍历产物目录并按相对路径记录体积', async () => {
    const dist = await makeDist({ 'assets/index.js': 'x'.repeat(120), 'index.html': 'y'.repeat(20) });

    const artifacts = await createBundleAnalyzerRunner({ distDir: dist })(ctx(dir));
    const payload = artifacts[0]?.payload as {
      source: string;
      files: Array<{ path: string; size: number }>;
    };

    expect(artifacts[0]?.adapter).toBe('bundle-analyzer');
    expect(payload.source).toBe('scan');
    const byPath = Object.fromEntries(payload.files.map((f) => [f.path, f.size]));
    expect(byPath['assets/index.js']).toBe(120);
    expect(byPath['index.html']).toBe(20);
  });

  it('有 stats.json 时读取模块图并标记来源为 stats', async () => {
    const dist = await makeDist(
      { 'assets/index.js': 'x'.repeat(10) },
      { modules: [{ name: './node_modules/lodash/lodash.js', size: 71_000 }] },
    );

    const artifacts = await createBundleAnalyzerRunner({ distDir: dist })(ctx(dir));
    const payload = artifacts[0]?.payload as { source: string; modules: unknown[] };

    expect(payload.source).toBe('stats');
    expect(payload.modules).toHaveLength(1);
  });

  it('stats.json 不可解析时静默退回目录扫描（这是预期路径而非错误）', async () => {
    const dist = await makeDist({ 'assets/index.js': 'x'.repeat(10) }, undefined);
    await writeFile(join(dist, 'stats.json'), '{ broken', 'utf8');

    const artifacts = await createBundleAnalyzerRunner({ distDir: dist })(ctx(dir));
    const payload = artifacts[0]?.payload as { source: string };

    expect(payload.source).toBe('scan');
  });

  it('stats.json 结构不认时也退回 scan，而不是采信半截数据', async () => {
    const dist = await makeDist({ 'assets/index.js': 'x'.repeat(10) }, { notModules: [] });

    const artifacts = await createBundleAnalyzerRunner({ distDir: dist })(ctx(dir));
    const payload = artifacts[0]?.payload as { source: string };

    expect(payload.source).toBe('scan');
  });

  it('stats.json 带 BOM 时同样能读出模块图', async () => {
    const dist = await makeDist({ 'assets/index.js': 'x'.repeat(10) });
    await writeFile(
      join(dist, 'stats.json'),
      `\uFEFF${JSON.stringify({ modules: [{ name: './node_modules/lodash/lodash.js', size: 71_000 }] })}`,
      'utf8',
    );

    const artifacts = await createBundleAnalyzerRunner({ distDir: dist })(ctx(dir));
    const payload = artifacts[0]?.payload as { source: string };

    expect(payload.source).toBe('stats');
  });

  it('目录不存在时抛 AdapterError（不可重试：路径配错了重试也没用）', async () => {
    const runner = createBundleAnalyzerRunner({ distDir: join(dir, 'nope') });

    await expect(runner(ctx(dir))).rejects.toBeInstanceOf(AdapterError);
    await expect(runner(ctx(dir))).rejects.toMatchObject({
      code: 'ADAPTER_FAILED',
      retryable: false,
    });
  });

  it('probe：目录存在才可用', async () => {
    const dist = await makeDist({ 'a.js': 'x' });
    expect(await probeBundleAnalyzer({ distDir: dist })).toBe(true);
    expect(await probeBundleAnalyzer({ distDir: join(dir, 'nope') })).toBe(false);
    // 指向文件而不是目录时也不可用
    expect(await probeBundleAnalyzer({ distDir: join(dist, 'a.js') })).toBe(false);
  });

  it('文件数超过 maxFiles 时截断，避免误指向巨大目录时卡死', async () => {
    const dist = await makeDist({
      'a.js': 'x',
      'b.js': 'x',
      'c.js': 'x',
      'd.js': 'x',
    });

    const artifacts = await createBundleAnalyzerRunner({ distDir: dist, maxFiles: 2 })(ctx(dir));
    const payload = artifacts[0]?.payload as { files: unknown[] };

    expect(payload.files).toHaveLength(2);
  });
});

describe('lighthouse runner', () => {
  it('可执行文件不存在时抛 AdapterError，错误码指明是采集失败', async () => {
    const runner = createLighthouseRunner({ bin: 'perfpilot-no-such-binary-xyz' });

    await expect(runner(ctx(dir))).rejects.toBeInstanceOf(AdapterError);
    await expect(runner(ctx(dir))).rejects.toMatchObject({
      code: 'ADAPTER_FAILED',
      stage: 'collect',
      // 工具没装可能是环境问题，重试有意义（例如 CI 上先装了再重跑）
      retryable: true,
    });
  });
});
