import { describe, expect, it } from 'vitest';
import { splitRouteComponents } from './route-splitter.js';

/**
 * 路由级代码分割的变换。
 *
 * 两条最要紧的断言：
 * 1. **静态 import 被删掉** —— 只改 `component: X` 而留着顶部 import 的话，
 *    打包器仍会把模块打进首屏，补丁看起来是对的、收益却是零
 * 2. **名字还被别处用到时不删** —— 删错就是编译不过
 */

const ROUTER = `import Home from './views/Home.vue'
import Settings from './views/Settings.vue'

export const routes = [
  { path: '/', component: Home },
  { path: '/settings', component: Settings },
]
`;

describe('splitRouteComponents', () => {
  it('把静态组件引用改成动态 import，并删掉因此不再被用到的 import', () => {
    const result = splitRouteComponents(ROUTER);

    expect(result.changed).toBe(true);
    expect(result.splitNames.sort()).toEqual(['Home', 'Settings']);
    expect(result.source).toContain("component: () => import('./views/Home.vue')");
    expect(result.source).toContain("component: () => import('./views/Settings.vue')");
    // 关键：静态 import 必须消失，否则模块仍会进首屏 chunk
    expect(result.source).not.toContain("import Home from './views/Home.vue'");
    expect(result.source).not.toContain("import Settings from './views/Settings.vue'");
  });

  it('组件在别处也被用到时，保留它的 import（宁可少收益，不可删错）', () => {
    const source = `import Settings from './views/Settings.vue'

export const routes = [{ path: '/settings', component: Settings }]
export const fallback = Settings
`;

    const result = splitRouteComponents(source);

    expect(result.changed).toBe(true);
    expect(result.source).toContain("component: () => import('./views/Settings.vue')");
    // 还有别处引用 → import 必须留着，否则编译不过
    expect(result.source).toContain("import Settings from './views/Settings.vue'");
  });

  it('已经懒加载 / 命名视图 / JSX 写法都不动，并说明原因', () => {
    const alreadyLazy = `export const routes = [{ path: '/', component: () => import('./A.vue') }]`;
    expect(splitRouteComponents(alreadyLazy).changed).toBe(false);

    const namedView = `import A from './A.vue'\nexport const routes = [{ components: { default: A } }]`;
    expect(splitRouteComponents(namedView).changed).toBe(false);

    const jsx = `import A from './A'\nexport const routes = [{ element: <A /> }]`;
    const result = splitRouteComponents(jsx);
    expect(result.changed).toBe(false);
    expect(result.reason).toContain('component: 静态组件');
  });

  it('node_modules 里的包不拆：那不是路由分割语义', () => {
    const source = `import Widget from 'some-ui-lib'\nexport const routes = [{ path: '/', component: Widget }]`;

    expect(splitRouteComponents(source).changed).toBe(false);
  });
});
