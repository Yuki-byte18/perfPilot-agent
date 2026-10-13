import { defineConfig } from 'vite';

/**
 * Vite 配置。
 *
 * ## 为什么不用 `@vitejs/plugin-react`
 *
 * 那个插件提供两样东西：Fast Refresh（开发期热更新）与自动 JSX 运行时。
 * 后者 esbuild 本来就支持，一行 `jsx: 'automatic'` 就够 ——
 * 而**生产构建**（`vite build`）完全不需要 Fast Refresh。
 *
 * 代价是 `pnpm dev` 下改组件会整页刷新而不是局部热更。
 * 换来的是一棵更小的依赖树：给一个只读报告页装一个 babel 插件链
 * 并不划算。真需要热更时把插件加回来即可，那时改的也只有这个文件。
 *
 * ## 产物给谁用
 *
 * `perfpilot serve` 会把这个目录（`packages/web/dist`）当静态资源托管，
 * 因此 `base: './'` —— 报告页可能挂在子路径下（`/report/`），
 * 绝对路径的资源引用会 404。
 */
export default defineConfig({
  base: './',
  esbuild: {
    jsx: 'automatic',
  },
  build: {
    outDir: 'dist',
    // 报告页要能塞进 CI artifact 里，体积上限压到 300KB
    chunkSizeWarningLimit: 300,
    sourcemap: false,
  },
});
