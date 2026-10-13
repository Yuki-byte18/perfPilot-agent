// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * 依赖边界强制（硬约束 2/3/4/5/6/7/12）。
 *
 * 违反边界的 import 在这里**构建期报错**，而不是靠代码评审发现。
 * 反向依赖、循环依赖、core 直连具体 adapter、core 内调用外部工具 —— 全部拦在这里。
 *
 * 注：循环依赖由 `pnpm cycles`（madge --circular）强制，见 README §4.2。
 */

const src = (pkg) => [`packages/${pkg}/src/**/*.ts`];

/** 上层包：下层不得反向 import */
const UPPER_LAYERS = ['@yuki-byte18/cli', '@yuki-byte18/server', '@yuki-byte18/web'];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/.perfpilot/**',
      '**/*.d.ts',
      // 演示项目（scripts/demo-setup.mjs 生成）：它有自己的 git 仓库与源码，
      // 不属于本仓库的源码集合，也不该被本仓库的 tsconfig 覆盖
      '.demo/**',
    ],
  },

  js.configs.recommended,
  // tseslint 的 recommended 默认不带 files 限定，会作用到 .js（含 eslint.config.js）；
  // 显式限定到 TS，避免给非 TS 文件套上类型感知规则。
  // **必须带上 .tsx**：报告页是 React 组件，漏了的话整个 web 包一条规则都不生效。
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['**/*.ts', '**/*.tsx'],
  })),

  {
    name: 'perfpilot/base-ts',
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // 硬约束 12：统一 pino 日志，禁止 console（CLI 用户输出走 reporter）
      'no-console': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // ── shared：不依赖任何内部包 ────────────────────────────────────────
  {
    name: 'perfpilot/boundary-shared',
    files: src('shared'),
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@yuki-byte18/*', '!@yuki-byte18/shared', '!@yuki-byte18/shared/*'],
              message: 'shared 是底层包，不得依赖任何其它 @yuki-byte18 包（硬约束 2）。',
            },
          ],
        },
      ],
    },
  },

  // ── adapters：只依赖 shared ────────────────────────────────────────
  {
    name: 'perfpilot/boundary-adapters',
    files: src('adapters'),
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@yuki-byte18/core', '@yuki-byte18/core/*', ...UPPER_LAYERS, ...UPPER_LAYERS.map((p) => `${p}/*`)],
              message: 'adapters 只能依赖 @yuki-byte18/shared（硬约束 2：shared ← adapters）。',
            },
            {
              group: ['@yuki-byte18/adapters', '@yuki-byte18/adapters/*'],
              message: 'adapters 内部请用相对路径 import，不要自引用包名。',
            },
          ],
        },
      ],
    },
  },

  // ── core：只能 type-only 引用 adapters，不得直连具体 adapter ─────────
  {
    name: 'perfpilot/boundary-core',
    files: src('core'),
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: UPPER_LAYERS.flatMap((p) => [p, `${p}/*`]),
              message: 'core 不得依赖上层包（硬约束 3：core ← cli/server）。',
            },
            {
              // 硬约束 4：只允许 `import type` 取注册表类型，禁止任何运行时引用
              group: ['@yuki-byte18/adapters', '@yuki-byte18/adapters/*'],
              allowTypeImports: true,
              message:
                'core 只能 type-only 引用 @yuki-byte18/adapters 的注册表类型；具体 adapter 一律通过 shared 的端口注入（硬约束 4）。',
            },
            {
              group: ['node:child_process', 'child_process', 'node:worker_threads'],
              message:
                'core 不得直接调用外部进程，所有外部工具调用必须走 adapter（硬约束 5）。',
            },
            {
              group: ['@ai-sdk/*', 'ai', 'openai', '@anthropic-ai/*', 'undici', 'axios', 'node-fetch'],
              message: '所有 LLM 调用必须经过 core/llm（硬约束 6）。',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message: 'core 不得直接发起网络请求，所有外部调用必须走 adapter（硬约束 5）。',
        },
      ],
    },
  },

  // core/llm 是唯一允许接触 LLM SDK 的地方
  {
    name: 'perfpilot/llm-gateway',
    files: ['packages/core/src/llm/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: UPPER_LAYERS.flatMap((p) => [p, `${p}/*`]),
              message: 'core 不得依赖上层包（硬约束 3）。',
            },
            {
              group: ['@yuki-byte18/adapters', '@yuki-byte18/adapters/*'],
              allowTypeImports: true,
              message: 'core 只能 type-only 引用 adapters（硬约束 4）。',
            },
          ],
        },
      ],
    },
  },

  // 硬约束 7：决策层不得调用 LLM
  {
    name: 'perfpilot/decision-no-llm',
    files: ['packages/core/src/decision/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/llm/*', '**/llm', '@yuki-byte18/core/llm', '@ai-sdk/*', 'ai', 'openai'],
              message: '决策层禁止调用 LLM：决策必须确定性、可复现、可测试（硬约束 7）。',
            },
          ],
        },
      ],
    },
  },

  // ── web：只依赖 shared 的类型 ───────────────────────────────────────
  {
    name: 'perfpilot/boundary-web',
    files: ['packages/web/src/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@yuki-byte18/core',
                '@yuki-byte18/core/*',
                '@yuki-byte18/adapters',
                '@yuki-byte18/adapters/*',
                '@yuki-byte18/cli',
                '@yuki-byte18/server',
              ],
              message: 'web 只允许依赖 @yuki-byte18/shared 的类型（硬约束 2）。',
            },
            {
              /**
               * M8 验收 2 的原话是「web 只 `import type` from @yuki-byte18/shared」。
               * `allowTypeImports` 才能把这句话变成机械检查：`import type` 放行，
               * 任何值导入报错 —— 一个值导入（哪怕只是一个常量数组）会把 core 的
               * 运行时一起拖进浏览器产物。
               */
              group: ['@yuki-byte18/shared', '@yuki-byte18/shared/*'],
              allowTypeImports: true,
              message:
                'web 只能 `import type` from @yuki-byte18/shared：值导入会把后端的运行时拖进浏览器产物（M8 验收 2）。',
            },
          ],
        },
      ],
    },
  },

  // Node 脚本（.mjs）：不经 TS 编译，需要显式声明 Node 全局量
  {
    name: 'perfpilot/node-scripts',
    files: ['**/*.mjs', 'scripts/**/*.js'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        __dirname: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // 脚本要往终端说话；这条规则针对的是产品代码（硬约束 12：统一 pino 日志）
      'no-console': 'off',
    },
  },

  // 测试文件：放宽，但仍禁止跨层 import
  {
    name: 'perfpilot/tests',
    files: [
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/__tests__/**/*.ts',
      '**/fixtures/**/*.ts',
      'vitest.config.ts',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
