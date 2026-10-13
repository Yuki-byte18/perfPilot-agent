/**
 * `perfpilot init --ci` —— 生成 CI 集成文件。
 *
 * ## 为什么这件事该由 init 做
 *
 * 手写性能门禁的 CI 文件，最容易错的恰好是三个**不报错、只是永远不生效**的地方：
 *
 * 1. **基线没被缓存** —— `.perfpilot/` 是基线的载体。不缓存的话，每条流水线都是
 *    "首次运行"，`regression` 检查永远通过，门禁只剩绝对阈值。
 * 2. **没配 git 身份** —— "保留改动" = `git commit`。裸容器里缺 committer 身份时
 *    提交**静默失败**（只记一条 warning），改动留在工作区、job 一结束就没了。
 * 3. **测量地址是 localhost 却没起预览服务** —— 采集会以"页面打不开"告终，
 *    而报告里写的是"数据源不可用"。
 *
 * 这三件事的答案 `init` 都已经知道（包管理器、测量地址、预览脚本），
 * 让用户手抄一遍等于把这些坑重新埋一遍。
 *
 * ## 三条安全边界
 *
 * - **GitHub**：只写新文件 `.github/workflows/perfpilot.yml`；已存在则拒绝（除非 `--force`）。
 * - **GitLab**：**绝不修改 `.gitlab-ci.yml`** —— 那是用户自己的流水线，
 *   合并别人的 job 进去是最容易出事的地方。改为写 `ci/perfpilot.yml`，
 *   让用户自己加两行 `include: local:`。
 * - 不做任何 git 操作、不改 `package.json`：init 只生成文件 + 打印下一步。
 */

export type CiPlatform = 'github' | 'gitlab' | 'none';

/**
 * PerfPilot 自己怎么进到 CI 里。
 *
 * - `package`：从 npm 装（`npx perfpilot`）—— 发布之后的正常形态
 * - `checkout`：CI 里再检出一次 PerfPilot 源码并构建 —— 还没发布时的过渡形态
 *
 * 由 CLI **自身所在位置**推断（在 `node_modules/` 里就是装出来的），
 * 因此用户拿到的是与他当前用法一致的那份文件。
 */
export type CiDelivery = 'package' | 'checkout';

export interface CiInput {
  platform: Exclude<CiPlatform, 'none'>;
  delivery: CiDelivery;
  packageManager: 'pnpm' | 'npm' | 'yarn' | 'bun';
  url: string;
  /** 测量地址是本机时，需要 CI 起来一个预览服务 */
  preview: { script: string; port: string } | null;
  /** checkout 模式：PerfPilot 仓库地址（不知道时留占位符让人改） */
  perfpilotRepo: string | null;
  /** npm 包名（package 模式用） */
  cliPackage: string;
}

export interface CiPlan {
  /** 相对仓库根的文件路径 */
  path: string;
  content: string;
  /** 写完之后要告诉用户的事（GitLab 需要 include，GitHub 直接可用） */
  instruction: string;
  /** 必须由用户手动做的前置（没有则为 null） */
  prerequisite: string | null;
}

/** 从项目痕迹推断平台：目录标记优先，其次看远端地址 */
export function detectCiPlatform(input: {
  hasGithubDir: boolean;
  hasGitlabCi: boolean;
  gitRemote: string | null;
}): CiPlatform {
  if (input.hasGithubDir) return 'github';
  if (input.hasGitlabCi) return 'gitlab';

  const remote = (input.gitRemote ?? '').toLowerCase();
  if (remote.includes('gitlab')) return 'gitlab';
  if (remote.includes('github')) return 'github';

  // 认不出来就说认不出来：生成一份放错平台的流水线比不生成更糟
  return 'none';
}

export function buildCiPlan(input: CiInput): CiPlan {
  return input.platform === 'github' ? githubPlan(input) : gitlabPlan(input);
}

// ─────────────────────────────────────────────────────────────────────
// GitHub Actions
// ─────────────────────────────────────────────────────────────────────

/**
 * `checkout` 形态下，PerfPilot 源码被检出到的目录。
 *
 * 两个平台的模板共用这一个路径，而它**就在被测仓库里面** —— 所以 `init`
 * 必须把它写进 `.gitignore`（见 `commands/init.ts`）。两边共用一个常量，
 * 是为了让"模板改路径、忽略规则没跟着改"这种事故不可能发生。
 */
export const PERFPILOT_CHECKOUT_DIR = 'tools/perfpilot';

function githubPlan(input: CiInput): CiPlan {
  const install = installCommand(input.packageManager);

  const setupNode = [
    '      - uses: actions/setup-node@v4',
    '        with:',
    '          # sqlite 记忆层要 Node ≥ 22.5',
    '          node-version: 22',
    ...(input.packageManager === 'pnpm' ? ['          cache: pnpm'] : []),
  ];

  const checkoutPerfpilot =
    input.delivery === 'checkout'
      ? [
          '      - name: 检出 PerfPilot',
          '        uses: actions/checkout@v4',
          '        with:',
          `          repository: ${input.perfpilotRepo ?? 'CHANGE_ME/perfPilot-agent'}` +
            (input.perfpilotRepo === null ? '   # ← 改成你的 PerfPilot 仓库' : ''),
          `          path: ${PERFPILOT_CHECKOUT_DIR}`,
          '',
          '      - name: 构建 PerfPilot',
          `        working-directory: ${PERFPILOT_CHECKOUT_DIR}`,
          '        run: |',
          '          corepack enable',
          '          pnpm install --frozen-lockfile',
          '          pnpm build',
          '',
        ]
      : [];

  const runCommand =
    input.delivery === 'package'
      ? `npx perfpilot run --ci --url ${input.url}`
      : `node ${PERFPILOT_CHECKOUT_DIR}/packages/cli/dist/index.js run --ci --url ${input.url}`;

  const lines = [
    '# PerfPilot 性能门禁 —— GitHub Actions',
    '# 由 `perfpilot init --ci github` 生成。',
    '#',
    '# 三件事，顺序不能换：跑一轮 → 传报告（无论成败）→ 按门禁结论决定成败。',
    '# 上传那步用 `if: always()` 是刻意的：门禁失败时报告才最有用。',
    '',
    'name: PerfPilot 性能门禁',
    '',
    'on:',
    '  pull_request:',
    '    branches: [main]',
    '  push:',
    '    branches: [main]        # main 上也跑一轮：用来刷新基线',
    '  workflow_dispatch:',
    '',
    '# 同一 PR 连续推送时取消上一次：两个 job 同时跑会互相抢 CPU，',
    '# 测出来的数字反映的是机器负载而不是页面性能',
    'concurrency:',
    '  group: perfpilot-${{ github.ref }}',
    '  cancel-in-progress: true',
    '',
    'permissions:',
    '  contents: write           # 保留改动要提交；auto_pr 要推分支',
    '  pull-requests: write      # report.comment_mr 要发评论',
    '',
    'jobs:',
    '  perfpilot:',
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 30',
    '',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '        with:',
    '          # 回滚要 reset --hard 到基线 ref，浅克隆拿不到历史',
    '          fetch-depth: 0',
    '',
    ...setupNode,
    '',
    ...checkoutPerfpilot,
    '      # 保留改动 = git commit。缺 committer 身份时提交会**静默失败**，',
    '      # 改动留在工作区、job 一结束就没了 —— 表现是"保留了但什么也没留下"',
    '      - name: 配置 git 身份',
    '        run: |',
    '          git config user.name "perfpilot"',
    '          git config user.email "perfpilot@local"',
    '',
    '      - name: 安装依赖',
    `        run: ${install}`,
    '',
    '      # Chrome 是 Lighthouse 的硬依赖；不装会退化成"Lighthouse 不可用"，',
    '      # 报告里 LCP/CLS 全缺失 —— 那种绿灯没有意义（ubuntu-latest 自带 Chrome）',
    '      - name: 安装 Lighthouse',
    '        run: npm i -g lighthouse',
    '',
    '      - name: 构建',
    `        run: ${runScript(input.packageManager, 'build')}`,
    '',
    ...githubPreviewSteps(input),
    '      # 基线存在 .perfpilot/ 里。不缓存的话每条流水线都是"首次运行"，',
    '      # regression 检查永远通过 —— 门禁就只剩绝对阈值了',
    '      - name: 恢复 PerfPilot 历史（基线 + 失败记忆）',
    '        uses: actions/cache@v4',
    '        with:',
    '          path: .perfpilot',
    '          key: perfpilot-${{ github.ref_name }}-${{ github.sha }}',
    '          restore-keys: |',
    '            perfpilot-${{ github.ref_name }}-',
    '            perfpilot-main-',
    '',
    '      - name: 跑性能门禁',
    '        id: perfpilot',
    '        continue-on-error: true    # 让后面的上传照常执行，退出码最后单独判',
    '        env:',
    '          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
    `        run: ${runCommand}`,
    '',
    '      - name: 上传报告',
    '        if: always()',
    '        uses: actions/upload-artifact@v4',
    '        with:',
    '          name: perfpilot-report',
    '          path: |',
    '            .perfpilot/runs/**/report.md',
    '            .perfpilot/runs/**/report.html',
    '            .perfpilot/runs/**/gate.json',
    '            .perfpilot/runs/**/mr-comment.md',
    '            .perfpilot/runs/**/patches/',
    '          retention-days: 30',
    '',
    '      - name: 汇总到 job summary',
    '        if: always()',
    '        run: |',
    '          {',
    '            echo "## PerfPilot 性能门禁"',
    '            echo ""',
    '            cat .perfpilot/runs/*/report.md 2>/dev/null || echo "_没有产出报告_"',
    '          } >> "$GITHUB_STEP_SUMMARY"',
    '',
    '      - name: 按门禁结论决定成败',
    "        if: steps.perfpilot.outcome == 'failure'",
    '        run: |',
    '          echo "::error::PerfPilot 门禁未通过，详见 job summary 与 artifact"',
    '          exit 1',
    '',
  ];

  return {
    path: '.github/workflows/perfpilot.yml',
    content: lines.join('\n'),
    instruction:
      '直接生效：推到 GitHub 后，PR 与 main 分支的推送都会自动跑性能门禁。',
    prerequisite:
      input.delivery === 'package'
        ? `把 CLI 加进 devDependencies（版本进 lockfile，才能复现）：${addCommand(input.packageManager, input.cliPackage)}`
        : null,
  };
}

function githubPreviewSteps(input: CiInput): string[] {
  if (input.preview === null) return [];

  return [
    `      # 测量地址是 ${input.url}：CI 里得自己把预览服务起起来`,
    '      - name: 起预览服务',
    '        run: |',
    `          ${runScript(input.packageManager, input.preview.script)} -- --port ${input.preview.port} --strictPort &`,
    '          # 用 curl 轮询而不是 npx wait-on：runner 上不必再下一个小工具',
    `          for i in $(seq 1 30); do curl -sf ${input.url} >/dev/null && break; sleep 1; done`,
    '',
  ];
}

// ─────────────────────────────────────────────────────────────────────
// GitLab CI
// ─────────────────────────────────────────────────────────────────────

function gitlabPlan(input: CiInput): CiPlan {
  const lockfile = lockfileOf(input.packageManager);
  const install = installCommand(input.packageManager);

  const preview =
    input.preview === null
      ? []
      : [
          `    # 测量地址是 ${input.url}：CI 里得自己把预览服务起起来`,
          `    - ${runScript(input.packageManager, input.preview.script)} -- --port ${input.preview.port} --strictPort &`,
          `    - for i in $(seq 1 30); do curl -sf ${input.url} >/dev/null && break; sleep 1; done`,
        ];

  const lines = [
    '# PerfPilot 性能门禁 —— GitLab CI',
    '# 由 `perfpilot init --ci gitlab` 生成。',
    '#',
    '# ⚠️ 我们**没有**改你的 .gitlab-ci.yml。在它里面加两行就能启用：',
    '#',
    '#   include:',
    '#     - local: ci/perfpilot.yml',
    '#',
    '# 这样你的流水线配置仍然完全归你管，升级 PerfPilot 也不会覆盖掉你的改动。',
    '',
    'perfpilot:performance:',
    '  stage: test',
    '  # node ≥ 22.5：sqlite 记忆层用的是 node:sqlite',
    '  image: node:22-bookworm',
    '  timeout: 30m',
    '  # 性能测试会争抢 CPU，同一分支上同时跑两个会让数字失去意义',
    '  interruptible: true',
    '',
    '  cache:',
    '    key:',
    '      files:',
    `        - ${lockfile}`,
    '      prefix: "perfpilot-$CI_COMMIT_REF_SLUG"',
    '    paths:',
    '      # 基线存在 .perfpilot/ 里。只缓存 memory.db 是不够的 ——',
    '      # 那样每条流水线都是"首次运行"，regression 检查永远通过',
    '      - .perfpilot/',
    '',
    '  before_script:',
    `    - ${install}`,
    '    # Chrome 是 Lighthouse 的硬依赖。node 镜像不自带，必须自己装',
    '    - npx --yes playwright install --with-deps chromium || echo "Chrome 安装失败，Lighthouse 将不可用"',
    '    - npm i -g lighthouse || true',
    `    - ${runScript(input.packageManager, 'build')}`,
    ...preview,
    '',
    '  script:',
    ...(input.delivery === 'package'
      ? [`    - npx perfpilot run --ci --url ${input.url}`]
      : [`    - node ${PERFPILOT_CHECKOUT_DIR}/packages/cli/dist/index.js run --ci --url ${input.url}`]),
    '',
    '  artifacts:',
    '    # 门禁失败时报告才最有用，因此必须 always',
    '    when: always',
    '    expire_in: 30 days',
    '    name: "perfpilot-$CI_COMMIT_SHORT_SHA"',
    '    paths:',
    '      - .perfpilot/runs/*/report.md',
    '      - .perfpilot/runs/*/report.html',
    '      - .perfpilot/runs/*/gate.json',
    '      - .perfpilot/runs/*/mr-comment.md',
    '      - .perfpilot/runs/*/patches/',
    '',
    '  rules:',
    '    - if: $CI_PIPELINE_SOURCE == "merge_request_event"',
    '    - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH   # 刷新基线',
    '    - if: $CI_PIPELINE_SOURCE == "web"',
    '',
  ];

  return {
    path: 'ci/perfpilot.yml',
    content: lines.join('\n'),
    instruction:
      '还差一步：在 .gitlab-ci.yml 里加上\n' +
      '       include:\n' +
      '         - local: ci/perfpilot.yml',
    prerequisite:
      input.delivery === 'package'
        ? `把 CLI 加进 devDependencies：${addCommand(input.packageManager, input.cliPackage)}`
        : null,
  };
}

// ─────────────────────────────────────────────────────────────────────
// 包管理器相关的命令片段
// ─────────────────────────────────────────────────────────────────────

function installCommand(pm: CiInput['packageManager']): string {
  switch (pm) {
    case 'pnpm':
      return 'corepack enable && pnpm install --frozen-lockfile';
    case 'yarn':
      return 'corepack enable && yarn install --immutable';
    case 'bun':
      return 'bun install --frozen-lockfile';
    default:
      return 'npm ci';
  }
}

function runScript(pm: CiInput['packageManager'], script: string): string {
  return pm === 'npm' ? `npm run ${script}` : `${pm} run ${script}`;
}

function lockfileOf(pm: CiInput['packageManager']): string {
  switch (pm) {
    case 'pnpm':
      return 'pnpm-lock.yaml';
    case 'yarn':
      return 'yarn.lock';
    case 'bun':
      return 'bun.lockb';
    default:
      return 'package-lock.json';
  }
}

function addCommand(pm: CiInput['packageManager'], pkg: string): string {
  return pm === 'npm' ? `npm i -D ${pkg}` : `${pm} add -D ${pkg}`;
}
