import { describe, expect, it } from 'vitest';
import { runChecks, type CheckResult, type DoctorFacts } from './doctor.js';
import { PerfPilotConfigSchema } from '@yuki-byte18/shared';

/**
 * 体检结论的测试。
 *
 * 为什么值得一测：doctor 的价值全在**结论的措辞**上 —— 它得说清"检测到了什么"
 * 和"下一步敲什么命令"。写成"环境有问题"等于没说，而且没人会发现，
 * 因为没人会因为一句模糊的提示去提 issue。
 *
 * 这里全部是纯函数测试：`runChecks` 只吃事实、吐结论，所以不需要真仓库、
 * 真网络、真 Lighthouse。
 */

const config = (overrides: Record<string, unknown> = {}): DoctorFacts['config'] => ({
  path: '/proj/.perfpilot.yml',
  exists: true,
  value: PerfPilotConfigSchema.parse({
    project: { name: 'demo' },
    target: { url: 'http://127.0.0.1:4173' },
    ...overrides,
  }),
  error: null,
});

const facts = (overrides: Partial<DoctorFacts> = {}): DoctorFacts => ({
  nodeVersion: '24.2.0',
  config: config(),
  git: { isRepo: true, clean: true, branch: 'main' },
  gitignore: { exists: true, coversArtifacts: true },
  target: { url: 'http://127.0.0.1:4173', status: 200, error: null },
  lighthouse: true,
  llm: { provider: 'none', apiKeyEnv: null, apiKeyPresent: false },
  checkScripts: { declared: [], missing: [] },
  ci: { path: null, hasPlaceholder: false },
  preview: { script: 'preview', port: '4173' },
  ...overrides,
});

const find = (checks: readonly CheckResult[], id: string): CheckResult => {
  const found = checks.find((check) => check.id === id);
  if (found === undefined) throw new Error(`没有这条检查：${id}`);
  return found;
};

describe('perfpilot doctor —— 体检结论', () => {
  it('一切正常时全绿，且没有任何"修"的建议', () => {
    const checks = runChecks(facts());

    expect(checks.filter((c) => c.status !== 'ok')).toEqual([]);
    expect(checks.every((c) => c.fix === null)).toBe(true);
  });

  it('Node 太低 → fail，并给出升级方式（记忆层需要 22.13+）', () => {
    const node = find(runChecks(facts({ nodeVersion: '20.11.0' })), 'node');

    expect(node.status).toBe('fail');
    expect(node.detail).toContain('22.13');
    expect(node.fix).toContain('nvm install');
  });

  it('工作区不干净 → fail，并说清"run 会什么都不做"', () => {
    const worktree = find(runChecks(facts({ git: { isRepo: true, clean: false, branch: 'main' } })), 'worktree');

    expect(worktree.status).toBe('fail');
    expect(worktree.detail).toContain('不会应用任何补丁');
    expect(worktree.fix).toContain('git commit');
  });

  it('不是 git 仓库 → fail（改动没法回滚）', () => {
    const repo = find(runChecks(facts({ git: { isRepo: false, clean: false, branch: null } })), 'git-repo');

    expect(repo.status).toBe('fail');
    expect(repo.fix).toContain('git init');
  });

  it('测量地址打不开 → fail，并给出**这个项目**的起服务命令', () => {
    const target = find(
      runChecks(facts({ target: { url: 'http://127.0.0.1:4173', status: null, error: 'ECONNREFUSED' } })),
      'target',
    );

    expect(target.status).toBe('fail');
    expect(target.detail).toContain('LCP/CLS/TBT 全部缺失');
    // 这条是 doctor 的核心价值：从"检测到问题"直接接到"敲什么命令"
    expect(target.fix).toContain('npm run preview -- --port 4173');
    expect(target.fix).toContain('curl http://127.0.0.1:4173');
  });

  it('地址能打开但状态码不对（例如 404）→ fail', () => {
    const target = find(
      runChecks(facts({ target: { url: 'http://127.0.0.1:4173', status: 404, error: null } })),
      'target',
    );

    expect(target.status).toBe('fail');
    expect(target.detail).toContain('404');
  });

  it('Lighthouse 不可用只算 warn：产物体积类指标照样能测', () => {
    const lh = find(runChecks(facts({ lighthouse: false })), 'lighthouse');

    expect(lh.status).toBe('warn');
    expect(lh.detail).toContain('未采集');
    expect(lh.fix).toContain('npm i -g lighthouse');
  });

  it('配了 LLM 但 key 没设置 → warn，并给出这个平台上设置变量的写法', () => {
    const llm = find(
      runChecks(
        facts({ llm: { provider: 'openai', apiKeyEnv: 'DEEPSEEK_API_KEY', apiKeyPresent: false } }),
        'win32',
      ),
      'llm',
    );

    expect(llm.status).toBe('warn');
    expect(llm.detail).toContain('DEEPSEEK_API_KEY');
    expect(llm.detail).toContain('降级');
    expect(llm.fix).toContain('$env:DEEPSEEK_API_KEY');
  });

  it('没启用 LLM 时是 ok，并且明说零成本（不是"配错了"）', () => {
    const llm = find(runChecks(facts()), 'llm');

    expect(llm.status).toBe('ok');
    expect(llm.detail).toContain('零调用、零成本');
  });

  it('.gitignore 没忽略运行产物 → warn（守卫已能容忍，但产物不该进版本库）', () => {
    const gi = find(
      runChecks(facts({ gitignore: { exists: true, coversArtifacts: false } })),
      'gitignore',
    );

    expect(gi.status).toBe('warn');
    expect(gi.fix).toContain('.perfpilot/');
  });

  it('声明了 package.json 里不存在的检查脚本 → warn，并说清后果', () => {
    const check = find(
      runChecks(facts({ checkScripts: { declared: [{ kind: 'build', script: 'compile' }], missing: ['build → compile'] } })),
      'check-scripts',
    );

    expect(check.status).toBe('warn');
    expect(check.detail).toContain('会被跳过');
  });

  it('CI 文件里还有 CHANGE_ME 占位符 → warn', () => {
    const ci = find(
      runChecks(
        facts({ ci: { path: '.github/workflows/perfpilot.yml', hasPlaceholder: true } }),
      ),
      'ci-placeholder',
    );

    expect(ci.status).toBe('warn');
    expect(ci.fix).toContain('仓库地址');
  });

  it('配置不存在 → fail，并给出直接可跑的 init 命令', () => {
    const cfg = find(
      runChecks(facts({ config: { path: '/proj/.perfpilot.yml', exists: false, value: null, error: null } })),
      'config',
    );

    expect(cfg.status).toBe('fail');
    expect(cfg.fix).toContain('perfpilot init');
  });

  it('配置不合法 → fail，并把 zod 的报错带出来', () => {
    const cfg = find(
      runChecks(
        facts({
          config: { path: '/proj/.perfpilot.yml', exists: true, value: null, error: 'target.url: 不是合法 URL' },
        }),
      ),
      'config',
    );

    expect(cfg.status).toBe('fail');
    expect(cfg.detail).toContain('不是合法 URL');
  });
});
