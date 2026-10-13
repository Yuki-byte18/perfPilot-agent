import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createInMemorySourceMap, createSourceMapAdapter } from './index.js';
import {
  BROKEN_SOURCE_MAP,
  DEPENDENCY_SOURCE_MAP,
  EMPTY_SOURCE_MAP,
  INDEX_SOURCE_MAP,
  SIMPLE_SOURCE_MAP,
} from '../fixtures/source-maps.js';

let root: string;

const writeMap = async (file: string, map: unknown): Promise<void> => {
  await writeFile(join(root, file), JSON.stringify(map), 'utf8');
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'perfpilot-smap-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('source-map adapter — 基本解析', () => {
  it('把产物位置还原到源码 file:line（验收标准 4）', async () => {
    await writeFile(join(root, 'bundle.js'), 'var a=1;var b=2;', 'utf8');
    await writeMap('bundle.js.map', SIMPLE_SOURCE_MAP);

    const smap = createSourceMapAdapter({ root });

    // 产物第 1 行第 0 列 → 源码第 1 行
    const first = await smap.resolve({ file: 'bundle.js', line: 1, column: 0 });
    expect(first).not.toBeNull();
    expect(first?.source).toBe('src/original.ts');
    expect(first?.line).toBe(1);
    expect(first?.column).toBe(0);

    // 产物第 1 行第 10 列 → 源码第 2 行（第二个 mapping 段）
    const second = await smap.resolve({ file: 'bundle.js', line: 1, column: 10 });
    expect(second?.line).toBe(2);
  });

  it('sourceRoot 会被拼进结果路径', async () => {
    await writeMap('bundle.js.map', { ...SIMPLE_SOURCE_MAP, sourceRoot: 'webpack:///' });
    const smap = createSourceMapAdapter({ root });

    const loc = await smap.resolve({ file: 'bundle.js', line: 1, column: 0 });
    // webpack:/// 前缀被剥掉，路径仍相对项目根
    expect(loc?.source).not.toContain('webpack:');
  });

  it('识别 node_modules 里的源码', async () => {
    await writeMap('vendor.js.map', DEPENDENCY_SOURCE_MAP);
    const smap = createSourceMapAdapter({ root });

    const loc = await smap.resolve({ file: 'vendor.js', line: 1, column: 0 });
    expect(loc?.fromDependency).toBe(true);
  });

  it('项目自身源码不会被标成依赖', async () => {
    await writeMap('bundle.js.map', SIMPLE_SOURCE_MAP);
    const smap = createSourceMapAdapter({ root });

    expect((await smap.resolve({ file: 'bundle.js', line: 1, column: 0 }))?.fromDependency).toBe(
      false,
    );
  });
});

describe('source-map adapter — 缺失与损坏时的降级', () => {
  it('没有 map 文件时返回 null（调用侧降级为只归因到产物）', async () => {
    const smap = createSourceMapAdapter({ root });
    expect(await smap.resolve({ file: 'no-map.js', line: 1, column: 0 })).toBeNull();
  });

  it('map 文件不是合法 JSON 时返回 null 而不是抛错', async () => {
    await writeFile(join(root, 'broken.js.map'), '{ not json', 'utf8');
    const smap = createSourceMapAdapter({ root });

    expect(await smap.resolve({ file: 'broken.js', line: 1, column: 0 })).toBeNull();
  });

  it('map 结构不合法（缺 mappings）时返回 null', async () => {
    await writeMap('empty.js.map', EMPTY_SOURCE_MAP);
    const smap = createSourceMapAdapter({ root });

    expect(await smap.resolve({ file: 'empty.js', line: 1, column: 0 })).toBeNull();
  });

  it('mappings 是非法 VLQ 时不抛异常（宁可不归因，也不能让诊断整体失败）', async () => {
    await writeMap('broken.js.map', BROKEN_SOURCE_MAP);
    const smap = createSourceMapAdapter({ root });

    const result = await smap.resolve({ file: 'broken.js', line: 1, column: 0 });
    expect(result === null || typeof result.source === 'string').toBe(true);
  });

  it('行号超出映射范围时返回 null', async () => {
    await writeMap('bundle.js.map', SIMPLE_SOURCE_MAP);
    const smap = createSourceMapAdapter({ root });

    expect(await smap.resolve({ file: 'bundle.js', line: 9999, column: 0 })).toBeNull();
  });

  it('结果被缓存：同一个文件不会反复读盘（第二次调用走内存）', async () => {
    await writeMap('bundle.js.map', SIMPLE_SOURCE_MAP);
    const smap = createSourceMapAdapter({ root });

    const first = await smap.resolve({ file: 'bundle.js', line: 1, column: 0 });
    // 把文件删掉，命中缓存的话仍然能解析出结果
    await rm(join(root, 'bundle.js.map'));
    const second = await smap.resolve({ file: 'bundle.js', line: 1, column: 0 });

    expect(second).toEqual(first);
  });

  it('warmup 预载后仍能正常解析', async () => {
    await writeMap('bundle.js.map', SIMPLE_SOURCE_MAP);
    const smap = createSourceMapAdapter({ root });

    await smap.warmup(['bundle.js', 'missing.js']);
    expect((await smap.resolve({ file: 'bundle.js', line: 1, column: 0 }))?.line).toBe(1);
  });
  it('map 位于构建产物目录时也能找到（部署 URL ≠ 磁盘路径）', async () => {
    // trace/HAR 记录的是 /assets/index.js，磁盘上却在 dist/assets/index.js.map
    await mkdir(join(root, 'dist', 'assets'), { recursive: true });
    await writeFile(
      join(root, 'dist', 'assets', 'index.js.map'),
      JSON.stringify({ version: 3, sources: ['../../src/list.tsx'], names: [], mappings: 'AAAA' }),
      'utf8',
    );

    const smap = createSourceMapAdapter({
      root,
      searchRoots: [root, join(root, 'dist')],
    });

    const loc = await smap.resolve({ file: 'assets/index.js', line: 1, column: 0 });
    expect(loc?.source).toBe('src/list.tsx');
  });
});
describe('source-map adapter — index map', () => {
  it('支持 sections 形式的 index map（多 chunk 拼接产物）', async () => {
    await writeMap('index-map.js.map', INDEX_SOURCE_MAP);
    const smap = createSourceMapAdapter({ root });

    const first = await smap.resolve({ file: 'index-map.js', line: 1, column: 0 });
    expect(first?.source).toBe('src/first.ts');

    const second = await smap.resolve({ file: 'index-map.js', line: 2, column: 0 });
    expect(second?.source).toBe('src/second.ts');
  });
});

describe('source-map adapter — 路径规范', () => {
  it('source 相对 map 文件所在目录解析，而不是项目根', async () => {
    // map 放在 dist/ 下、源码在 src/ 下：`../src/a.ts` 才是对的写法。
    // 若拿项目根去拼，会得到 `../src/a.ts` 这种跑到项目外的错误路径。
    await mkdir(join(root, 'dist'), { recursive: true });
    await writeFile(
      join(root, 'dist', 'bundle.js.map'),
      JSON.stringify({ version: 3, sources: ['../src/a.ts'], names: [], mappings: 'AAAA' }),
      'utf8',
    );

    const smap = createSourceMapAdapter({ root });
    const loc = await smap.resolve({ file: 'dist/bundle.js', line: 1, column: 0 });

    expect(loc?.source).toBe('src/a.ts');
  });

  it('webpack:// 虚拟协议按项目根处理', async () => {
    await writeMap(
      'bundle.js.map',
      { version: 3, sources: ['webpack:///./src/a.ts'], names: [], mappings: 'AAAA' },
    );
    const smap = createSourceMapAdapter({ root });

    expect((await smap.resolve({ file: 'bundle.js', line: 1, column: 0 }))?.source).toBe('src/a.ts');
  });
});

describe('createInMemorySourceMap', () => {
  it('按 file:line:column 命中，未命中返回 null', async () => {
    const smap = createInMemorySourceMap({
      'a.js:1:0': {
        source: 'a.ts',
        line: 1,
        column: 0,
        name: null,
        fromDependency: false,
      },
    });

    expect((await smap.resolve({ file: 'a.js', line: 1, column: 0 }))?.source).toBe('a.ts');
    expect(await smap.resolve({ file: 'a.js', line: 2, column: 0 })).toBeNull();
  });

  it('warmup 是空操作', async () => {
    const smap = createInMemorySourceMap({});
    await expect(smap.warmup(['x'])).resolves.toBeUndefined();
  });
});
