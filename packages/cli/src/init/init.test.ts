import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PerfPilotConfigSchema, parseExternal } from '@yuki-byte18/shared';
import { parse as parseYaml } from 'yaml';
import { detectFacts } from './detect.js';
import { buildCiPlan, detectCiPlatform } from './ci.js';
import { renderConfig } from './render.js';
import { init } from '../commands/init.js';

/**
 * `perfpilot init`。
 *
 * 最要紧的一条是「**生成的配置必须过校验**」：过不了的话，用户拿到的是一个
 * 启动就报错的文件，而错误指向的是他的项目 —— 排查方向完全错了。
 */

const facts = (overrides: Partial<Parameters<typeof detectFacts>[0]> = {}) =>
  detectFacts({
    packageJson: {
      name: '@acme/web',
      scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview', typecheck: 'tsc --noEmit' },
      dependencies: { vue: '^3' },
      devDependencies: { vite: '^5' },
    },
    dirName: 'web',
    packageManager: 'npm',
    gitRemote: 'https://github.com/acme/web',
    gitBranch: 'main',
    gitignore: 'node_modules/\n',
    ...overrides,
  });

describe('detectFacts', () => {
  it('只收真实存在的检查脚本，并识别包管理器与技术栈', () => {
    const detected = facts();

    expect(detected.name).toBe('web'); // scope 去掉
    expect(detected.packageManager).toBe('npm');
    expect(detected.framework).toBe('vue');
    // 没写 test / lint / e2e 脚本 → 不进配置（也就不会被记成"未通过"）
    expect(Object.keys(detected.scripts).sort()).toEqual(['build', 'type-check']);
    expect(detected.scripts['type-check']).toBe('typecheck');
  });

  it('没有 package.json 时用目录名，不编造技术栈', () => {
    const detected = detectFacts({
      packageJson: null,
      dirName: 'my-app',
      packageManager: 'pnpm',
      gitRemote: null,
      gitBranch: null,
      gitignore: null,
    });

    expect(detected.name).toBe('my-app');
    expect(detected.framework).toBeNull();
    expect(detected.isGitRepo).toBe(false);
    expect(detected.repo).toBe('');
  });

  it('有 preview 脚本时建议 preview 端口（构建产物），否则退到 dev 端口', () => {
    expect(facts().suggestedUrl).toBe('http://127.0.0.1:4173/');

    const withoutPreview = detectFacts({
      packageJson: { scripts: { dev: 'vite' }, devDependencies: { vite: '^5' } },
      dirName: 'x',
      packageManager: 'npm',
      gitRemote: null,
      gitBranch: null,
      gitignore: null,
    });
    expect(withoutPreview.suggestedUrl).toBe('http://127.0.0.1:5173/');
  });
});

describe('renderConfig', () => {
  it('生成的配置能过 zod 校验（过不了就说明渲染有 bug）', () => {
    const content = renderConfig({
      facts: facts(),
      url: 'https://staging.example.com/',
      routes: ['/', '/dashboard'],
      generatedAt: '2026-01-17 14:25:30',
    });

    const parsed = parseExternal(PerfPilotConfigSchema, parseYaml(content), { what: '生成的配置' });

    expect(parsed.target.url).toBe('https://staging.example.com/');
    expect(parsed.target.routes).toEqual(['/', '/dashboard']);
    expect(parsed.target.repo).toBe('https://github.com/acme/web');
    expect(parsed.checks.package_manager).toBe('npm');
    expect(parsed.checks.kinds).toEqual(['build', 'type-check']);
    // 默认不接 LLM：不花钱的能力默认关着
    expect(parsed.llm?.provider).toBe('none');
  });

  it('没有远端时留空串 + TODO，而不是编一个地址', () => {
    const content = renderConfig({
      facts: facts({ gitRemote: null }),
      url: 'http://127.0.0.1:4173/',
      routes: ['/'],
      generatedAt: '2026-01-17 14:25:30',
    });

    const parsed = parseExternal(PerfPilotConfigSchema, parseYaml(content), { what: '生成的配置' });
    expect(parsed.target.repo).toBe('');
    expect(content).toContain('TODO');
  });
});

describe('init 命令', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'perfpilot-init-'));
    await writeFile(
      join(dir, 'package.json'),
      JSON.stringify({ name: 'demo-app', scripts: { build: 'vite build' }, devDependencies: { vite: '^5' } }),
      'utf8',
    );
    await writeFile(join(dir, '.gitignore'), 'node_modules/\n', 'utf8');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('非交互生成配置，并顺手补上 .gitignore', async () => {
    const code = await init({ cwd: dir, yes: true, url: 'http://127.0.0.1:4173/', out: () => undefined });

    expect(code).toBe(0);
    const config = await readFile(join(dir, '.perfpilot.yml'), 'utf8');
    expect(config).toContain('name: demo-app');
    expect(config).toContain('url: http://127.0.0.1:4173/');

    // `.perfpilot/` 没被忽略 → 第一次运行就弄脏工作区 → 守卫拒绝一切改动
    const gitignore = await readFile(join(dir, '.gitignore'), 'utf8');
    expect(gitignore).toContain('.perfpilot/');
  });

  it('生成 CI 文件时，连"CI 检出 PerfPilot 的目录"一起忽略掉', async () => {
    const code = await init({
      cwd: dir,
      yes: true,
      url: 'http://127.0.0.1:4173/',
      ci: 'github',
      out: () => undefined,
    });

    expect(code).toBe(0);
    const workflow = await readFile(join(dir, '.github', 'workflows', 'perfpilot.yml'), 'utf8');
    // 测试环境的 CLI 是从源码路径加载的，因此生成的是 checkout 形态
    expect(workflow).toContain('检出 PerfPilot');

    /**
     * 从生成的 workflow 里**抠出**检出目录，而不是在测试里再抄一遍字面量 ——
     * 这样"模板改了路径、忽略规则没跟着改"会立刻变红。
     *
     * 这个目录就在被测仓库里面：不忽略它，`git status` 永远是脏的，
     * 改动守卫于是永远拒绝应用补丁（报告里写"工作区不干净"，指向用户自己的改动）。
     */
    const checkoutDir = /path: (\S+)/.exec(workflow)?.[1];
    expect(checkoutDir).toBeDefined();
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).toContain(`${checkoutDir}/`);
  });

  it('不生成 CI 文件时也不写那一行（不给不用 CI 的项目塞看不懂的规则）', async () => {
    const code = await init({
      cwd: dir,
      yes: true,
      url: 'http://127.0.0.1:4173/',
      ci: 'none',
      out: () => undefined,
    });

    expect(code).toBe(0);
    expect(await readFile(join(dir, '.gitignore'), 'utf8')).not.toContain('tools/perfpilot');
  });

  it('已存在配置时不覆盖（除非 --force）', async () => {
    await writeFile(join(dir, '.perfpilot.yml'), 'project:\n  name: 手写的\n', 'utf8');

    const blocked = await init({ cwd: dir, yes: true, out: () => undefined });
    expect(blocked).toBe(2);
    expect(await readFile(join(dir, '.perfpilot.yml'), 'utf8')).toContain('手写的');

    const forced = await init({ cwd: dir, yes: true, url: 'https://x.example.com/', force: true, out: () => undefined });
    expect(forced).toBe(0);
    expect(await readFile(join(dir, '.perfpilot.yml'), 'utf8')).toContain('x.example.com');
  });

  it('没有 --url 也没有可推断的地址时，报错并给出可执行的提示', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'demo', scripts: {} }), 'utf8');

    const messages: string[] = [];
    const code = await init({ cwd: dir, yes: true, out: (text) => messages.push(text) });

    expect(code).toBe(2);
    expect(messages.join('')).toContain('--url');
  });

  it('非交互（--yes）时绝不打开付费能力：LLM 保持 provider: none', async () => {
    const code = await init({ cwd: dir, yes: true, url: 'https://x.example.com/', out: () => undefined });

    expect(code).toBe(0);
    const config = await readFile(join(dir, '.perfpilot.yml'), 'utf8');
    expect(config).toContain('provider: none');
    expect(config).not.toContain('base_url');
  });

  it('--llm deepseek：写进 base_url 与环境变量名，但**不写 key 本身**', async () => {
    const code = await init({
      cwd: dir,
      yes: true,
      llm: 'deepseek',
      url: 'https://x.example.com/',
      out: () => undefined,
    });

    expect(code).toBe(0);
    const config = await readFile(join(dir, '.perfpilot.yml'), 'utf8');

    expect(config).toContain('base_url: https://api.deepseek.com');
    expect(config).toContain('model: deepseek-chat');
    // 存的是环境变量的名字 —— 这个文件会进 git，不能放密钥
    expect(config).toContain('api_key_env: DEEPSEEK_API_KEY');
    expect(config).not.toMatch(/api_key\s*[:=]\s*sk-/);
    // 生成的配置仍然过校验（provider 用的是 openai 这一个值覆盖兼容服务）
    const parsed = parseExternal(PerfPilotConfigSchema, parseYaml(config), { what: '生成的配置' });
    expect(parsed.llm?.provider).toBe('openai');
  });

  it('交互式：问 URL 与是否接 LLM，问的是环境变量名而不是 key', async () => {
    const asked: string[] = [];
    const answers = ['https://staging.example.com/', 'y', 'deepseek', '', '', ''];
    const code = await init({
      cwd: dir,
      ask: async (question) => {
        asked.push(question);
        return answers.shift() ?? '';
      },
      out: () => undefined,
    });

    expect(code).toBe(0);
    expect(asked.join(' | ')).toContain('url');
    expect(asked.join(' | ')).toContain('接 LLM？');
    expect(asked.join(' | ')).toContain('环境变量名');

    const config = await readFile(join(dir, '.perfpilot.yml'), 'utf8');
    expect(config).toContain('base_url: https://api.deepseek.com');
    expect(config).toContain('api_key_env: DEEPSEEK_API_KEY');
  });
});

/**
 * CI 集成文件的生成。
 *
 * 这一组的重点是那三个**不报错、只是永远不生效**的地方：基线缓存、
 * git 身份、本机地址时的预览服务。手写流水线最容易漏的就是它们。
 */
describe('CI 集成文件', () => {
  it('平台推断：目录痕迹优先，其次看远端', () => {
    expect(detectCiPlatform({ hasGithubDir: true, hasGitlabCi: false, gitRemote: null })).toBe('github');
    expect(detectCiPlatform({ hasGithubDir: false, hasGitlabCi: true, gitRemote: null })).toBe('gitlab');
    expect(
      detectCiPlatform({ hasGithubDir: false, hasGitlabCi: false, gitRemote: 'git@gitlab.com:a/b.git' }),
    ).toBe('gitlab');
    expect(
      detectCiPlatform({ hasGithubDir: false, hasGitlabCi: false, gitRemote: null }),
    ).toBe('none');
  });

  it('GitHub：基线缓存、git 身份、门禁退出码都在', () => {
    const plan = buildCiPlan({
      platform: 'github',
      delivery: 'package',
      packageManager: 'npm',
      url: 'https://staging.example.com/',
      preview: null,
      perfpilotRepo: null,
      cliPackage: '@yuki-byte18/cli',
    });

    expect(plan.path).toBe('.github/workflows/perfpilot.yml');
    // 基线：不缓存就永远测不出回归
    expect(plan.content).toContain('path: .perfpilot');
    expect(plan.content).toContain('restore-keys');
    // git 身份：缺了它"保留改动"会静默失败
    expect(plan.content).toContain('git config user.email');
    // 门禁决定退出码
    expect(plan.content).toContain('npx perfpilot run --ci --url https://staging.example.com/');
    // 报告在失败时也要上传
    expect(plan.content).toContain('if: always()');
    // 包模式要提醒把 CLI 加进 devDependencies
    expect(plan.prerequisite).toContain('npm i -D @yuki-byte18/cli');
  });

  it('checkout 模式：先装 Node 再构建 PerfPilot（顺序错了就得靠 runner 预装的 Node）', () => {
    const plan = buildCiPlan({
      platform: 'github',
      delivery: 'checkout',
      packageManager: 'npm',
      url: 'https://staging.example.com/',
      preview: null,
      perfpilotRepo: null,
      cliPackage: '@yuki-byte18/cli',
    });

    const setupNode = plan.content.indexOf('actions/setup-node');
    const buildPerfpilot = plan.content.indexOf('构建 PerfPilot');
    expect(setupNode).toBeGreaterThan(-1);
    expect(buildPerfpilot).toBeGreaterThan(setupNode);
    // 不知道仓库地址时要留一个显眼的占位符，而不是编一个
    expect(plan.content).toContain('CHANGE_ME/perfPilot-agent');
  });

  it('本机地址：自动带上"起预览服务 + 等它就绪"', () => {
    const plan = buildCiPlan({
      platform: 'github',
      delivery: 'package',
      packageManager: 'npm',
      url: 'http://127.0.0.1:4173/',
      preview: { script: 'preview', port: '4173' },
      perfpilotRepo: null,
      cliPackage: '@yuki-byte18/cli',
    });

    expect(plan.content).toContain('npm run preview -- --port 4173');
    expect(plan.content).toContain('curl -sf http://127.0.0.1:4173');
  });

  it('GitLab：只写 ci/perfpilot.yml、缓存整个 .perfpilot/、要求 include', () => {
    const plan = buildCiPlan({
      platform: 'gitlab',
      delivery: 'package',
      packageManager: 'pnpm',
      url: 'https://staging.example.com/',
      preview: null,
      perfpilotRepo: null,
      cliPackage: '@yuki-byte18/cli',
    });

    // 绝不写 .gitlab-ci.yml：那是用户自己的流水线
    expect(plan.path).toBe('ci/perfpilot.yml');
    expect(plan.instruction).toContain('include:');
    // 缓存整个 .perfpilot/，而不是只有 memory.db —— 基线在 runs/ 里
    expect(plan.content).toContain('      - .perfpilot/');
    expect(plan.content).not.toContain('- .perfpilot/memory.db');
    expect(plan.content).toContain('pnpm install --frozen-lockfile');
    expect(plan.content).toContain('rules:');
  });

  it('init 端到端：检测到 GitHub 就写文件；已存在时不覆盖', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'perfpilot-ci-'));
    try {
      await mkdir(join(projectDir, '.github'), { recursive: true });
      await writeFile(
        join(projectDir, 'package.json'),
        JSON.stringify({ name: 'demo', scripts: { build: 'vite build', preview: 'vite preview' } }),
        'utf8',
      );

      const code = await init({
        cwd: projectDir,
        yes: true,
        url: 'http://127.0.0.1:4173/',
        out: () => undefined,
      });

      expect(code).toBe(0);
      const workflow = await readFile(
        join(projectDir, '.github', 'workflows', 'perfpilot.yml'),
        'utf8',
      );
      expect(workflow).toContain('run --ci --url http://127.0.0.1:4173/');
      // 本机地址 → 流水线自己起服务
      expect(workflow).toContain('preview -- --port 4173');

      // 第二次运行不该覆盖（可能是用户手改过的）
      await writeFile(join(projectDir, '.github', 'workflows', 'perfpilot.yml'), '# 我改过的\n', 'utf8');
      await init({
        cwd: projectDir,
        yes: true,
        force: true,
        url: 'http://127.0.0.1:4173/',
        out: () => undefined,
      });
      // --force 会覆盖配置与 CI 文件（这里只验 CI 文件确实是新的）
      const after = await readFile(join(projectDir, '.github', 'workflows', 'perfpilot.yml'), 'utf8');
      expect(after).toContain('PerfPilot 性能门禁');
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('--ci none 明确表示不要：一个文件都不写', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'perfpilot-ci-off-'));
    try {
      await mkdir(join(projectDir, '.github'), { recursive: true });
      await writeFile(join(projectDir, 'package.json'), JSON.stringify({ name: 'demo' }), 'utf8');

      await init({
        cwd: projectDir,
        yes: true,
        ci: 'none',
        url: 'https://x.example.com/',
        out: () => undefined,
      });

      const exists = await readFile(join(projectDir, '.github', 'workflows', 'perfpilot.yml'), 'utf8')
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
