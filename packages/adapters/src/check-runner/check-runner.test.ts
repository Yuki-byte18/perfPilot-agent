import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCheckRunnerAdapter } from './index.js';

/**
 * check-runner adapter 的行为约定。
 *
 * 这个适配器只有一件事容易做错，而且做错了很难发现：
 * **把"项目里没有这个脚本"当成"检查失败"或"检查通过"**。
 * 前者会让每一次优化都回滚（因为没有 E2E 的项目永远跑不过验证），
 * 后者会在验证记录里留下一条假证据。所以三种状态各有一条用例。
 *
 * 这里刻意不做「真的跑一次 pnpm test」的用例：那会让单测依赖本仓库的
 * package.json，换个项目就失效，而且慢。真实的进程调用只测到
 * 「命令能起、退出码能读回」，用包管理器自身作为被测命令即可。
 */

let dir = '';

afterEach(async () => {
  if (dir !== '') await rm(dir, { recursive: true, force: true });
  dir = '';
});

async function makeProject(scripts: Record<string, string>): Promise<void> {
  dir = await mkdtemp(join(tmpdir(), 'perfpilot-check-'));
  await writeFile(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: 'demo', private: true, scripts }, null, 2)}\n`,
    'utf8',
  );
}

describe('check-runner — 三种状态必须可区分', () => {
  it('项目里没有这个脚本 → skipped，既不是失败也不是通过', async () => {
    await makeProject({ lint: 'node --version' });
    const runner = createCheckRunnerAdapter();

    const result = await runner.run('e2e', dir);

    expect(result.skipped).toBe(true);
    // 跳过不等于失败：不该因为它回滚
    expect(result.passed).toBe(true);
    expect(result.durationMs).toBe(0);
    expect(result.output).toContain('未定义');
    expect(result.output).toContain('e2e');
  });

  it('连 package.json 都没有 → 同样按跳过处理，而不是崩掉', async () => {
    dir = await mkdtemp(join(tmpdir(), 'perfpilot-check-'));
    const runner = createCheckRunnerAdapter();

    const result = await runner.run('unit-test', dir);

    expect(result.skipped).toBe(true);
    expect(result.passed).toBe(true);
  });

  it('脚本存在且成功 → passed 且不是 skipped', async () => {
    // 刻意不用带引号的脚本：脚本会被包管理器交给 shell，
    // `node -e "process.exit(0)"` 在 Windows 上会被剥掉引号变成
    // `node -e process.exit(0)` —— 那条命令其实是成功的，
    // 于是测试看起来在验失败路径，实际验的是成功路径
    await makeProject({ lint: 'node --version' });
    const runner = createCheckRunnerAdapter();

    const result = await runner.run('lint', dir);

    expect(result.passed).toBe(true);
    expect(result.skipped).toBe(false);
    expect(result.output).toContain('v');
  });

  it('脚本失败 → passed=false 且带上退出码', async () => {
    // 注意脚本名是 `typecheck`：DEFAULT_SCRIPTS 映射的是这个名字，
    // 写成 `type-check` 会变成"没有这个脚本"，于是测的其实是跳过路径
    await makeProject({ typecheck: 'definitely-not-a-command' });
    const runner = createCheckRunnerAdapter({ packageManager: 'npm' });

    const result = await runner.run('type-check', dir);

    expect(result.passed).toBe(false);
    expect(result.skipped).toBe(false);
    expect(result.output).toContain('退出码');
  });

  it('脚本名可按项目覆盖，设为 null 表示这个项目不做这项检查', async () => {
    await makeProject({ verify: 'node --version' });

    const custom = createCheckRunnerAdapter({ scripts: { 'unit-test': 'verify' } });
    const renamed = await custom.run('unit-test', dir);
    expect(renamed.passed).toBe(true);
    expect(renamed.skipped).toBe(false);

    const disabled = createCheckRunnerAdapter({ scripts: { e2e: null } });
    const off = await disabled.run('e2e', dir);
    expect(off.skipped).toBe(true);
  });

  it('package.json 的 scripts 被写坏时不会静默变成"全部跳过"', async () => {
    dir = await mkdtemp(join(tmpdir(), 'perfpilot-check-'));
    // `scripts` 不是对象：直接 as 强转会让每一项都读成 undefined，
    // 于是一个写错的文件能让整个验证层失效
    await writeFile(join(dir, 'package.json'), '{"name":"demo","scripts":"oops"}\n', 'utf8');

    const runner = createCheckRunnerAdapter();
    const result = await runner.run('lint', dir);

    // 这一条确实只能记成跳过（确实没有脚本），但必须有说明，不能是无声的空结果
    expect(result.skipped).toBe(true);
    expect(result.output).toContain('未定义');
  });
});

describe('check-runner — 真实进程调用', () => {
  it('能真的拉起包管理器并把输出带回来', async () => {
    await makeProject({ lint: 'node --version' });
    const runner = createCheckRunnerAdapter({ packageManager: 'npm' });

    const result = await runner.run('lint', dir);

    expect(result.passed).toBe(true);
    expect(result.output).toContain('v');
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('找不到包管理器 → 记为失败并说明原因，而不是抛出去', async () => {
    await makeProject({ lint: 'node --version' });
    // 用不可能存在的命令名模拟"环境里没有 pnpm"
    const runner = createCheckRunnerAdapter({
      packageManager: 'definitely-not-a-package-manager' as 'npm',
    });

    const result = await runner.run('lint', dir);

    expect(result.passed).toBe(false);
    expect(result.skipped).toBe(false);
    // 失败原因必须带上"是哪个命令没跑起来"，否则用户只知道"检查挂了"
    expect(result.output).toContain('definitely-not-a-package-manager');
  });
});
