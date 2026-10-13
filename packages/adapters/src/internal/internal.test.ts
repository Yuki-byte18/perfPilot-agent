import { describe, expect, it } from 'vitest';
import { resolveRouteUrl, routeSlug } from './url.js';
import { computeBundleSizes, extractPackage, findDuplicatePackages, extensionOf } from './bundle.js';

describe('resolveRouteUrl', () => {
  it('根路由保留单一尾斜杠', () => {
    expect(resolveRouteUrl('https://a.example.com', '/')).toBe('https://a.example.com/');
    expect(resolveRouteUrl('https://a.example.com/', '/')).toBe('https://a.example.com/');
  });

  it('拼接子路由，且不产生双斜杠', () => {
    expect(resolveRouteUrl('https://a.example.com', '/dashboard')).toBe(
      'https://a.example.com/dashboard',
    );
    expect(resolveRouteUrl('https://a.example.com/', '/dashboard')).toBe(
      'https://a.example.com/dashboard',
    );
    expect(resolveRouteUrl('https://a.example.com/', 'dashboard')).toBe(
      'https://a.example.com/dashboard',
    );
  });

  it('保留已有路径前缀（部署在子目录下的应用）', () => {
    expect(resolveRouteUrl('https://a.example.com/app', '/settings')).toBe(
      'https://a.example.com/app/settings',
    );
  });

  it('路由为绝对 URL 时直接采用', () => {
    expect(resolveRouteUrl('https://a.example.com', 'https://b.example.com/x')).toBe(
      'https://b.example.com/x',
    );
  });

  it('保留查询串与 hash', () => {
    expect(resolveRouteUrl('https://a.example.com', '/search?q=1#top')).toBe(
      'https://a.example.com/search?q=1#top',
    );
  });

  it('空路由退化为基地址本身', () => {
    expect(resolveRouteUrl('https://a.example.com/base', '  ')).toBe('https://a.example.com/base');
  });
});

describe('routeSlug', () => {
  it('把路由变成安全文件名', () => {
    expect(routeSlug('/')).toBe('root');
    expect(routeSlug('/dashboard')).toBe('dashboard');
    expect(routeSlug('/settings/profile')).toBe('settings-profile');
    expect(routeSlug('/search?q=a b')).toBe('search-q-a-b');
  });

  it('绝对 URL 也安全', () => {
    expect(routeSlug('https://a.example.com/x')).toBe('a.example.com-x');
  });

  it('不产生路径穿越', () => {
    expect(routeSlug('../../etc/passwd')).not.toContain('..');
    expect(routeSlug('../../etc/passwd')).not.toContain('/');
  });
});

describe('extensionOf', () => {
  it('小写化并剥离查询串', () => {
    expect(extensionOf('Assets/Index.JS')).toBe('.js');
    expect(extensionOf('a.js?v=2')).toBe('.js');
    expect(extensionOf('a.png#x')).toBe('.png');
    expect(extensionOf('LICENSE')).toBe('');
  });
});

describe('computeBundleSizes', () => {
  it('忽略非有限体积', () => {
    const samples = computeBundleSizes([
      { path: 'a.js', size: 100, sourcePath: null },
      { path: 'b.js', size: Number.NaN, sourcePath: null },
    ]);
    expect(samples.find((s) => s.name === 'JS_SIZE')?.value).toBe(100);
  });
});

describe('extractPackage', () => {
  it('解析 pnpm 布局并取出包名与版本', () => {
    expect(
      extractPackage('./node_modules/.pnpm/lodash@4.17.21/node_modules/lodash/lodash.js'),
    ).toEqual({
      name: 'lodash',
      version: '4.17.21',
      location: './node_modules/.pnpm/lodash@4.17.21/node_modules/lodash/',
    });
  });

  it('解析 pnpm 里的 scoped 包（目录名用 + 代替 /）', () => {
    const result = extractPackage(
      './node_modules/.pnpm/@babel+core@7.24.0/node_modules/@babel/core/lib/index.js',
    );
    expect(result?.name).toBe('@babel/core');
    expect(result?.version).toBe('7.24.0');
  });

  it('嵌套安装取最内层包，而不是外层宿主包', () => {
    const result = extractPackage('./node_modules/a/node_modules/lodash/lodash.js');
    expect(result?.name).toBe('lodash');
    expect(result?.version).toBeNull();
  });

  it('嵌套安装的位置能区分同一版本的两份拷贝', () => {
    const first = extractPackage('./node_modules/a/node_modules/lodash/index.js');
    const second = extractPackage('./node_modules/b/node_modules/lodash/index.js');
    expect(first?.location).not.toBe(second?.location);
  });

  it('项目自身源码返回 null', () => {
    expect(extractPackage('./src/App.tsx')).toBeNull();
    expect(extractPackage('src/main.ts')).toBeNull();
  });

  it('Windows 路径分隔符同样处理', () => {
    expect(extractPackage('.\\node_modules\\.pnpm\\react@18.3.1\\node_modules\\react\\index.js')?.name)
      .toBe('react');
  });

  it('无版本号的 pnpm 目录不报错', () => {
    expect(extractPackage('./node_modules/.pnpm/plain/node_modules/plain/index.js')?.version).toBeNull();
  });
});

describe('findDuplicatePackages', () => {
  it('同一版本被安装两次也算重复打包', () => {
    const report = findDuplicatePackages([
      { name: './node_modules/a/node_modules/lodash/index.js', size: 1 },
      { name: './node_modules/b/node_modules/lodash/index.js', size: 1 },
    ]);
    expect(report.count).toBe(1);
    expect(report.details[0]?.copies).toBe(2);
  });

  it('两个不同版本计为一份重复', () => {
    const report = findDuplicatePackages([
      { name: './node_modules/.pnpm/lodash@4.17.21/node_modules/lodash/index.js', size: 1 },
      { name: './node_modules/.pnpm/lodash@3.10.1/node_modules/lodash/index.js', size: 1 },
    ]);
    expect(report.count).toBe(1);
    expect(report.details[0]?.versions).toEqual(['3.10.1', '4.17.21']);
  });

  it('单一安装不算重复', () => {
    const report = findDuplicatePackages([
      { name: './node_modules/.pnpm/react@18.3.1/node_modules/react/index.js', size: 1 },
      { name: './src/main.tsx', size: 1 },
    ]);
    expect(report.count).toBe(0);
  });

  it('明细按份数降序，份数相同时按包名排序（输出稳定）', () => {
    const report = findDuplicatePackages([
      { name: './node_modules/a/node_modules/zlib/index.js', size: 1 },
      { name: './node_modules/b/node_modules/zlib/index.js', size: 1 },
      { name: './node_modules/c/node_modules/zlib/index.js', size: 1 },
      { name: './node_modules/a/node_modules/alpha/index.js', size: 1 },
      { name: './node_modules/b/node_modules/alpha/index.js', size: 1 },
    ]);
    expect(report.details.map((d) => d.name)).toEqual(['zlib', 'alpha']);
    expect(report.details[0]?.copies).toBe(3);
  });

  it('空模块图返回 0', () => {
    expect(findDuplicatePackages([]).count).toBe(0);
  });
});
