/**
 * 把 `target.url` 与 `target.routes` 合成待测地址。
 *
 * 单独抽出来是因为它足够容易写错、又完全没有 IO —— 值得被单测钉死：
 * 尾斜杠重复（`https://a.com//dashboard`）、路由缺前导斜杠（`dashboard`）、
 * 路由已经是绝对 URL、路由带查询串，四种情况都会真实出现在配置里。
 */
export function resolveRouteUrl(baseUrl: string, route: string): string {
  const trimmedRoute = route.trim();
  if (trimmedRoute === '') return baseUrl;

  // 路由写成绝对 URL 时直接采用，允许 `routes` 里混入外部地址
  if (/^https?:\/\//i.test(trimmedRoute)) return trimmedRoute;

  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const path = trimmedRoute.startsWith('/') ? trimmedRoute : `/${trimmedRoute}`;

  return path === '/' ? `${base}/` : `${base}${path}`;
}

/** 路由 → 安全的文件名片段，用于产物落盘 */
export function routeSlug(route: string): string {
  const cleaned = route
    .replace(/^https?:\/\//i, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    // `.` 在允许集合里，因此 `../../x` 会先变成 `..-..-x`，仍然含 `..`。
    // 虽然调用侧总给它加前缀后缀、构不成真实穿越，但 routeSlug 是通用工具，
    // 调用方完全可能直接把返回值当作一段路径使用 —— 在源头掐掉。
    .replace(/\.{2,}/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
  return cleaned === '' ? 'root' : cleaned;
}
