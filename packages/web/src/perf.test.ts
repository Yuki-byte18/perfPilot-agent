import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * 报告页自身的性能预算（M8 验收 3）。
 *
 * ## 先说清楚这一组**没有**验什么
 *
 * 验收原文是「LCP < 2.5s，无布局抖动」。**这个数字没有被真实测量过** ——
 * 它需要在真实 Chrome 里跑 Lighthouse，而本项目的采集环境里没有 Chrome
 * （见 M1 的验收记录：Lighthouse 不可用时链路降级）。
 * 用假的数字交差比不测更糟，因此这里不编数字。
 *
 * ## 这一组验的是"决定 LCP 与 CLS 的那些结构"
 *
 * LCP 与 CLS 在一个**没有图片、没有第三方脚本、没有 web font**的静态页面上，
 * 基本由三件事决定，而这三件事都可以静态检查：
 *
 * 1. **首屏渲染是否被阻塞** —— 外链 CSS / `@import` / web font 都会阻塞或推迟首帧
 * 2. **加载后是否发生重排** —— 骨架屏尺寸与实际内容不一致、JS 创建挂载点，都会顶动布局
 * 3. **传输体积** —— JS 是这一页唯一的大块资源
 *
 * 因此这是一个**回归护栏**，不是一次性能测量：只要有人往这一页里塞一个
 * 图表库、一个 web font 或一个外链样式表，这里会红。
 */

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..');
const indexHtml = readFileSync(join(webRoot, 'index.html'), 'utf8');
const styles = readFileSync(join(here, 'styles.css'), 'utf8');
const packageJson = JSON.parse(readFileSync(join(webRoot, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

/** index.html 里的内联关键样式：首屏依赖的令牌与骨架都在这一段 */
const criticalCss = /<style>([\s\S]*?)<\/style>/.exec(indexHtml)?.[1] ?? '';

describe('M8 验收 3 — 首屏不被阻塞', () => {
  it('关键样式内联在 index.html 里，没有外链样式表', () => {
    // 外链 CSS 是渲染阻塞资源：多一次往返，首帧就晚一次往返
    expect(indexHtml).toContain('<style>');
    expect(indexHtml).not.toMatch(/<link[^>]+rel=["']stylesheet["']/i);
  });

  it('没有 web font（字体是 LCP 与 CLS 的常见元凶）', () => {
    expect(indexHtml).not.toContain('fonts.googleapis');
    expect(indexHtml).not.toContain('@font-face');
    expect(styles).not.toContain('@font-face');
  });

  it('CSS 里没有 @import 与远程 url()（都会引入额外往返）', () => {
    expect(styles).not.toContain('@import');
    expect(styles).not.toMatch(/url\(\s*['"]?https?:/i);
    expect(criticalCss).not.toContain('@import');
  });

  it('声明 color-scheme，避免深色模式下首帧闪白（一次可见跳动）', () => {
    // 令牌定义在内联关键样式里（首屏必须能立刻取到），因此查那里
    expect(criticalCss).toContain('color-scheme');
    expect(indexHtml).toContain('color-scheme');
  });

  it('组件样式引用的每个 CSS 变量都在内联关键样式里有定义', () => {
    /**
     * `styles.css` 是异步加载的，它用的令牌却定义在 index.html 的内联块里 ——
     * 这个分工是对的（首屏先拿到令牌），但**很脆**：
     * 内联块里少一个 `--good`，组件的颜色会静默失效（浏览器不报错，只是不上色）。
     */
    const used = new Set([...styles.matchAll(/var\((--[a-z-]+)/g)].map((m) => m[1]));
    const defined = new Set([...criticalCss.matchAll(/(--[a-z-]+)\s*:/g)].map((m) => m[1]));

    const missing = [...used].filter((name) => !defined.has(name as string));
    expect(missing).toEqual([]);
  });
});

describe('M8 验收 3 — 不产生布局抖动', () => {
  it('挂载点在 HTML 里就存在，而不是由 JS 创建', () => {
    // JS 创建挂载点意味着首帧什么都没有，随后整页内容一次性出现 —— 那是一次巨大的 CLS
    expect(indexHtml).toContain('<div id="root">');
  });

  it('骨架屏的尺寸与真实内容同量级（加载完成时不顶动布局）', () => {
    // 骨架块必须有固定高度：没有高度就是 0 高，加载完成后下方内容整体下移。
    // 骨架是首屏的一部分，因此它的样式在内联关键样式里。
    const skeletonRules = criticalCss.match(/\.skeleton[^{]*\{[^}]*\}/g) ?? [];
    expect(skeletonRules.length).toBeGreaterThan(0);
    expect(skeletonRules.join('\n')).toMatch(/height:\s*\d/);
    // 并且内联样式本身要被压缩过（首屏体积）：不该有大段换行缩进的空白
    expect(criticalCss.length).toBeLessThan(3000);
  });

  it('页面里没有无尺寸的图片或视频', () => {
    // 没有图片是这一页最好的 CLS 策略：不加载就不会有"加载后才发现要占位"
    expect(indexHtml).not.toMatch(/<img\b/i);
    expect(indexHtml).not.toMatch(/<video\b/i);
  });
});

describe('M8 验收 3 — 体积预算', () => {
  it('运行时不装任何依赖（报告页是预构建产物）', () => {
    /**
     * 这一页发给用户的是**构建好的 `dist/`**（React 已经打进 bundle 里），
     * 因此 `@yuki-byte18/cli` 的安装不该为了一个静态报告页再拉一遍 react/react-dom。
     * React 因此位于 devDependencies：它参与构建，但不参与安装。
     */
    expect(Object.keys(packageJson.dependencies ?? {})).toEqual([]);
  });

  it('构建期依赖只有白名单里的这些（图表库 / UI 框架进不来）', () => {
    /**
     * 这条是**预算的执行手段**：155KB（gzip 51KB）里绝大部分是 React 本身，
     * 再加一个图表库或组件库就会翻倍，而那正是 LCP 会破的地方。
     *
     * 名单收在 devDependencies 上比收在 dependencies 上更严 ——
     * 一个塞进 devDependencies 的图表库同样会被打进 bundle，
     * 以前那种写法看不见它。要加新的构建期依赖，就得先改这份名单，
     * 也就是先想清楚它对首屏的价值。
     */
    // 顺序是默认 sort() 的 UTF-16 码位序：`@types/…` 排在 `@yuki-byte18/…` 前面（t < y），
    // 改 scope 名时这一行会跟着变 —— 那不是断言失败的理由，是被断言顺序坑了。
    expect(Object.keys(packageJson.devDependencies ?? {}).sort()).toEqual([
      '@types/react',
      '@types/react-dom',
      '@yuki-byte18/shared',
      'react',
      'react-dom',
      'vite',
    ]);
  });

  it('构建产物在预算内（构建过才检查）', () => {
    const distIndex = join(webRoot, 'dist', 'index.html');
    if (!existsSync(distIndex)) {
      // 没构建就跳过**这一条断言**，但不跳过整个文件 ——
      // 上面的结构检查不依赖构建，任何时候都该跑
      expect(existsSync(distIndex)).toBe(false);
      return;
    }

    const distHtml = readFileSync(distIndex, 'utf8');
    const assets = [...distHtml.matchAll(/(?:src|href)="\.?\/?assets\/([^"]+)"/g)].map((m) => m[1]);
    expect(assets.length).toBeGreaterThan(0);

    let totalBytes = 0;
    for (const asset of assets) {
      const file = join(webRoot, 'dist', 'assets', asset as string);
      expect(existsSync(file)).toBe(true);
      totalBytes += statSync(file).size;
    }

    // 300KB 的未压缩预算：这是这一页"还能算快"的上限
    expect(totalBytes).toBeLessThan(300 * 1024);
  });
});
