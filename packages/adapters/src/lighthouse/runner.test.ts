import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { probeLighthouse, resolveLighthouseBin } from './runner.js';

describe('resolveLighthouseBin', () => {
  const saved = process.env.PERFPILOT_LIGHTHOUSE_BIN;

  afterAll(() => {
    if (saved === undefined) delete process.env.PERFPILOT_LIGHTHOUSE_BIN;
    else process.env.PERFPILOT_LIGHTHOUSE_BIN = saved;
  });

  it('默认取 PATH 上的 lighthouse，Windows 上补 .cmd 垫片', () => {
    delete process.env.PERFPILOT_LIGHTHOUSE_BIN;

    expect(resolveLighthouseBin(undefined, 'linux')).toBe('lighthouse');
    expect(resolveLighthouseBin(undefined, 'darwin')).toBe('lighthouse');
    expect(resolveLighthouseBin(undefined, 'win32')).toBe('lighthouse.cmd');
  });

  it('环境变量优先于默认值，空白值回落', () => {
    process.env.PERFPILOT_LIGHTHOUSE_BIN = 'D:\\nvm\\nodejs\\lighthouse.cmd';
    expect(resolveLighthouseBin(undefined, 'win32')).toBe('D:\\nvm\\nodejs\\lighthouse.cmd');

    process.env.PERFPILOT_LIGHTHOUSE_BIN = '   ';
    expect(resolveLighthouseBin(undefined, 'win32')).toBe('lighthouse.cmd');
  });

  it('已有可执行扩展名时不再追加', () => {
    expect(resolveLighthouseBin('lighthouse.cmd', 'win32')).toBe('lighthouse.cmd');
    expect(resolveLighthouseBin('lighthouse.exe', 'win32')).toBe('lighthouse.exe');
    expect(resolveLighthouseBin('lighthouse.bat', 'win32')).toBe('lighthouse.bat');
  });

  it('非 Windows 原样返回，不做任何改写', () => {
    expect(resolveLighthouseBin('/usr/local/bin/lighthouse', 'darwin')).toBe(
      '/usr/local/bin/lighthouse',
    );
    expect(resolveLighthouseBin(undefined, 'linux')).not.toContain('.cmd');
  });
});

/**
 * 回归：npm 全局安装的 lighthouse 在 Windows 上是 `.cmd` 垫片。
 *
 * 修复前这里必然失败 —— `execFile('lighthouse')` 得到 ENOENT（不做 PATHEXT 解析），
 * `execFile('lighthouse.cmd')` 得到 EINVAL（Node 20 起禁止无 shell 直接 spawn `.cmd`），
 * 表现为「lighthouse 数据源永远不可用」，与装在哪、装没装无关。
 */
describe.skipIf(process.platform !== 'win32')('probeLighthouse 拉起 .cmd 垫片', () => {
  let dir = '';
  let shim = '';

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'perfpilot-lh-'));
    shim = join(dir, 'fake-lighthouse.cmd');
    await writeFile(shim, '@echo off\r\necho 13.5.0\r\n', 'utf8');
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('探活成功', async () => {
    await expect(probeLighthouse(shim)).resolves.toBe(true);
  });

  it('不存在的可执行文件仍判为不可用', async () => {
    await expect(probeLighthouse(join(dir, 'absent.cmd'))).resolves.toBe(false);
  });
});
