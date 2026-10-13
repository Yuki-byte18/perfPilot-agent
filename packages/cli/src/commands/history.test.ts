import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeMemory, createMemory } from '@yuki-byte18/adapters';
import { history } from './history.js';

/**
 * `history --show-failures` 与撤销入口（M6 遗留）。
 *
 * 失败记忆是**一票否决**：命中指纹就不再提案。因此撤销入口不是"锦上添花的功能"，
 * 而是这个机制的必要出口 —— 没有它，一次误判就等于永久禁用一类改动。
 */

let dir = '';
let stdout: string[] = [];
let restore: (() => void) | null = null;
const CONFIG = ['project:', '  name: demo', 'target:', '  url: https://staging.example.com', ''].join('\n');

afterEach(async () => {
  restore?.();
  restore = null;
  if (dir !== '') await rm(dir, { recursive: true, force: true });
  dir = '';
  stdout = [];
});

async function project(): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), 'perfpilot-history-'));
  await writeFile(join(dir, '.perfpilot.yml'), CONFIG, 'utf8');
  await writeFile(join(dir, 'package.json'), '{"name":"demo","private":true}\n', 'utf8');

  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout.push(String(chunk));
    return true;
  });
  restore = () => spy.mockRestore();
}

/** 往记忆库里写一条失败记忆（走真实的 SQLite 路径） */
async function seedFailure(fingerprint: string): Promise<void> {
  const memory = createMemory(
    { config: { driver: 'sqlite', url: '.perfpilot/memory.db' }, root: dir },
    );
  try {
    await memory.saveFailure({
      id: `fail_${fingerprint}`,
      candidateFingerprint: fingerprint,
      bottleneckKind: 'OVERSIZED_IMAGE',
      failureReason: '收益 0.4 < min_gain 5',
      project: 'demo',
      techStack: 'vite+react',
      failedAt: '2026-01-17T14:25:30.000Z',
    });
  } finally {
    closeMemory(memory);
  }
}

const output = (): string => stdout.join('');

describe('history --show-failures', () => {
  it('库里为空时说清"为什么是空的"，而不是一片空白', async () => {
    await project();
    await history({ cwd: dir, showFailures: true });

    expect(output()).toContain('失败记忆');
    expect(output()).toContain('暂无失败记忆');
    // 关键：告诉用户失败记忆什么时候才会产生
    expect(output()).toContain('diagnose');
  });

  it('列出失败原因与指纹，并给出撤销命令', async () => {
    await project();
    await seedFailure('OVERSIZED_IMAGE|asset');

    await history({ cwd: dir, showFailures: true });

    const text = output();
    expect(text).toContain('OVERSIZED_IMAGE|asset');
    // 失败原因必须显示 —— 只知道"失败过"没法判断该不该撤销
    expect(text).toContain('min_gain');
    // 撤销命令要直接能复制
    expect(text).toContain('--forget');
  });
});

describe('history --forget / --forget-all', () => {
  it('按指纹撤销：只忘掉那一条，返回条数', async () => {
    await project();
    await seedFailure('OVERSIZED_IMAGE|asset');
    await seedFailure('LARGE_JS_BUNDLE|config');

    await history({ cwd: dir, forget: 'OVERSIZED_IMAGE|asset' });

    expect(output()).toContain('已忘掉 1 条');

    // 另一条仍在（撤销不该顺手清空）
    const memory = createMemory({ config: { driver: 'sqlite', url: '.perfpilot/memory.db' }, root: dir });
    try {
      expect(await memory.hasFailedFailure('OVERSIZED_IMAGE|asset', 'demo')).toBe(false);
      expect(await memory.hasFailedFailure('LARGE_JS_BUNDLE|config', 'demo')).toBe(true);
    } finally {
      closeMemory(memory);
    }
  });

  it('指纹不存在时如实说"没找到"，并提示怎么拿到正确指纹', async () => {
    await project();

    await history({ cwd: dir, forget: '不存在的指纹' });

    expect(output()).toContain('没有可忘掉');
    expect(output()).toContain('--show-failures');
  });

  it('--forget-all 清空本项目的失败记忆', async () => {
    await project();
    await seedFailure('a|asset');
    await seedFailure('b|config');

    await history({ cwd: dir, forgetAll: true });

    expect(output()).toContain('已忘掉 2 条');

    const memory = createMemory({ config: { driver: 'sqlite', url: '.perfpilot/memory.db' }, root: dir });
    try {
      expect(await memory.listFailures('demo', 10)).toEqual([]);
    } finally {
      closeMemory(memory);
    }
  });

  it('撤销之后同一个改法会重新参与提案（这是撤销的全部意义）', async () => {
    await project();
    const fingerprint = 'OVERSIZED_IMAGE|asset';
    await seedFailure(fingerprint);

    const before = createMemory({ config: { driver: 'sqlite', url: '.perfpilot/memory.db' }, root: dir });
    expect(await before.hasFailedFailure(fingerprint, 'demo')).toBe(true);
    closeMemory(before);

    await history({ cwd: dir, forget: fingerprint });

    const after = createMemory({ config: { driver: 'sqlite', url: '.perfpilot/memory.db' }, root: dir });
    try {
      // planner 的剔除判据就是这一句
      expect(await after.hasFailedFailure(fingerprint, 'demo')).toBe(false);
    } finally {
      closeMemory(after);
    }
  });
});
