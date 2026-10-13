import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

/**
 * 入口。
 *
 * 刻意不做的事：
 * - **不做路由。** 一个页面，一条 URL。加路由就得处理"刷新 404"，
 *   而报告页是给人扫一眼的，不需要深链接。（真要深链接时，
 *   `?run=<id>` 一个查询参数就够了。）
 * - **不预取全部 run 的指标。** 首屏只请求列表与最近一次，
 *   满足 LCP < 2.5s（验收 3）。跨 run 的趋势按需再拉。
 */

const container = document.getElementById('root');
if (container === null) {
  // 这个页面是静态 HTML + 一个挂载点；拿不到 root 说明 index.html 被人改了，
  // 此时**必须报错**而不是静默什么都不做 —— 否则用户看到一片空白，无从下手
  throw new Error('找不到 #root 挂载点，index.html 可能被改坏了');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
