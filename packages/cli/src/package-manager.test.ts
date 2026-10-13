import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolvePackageManager } from './bootstrap.js';

/**
 * 包管理器选错的症状很有欺骗性：检查是以 `<包管理器> run <script>` 跑的，
 * 用 pnpm 去跑 npm 项目，在没有 pnpm 的机器上直接失败 —— 而失败被记成
 * 「检查未通过」，整轮优化因此回滚，报告给出的理由是"单测没过"。
 */
describe('resolvePackageManager — 检查用哪个包管理器跑', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'perfpilot-pm-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const touch = (name: string): Promise<void> => writeFile(join(dir, name), '', 'utf8');

  it('auto：按 lockfile 判断', async () => {
    await touch('package-lock.json');
    expect(await resolvePackageManager('auto', dir)).toBe('npm');

    await rm(join(dir, 'package-lock.json'));
    await touch('yarn.lock');
    expect(await resolvePackageManager('auto', dir)).toBe('yarn');

    await rm(join(dir, 'yarn.lock'));
    await touch('bun.lockb');
    expect(await resolvePackageManager('auto', dir)).toBe('bun');
  });

  it('auto：一个 lockfile 都没有时回落 pnpm（本仓库自己的默认）', async () => {
    expect(await resolvePackageManager('auto', dir)).toBe('pnpm');
  });

  it('多个 lockfile 并存时以 pnpm 为先（monorepo 里很常见）', async () => {
    await touch('package-lock.json');
    await touch('pnpm-lock.yaml');
    expect(await resolvePackageManager('auto', dir)).toBe('pnpm');
  });

  it('显式配置优先于 lockfile', async () => {
    await touch('package-lock.json');
    expect(await resolvePackageManager('pnpm', dir)).toBe('pnpm');
  });
});
