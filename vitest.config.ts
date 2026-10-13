import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // 直接从源码解析，测试无需先 build（构建期仍由 tsc 产出 dist）
    alias: {
      '@yuki-byte18/shared': pkg('shared'),
      '@yuki-byte18/adapters': pkg('adapters'),
      '@yuki-byte18/core': pkg('core'),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    // `.tsx` 必须显式带上：报告页的测试用 react-dom/server 出字符串来验三态，
    // 漏掉的话它们会被静默跳过 —— 覆盖率照常算，测试却一个都没跑
    include: ['packages/*/src/**/*.test.ts', 'packages/*/src/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**/*.ts', 'packages/*/src/**/*.tsx'],
      exclude: [
        // 测试自身与 fixture 不是被测对象
        'packages/*/src/**/*.test.ts',
        'packages/*/src/**/*.test.tsx',
        'packages/*/src/fixtures/**',
        // 类型与端口是纯声明，运行时不存在，不应计入覆盖率分母
        'packages/*/src/**/types/**',
        'packages/*/src/**/ports/**',
        // barrel 文件与组合根：纯 wiring，无逻辑可测（README 自检项 #2）
        'packages/*/src/index.ts',
        'packages/adapters/src/registry.ts',
        'packages/cli/src/index.ts',
        'packages/cli/src/main.ts',
        // 报告页的入口：挂载根节点，没有可断言的行为（组件本身已覆盖）
        'packages/web/src/main.tsx',
        // Lighthouse runner 需要真实 Chrome 才能走到落盘那一步。
        // 它的失败路径（工具不存在 → AdapterError）由 runners.test.ts 覆盖；
        // 解析侧完全由 parse.test.ts + lighthoust fixtures 覆盖。
        // bundle-analyzer / web-vitals 的 runner 不做排除 —— 它们只碰文件系统，
        // 用临时目录能真实测，没理由放行。
        'packages/adapters/src/lighthouse/runner.ts',
      ],
      // 硬约束 13
      thresholds: {
        lines: 70,
        statements: 70,
        functions: 70,
        branches: 70,
      },
    },
  },
});
