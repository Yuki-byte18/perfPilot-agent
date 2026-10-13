/**
 * `perfpilot init` 里的 LLM 选项。
 *
 * ## 一条不可让步的规则：key 不进配置文件
 *
 * `.perfpilot.yml` 是要提交进 git 的（它是项目配置的一部分）。
 * 把 API key 写进去等于把密钥写进 git 历史 —— 而历史是很难彻底抹掉的，
 * 一次误提交就要轮换密钥。
 *
 * 因此配置里只存**环境变量的名字**（`api_key_env`），值留在环境里。
 * `init` 也遵循这条：它问的是"从哪个环境变量读"，绝不问 key 本身，
 * 更不会把它写进任何文件。
 */

export type LlmProviderName = 'deepseek' | 'openai' | 'anthropic';

/** 写进配置的 LLM 选择 */
export interface LlmChoice {
  provider: 'openai' | 'anthropic';
  /** OpenAI 兼容服务的入口；不填走 SDK 默认 */
  baseUrl: string | null;
  model: string;
  /** 读 key 的环境变量名 —— **不是** key 本身 */
  apiKeyEnv: string;
  maxCostUsd: number;
}

export interface LlmPreset {
  name: LlmProviderName;
  label: string;
  choice: LlmChoice;
  /** 需要在 PerfPilot 仓库里执行的安装命令（SDK 是可选依赖） */
  sdkPackages: string;
}

/**
 * 常见服务商的预设。
 *
 * `deepseek` 映射成 `provider: openai` + `base_url` —— 它用的是 OpenAI 兼容接口，
 * 因此不需要为它在 schema 里多加一个枚举值（DeepSeek / Qwen / GLM / vLLM / Ollama
 * 全是这一条路）。
 */
export const LLM_PRESETS: readonly LlmPreset[] = [
  {
    name: 'deepseek',
    label: 'DeepSeek（OpenAI 兼容）',
    choice: {
      provider: 'openai',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      maxCostUsd: 2,
    },
    sdkPackages: '@ai-sdk/openai',
  },
  {
    name: 'openai',
    label: 'OpenAI',
    choice: {
      provider: 'openai',
      baseUrl: null,
      model: 'gpt-4o-mini',
      apiKeyEnv: 'OPENAI_API_KEY',
      maxCostUsd: 2,
    },
    sdkPackages: '@ai-sdk/openai',
  },
  {
    name: 'anthropic',
    label: 'Anthropic',
    choice: {
      provider: 'anthropic',
      baseUrl: null,
      model: 'claude-3-5-haiku-latest',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      maxCostUsd: 2,
    },
    sdkPackages: '@ai-sdk/anthropic',
  },
];

export function presetOf(name: string): LlmPreset | null {
  return LLM_PRESETS.find((preset) => preset.name === name) ?? null;
}

/**
 * 装可选依赖的命令。
 *
 * 必须带 `--filter @yuki-byte18/core`：pnpm 的 node_modules 是严格的，
 * 装在仓库根目录时 core 里的 `import('ai')` 解析不到它 ——
 * 表现是"配了 key 但 LLM 始终降级为空"，而错误信息只说 SDK 加载失败。
 */
export function sdkInstallCommand(pkg: string): string {
  return `pnpm --filter @yuki-byte18/core add ai ${pkg}`;
}

/** 按平台给出设置环境变量的命令（只是提示，init 不会去设置它） */
export function envHintCommand(envName: string): string {
  return process.platform === 'win32'
    ? `$env:${envName} = "<你的 key>"`
    : `export ${envName}=<你的 key>`;
}
