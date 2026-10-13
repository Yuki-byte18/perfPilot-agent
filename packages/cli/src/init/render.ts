import type { VerifiableCheckKind } from '@yuki-byte18/shared';
import type { ProjectFacts } from './detect.js';
import type { LlmChoice } from './llm.js';

/**
 * 把检测到的事实渲染成 `.perfpilot.yml`。
 *
 * 两条刻意设计：
 *
 * 1. **每一项都带注释**。用户拿到的不该是一份"能跑但看不懂"的配置 ——
 *    他迟早要改它，而"为什么这里是 4173 而不是 5173"这类信息只有生成它的
 *    那一刻知道。
 * 2. **检测不到的地方留 `TODO`，不编默认值**。例如 git remote 为空时写 `repo: ''`
 *    并注明"填上才能发 MR 评论"；而不是编一个看起来像真的地址。
 */

const CHECK_LABEL: Record<VerifiableCheckKind, string> = {
  build: '构建',
  'unit-test': '单测',
  'type-check': '类型检查',
  lint: 'lint',
  e2e: 'E2E',
};

export interface RenderInput {
  facts: ProjectFacts;
  /** 测量地址（用户回答或 `--url` 给出） */
  url: string;
  routes: readonly string[];
  /** 生成时间，只进注释 */
  generatedAt: string;
  /** LLM 选择；不传表示不接（provider: none） */
  llm?: LlmChoice | undefined;
}

export function renderConfig(input: RenderInput): string {
  const { facts, url, routes } = input;
  const lines: string[] = [];

  lines.push(
    '# PerfPilot 配置',
    `# 由 \`perfpilot init\` 于 ${input.generatedAt} 生成，字段值来自这个项目的实际状态。`,
    '#',
    '# 这个文件会被 zod **严格**校验：键名写错（例如 minGain 而不是 min_gain）会在',
    '# 启动时报错（退出码 2），而不是被静默忽略后用默认值跑完一整轮 CI。',
    '# 完整字段说明见 .perfpilot.yml.example',
    '',
  );

  lines.push('project:');
  lines.push(`  name: ${yaml(facts.name)}`);
  lines.push("  root: '.'");
  lines.push('');

  lines.push('target:');
  lines.push('  # 测的是这个地址：建议指向**预览/预发**环境。');
  lines.push('  # ⚠️ 指向 dev server 时，LCP/传输体积反映的是"未打包的源码"，');
  lines.push('  #    同一份代码与构建产物的差距可以到十倍 —— 那种数字不能用来定门禁。');
  lines.push(`  url: ${yaml(url)}`);
  lines.push('  routes:');
  for (const route of routes) lines.push(`    - ${yaml(route)}`);
  if (facts.repo === '') {
    lines.push("  # TODO: 填上仓库地址（如 https://github.com/org/repo）后才能发 MR 评论");
    lines.push("  repo: ''");
  } else {
    lines.push(`  repo: ${yaml(facts.repo)}   # 来自 git remote`);
  }
  lines.push(`  branch: ${yaml(facts.branch)}   # 来自当前分支`);
  lines.push('');

  lines.push('baseline:');
  lines.push('  # 默认和**同一路由同一设备的上一次运行**比。');
  lines.push('  # 首次运行没有基线，所有指标会显示为「不可比」而不是「持平」。');
  lines.push('  ref: last-run');
  lines.push('  # 绝对阈值（评级与 threshold:* 检查用），留空则用内置规格：');
  lines.push('  #   metrics:');
  lines.push('  #     LCP: { warning: 2500, error: 4000 }');
  lines.push('  metrics: {}');
  lines.push('');

  lines.push('# 三个白名单都留空 = 不做限制（任何分级都允许走到它自己的上限）');
  lines.push('optimization: {}');
  lines.push('');

  lines.push('decision:');
  lines.push('  # 纯函数效用模型；关掉它一律只出建议（保守开关）');
  lines.push('  jev: true');
  lines.push('');

  lines.push('report:');
  lines.push("  format: [markdown, json]   # 加 html 可得到一份自带样式的单文件报告");
  lines.push('  comment_mr: false          # 需要 GITHUB_TOKEN / GITLAB_TOKEN');
  lines.push('  auto_pr: false             # 需要 contents: write 权限');
  lines.push('');

  lines.push('collect:');
  lines.push('  timeoutMs: 120000');
  lines.push('  runs: 1                    # >1 时逐指标取中位数降噪（时间线性增加）');
  lines.push('');

  lines.push('');
  lines.push('# 验证阶段跑的检查。只列出这个项目**真实存在**的脚本：');
  lines.push('# 不存在的项不会写进来，也就不会被记成「未通过」而把优化回滚掉。');
  lines.push('checks:');
  lines.push(`  package_manager: ${facts.packageManager}   # 由 lockfile 判断`);
  const kinds = Object.keys(facts.scripts) as VerifiableCheckKind[];
  lines.push(`  kinds: [${kinds.join(', ')}]`);
  if (kinds.length === 0) {
    lines.push('  # 这个项目没有可识别的检查脚本 —— 验证阶段会全部跳过，');
    lines.push('  # 改动能否保留就只看指标收益了');
  } else {
    lines.push('  scripts:');
    for (const kind of kinds) {
      lines.push(`    ${kind}: ${yaml(facts.scripts[kind] ?? '')}   # ${CHECK_LABEL[kind]}`);
    }
  }
  lines.push('');

  lines.push('memory:');
  lines.push('  driver: sqlite');
  lines.push('  url: .perfpilot/memory.db');
  lines.push('');

  lines.push('# LLM（诊断 agent + 方案生成）。');
  if (input.llm === undefined) {
    lines.push('# provider: none = 一次调用都不会发生，也不花钱。');
    lines.push('# 想接的话（DeepSeek / OpenAI / Anthropic 都支持）：');
    lines.push('#   perfpilot init --force --llm deepseek');
    lines.push('llm:');
    lines.push('  provider: none');
  } else {
    const { llm } = input;
    lines.push('# ⚠️ 这里存的是**环境变量的名字**，不是 key 本身：');
    lines.push('# 这个文件会进 git，把 key 写进来等于把密钥写进历史。');
    lines.push('llm:');
    lines.push(`  provider: ${llm.provider}${llm.baseUrl === null ? '' : '   # OpenAI 兼容服务'}`);
    if (llm.baseUrl !== null) {
      lines.push(`  base_url: ${yaml(llm.baseUrl)}   # 不填会固定打 api.openai.com`);
    }
    lines.push(`  model: ${yaml(llm.model)}`);
    lines.push(`  api_key_env: ${yaml(llm.apiKeyEnv)}`);
    lines.push(`  maxCostUsd: ${llm.maxCostUsd}   # 单轮累计上限（诊断 + 方案共用）`);
    lines.push('  plan_mode: always    # 对每个瓶颈都出候选（fallback = 只在规则弃权时才问）');
    lines.push('  diagnose: true       # 诊断 agent：读原始证据做归因复核与补充');
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * 渲染一个 YAML 标量。
 *
 * 需要引号时用 `JSON.stringify`（它的双引号转义规则与 YAML 的双引号标量兼容），
 * 其余情况裸写 —— 生成的配置是给人读的，`url: "http://..."` 那种引号没必要。
 */
export function yaml(value: string): string {
  const bare = /^[A-Za-z0-9_./:@+-]+$/.test(value);
  // 这些裸写在 YAML 里会被解析成布尔/null/数字，必须加引号
  const reserved = /^(true|false|null|yes|no|on|off|~)$/i.test(value) || /^[+-]?\d+(\.\d+)?$/.test(value);
  if (bare && !reserved) return value;
  return JSON.stringify(value);
}

/**
 * 一条要写进 `.gitignore` 的规则。
 *
 * `why` 不是装饰：`.gitignore` 是后来人唯一能看到"这行为什么存在"的地方，
 * 而下面这几条一旦被谁删掉，症状是"工具跑得好好的，但从来不优化" —— 极难反推。
 */
export interface GitignoreEntry {
  pattern: string;
  why: string;
}

/**
 * `existing` 里**还没被覆盖**的条目。
 *
 * 判"覆盖"是逐行比的，并且认**上层目录**：写了 `tools/` 就不必再写
 * `tools/perfpilot/`。不做这层判断的话，用户每次跑 `init` 都会被追加一行
 * 他已经等价写过的规则。
 */
export function missingGitignoreEntries(
  existing: string,
  entries: readonly GitignoreEntry[],
): GitignoreEntry[] {
  const rules = existing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => line.replace(/^\/+/, '').replace(/\/+$/, ''));

  return entries.filter((entry) => {
    const target = entry.pattern.replace(/^\/+/, '').replace(/\/+$/, '');
    return !rules.some((rule) => rule === target || target.startsWith(`${rule}/`));
  });
}

/**
 * `.gitignore` 的补充内容：只写缺的那些，每条都带理由。
 *
 * **这一步不是可选的便利**：漏了哪一条，第一次运行就会把工作区弄脏，
 * 而改动守卫会因此拒绝应用任何补丁 —— 表现是"跑得好好的，但从来不优化"，
 * 告警里写的原因却是"工作区不干净"，指向的是用户自己的代码改动。
 */
export function gitignorePatch(existing: string, entries: readonly GitignoreEntry[]): string {
  const missing = missingGitignoreEntries(existing, entries);
  if (missing.length === 0) return '';

  const needsLeadingNewline = existing !== '' && !existing.endsWith('\n');
  const blocks = missing.map((entry) => `# ${entry.why}\n${entry.pattern}`);
  return `${needsLeadingNewline ? '\n' : ''}\n${blocks.join('\n\n')}\n`;
}
