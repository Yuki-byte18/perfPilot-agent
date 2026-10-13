import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createNullAssetProcessor,
  type Candidate,
  type ExecutionContext,
  type PlannedChange,
} from '@yuki-byte18/shared';
import { createInMemorySourceMap } from '@yuki-byte18/shared';
import {
  createAstRewriterExecutor,
  createAssetProcessorExecutor,
  createConfigEditorExecutor,
  createDependencyEditorExecutor,
  createExecutorRegistry,
} from './index.js';
import { addDeferScript, addLoadingLazy, wrapWithMemo } from './ast-rewriter.js';
import { replaceUnique } from './config-editor.js';

/**
 * M5 验收 2：**四类执行器各有 fixture 输入 → patch 输出的测试**。
 *
 * 每个 patch 都用真实 `git apply --check` 校验 —— 这是"产出标准 unified diff"
 * （验收 1）唯一有说服力的验证方式。
 */

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'perfpilot-exec-'));
  execFileSync('git', ['init', '--quiet'], { cwd: repo });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: repo });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

/** 用内存文件系统构造执行上下文 —— 不碰真实磁盘 */
function context(files: Record<string, string>, binary: Record<string, Uint8Array> = {}): ExecutionContext {
  return {
    projectRoot: '/virtual',
    readFile: async (path) => files[path] ?? null,
    readBinary: async (path) => binary[path] ?? null,
  };
}

function candidate(changes: PlannedChange[], overrides: Partial<Candidate> = {}): Candidate {
  return {
    id: 'cand_test',
    runId: 'run_1',
    bottleneckIds: ['bn_1'],
    class: 'A',
    title: '测试候选',
    description: '测试',
    origin: 'rule',
    ruleId: 'test',
    promptVersion: null,
    changes,
    expectedGain: {},
    confidence: 0.9,
    risk: 'low',
    effort: 'low',
    reversible: true,
    recalledFrom: [],
    bottleneckKinds: ['MISSING_PRELOAD'],
    ...overrides,
  };
}

/** 把补丁喂给真实 git apply */
function applies(patch: string, files: Record<string, string>): boolean {
  for (const [path, content] of Object.entries(files)) {
    const full = join(repo, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  const patchFile = join(repo, '__p.patch');
  writeFileSync(patchFile, patch, 'utf8');
  try {
    execFileSync('git', ['apply', '--check', '--whitespace=nowarn', patchFile], {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  } finally {
    rmSync(patchFile, { force: true });
  }
}

// ─────────────────────────────────────────────────────────────────────
// 1. ast-rewriter
// ─────────────────────────────────────────────────────────────────────

describe('ast-rewriter 执行器', () => {
  const executor = createAstRewriterExecutor();

  it('add-loading-lazy：给 img 加 loading="lazy"，并产出可 apply 的 patch', async () => {
    const html = `<!doctype html>
<html>
  <body>
    <img src="/a.png" alt="a">
    <img src="/b.png" alt="b" loading="eager">
    <img src="/c.png" alt="c" fetchpriority="high">
  </body>
</html>
`;
    const ctx = context({ 'index.html': html });
    const result = await executor.execute(
      candidate([{ type: 'ast', file: 'index.html', node: 'add-loading-lazy', description: '懒加载' }]),
      ctx,
    );

    expect(result.patch).not.toBe('');
    // 只改第一张：已有 loading 的和高优先级的都不动
    expect(result.patch.match(/^\+.*loading="lazy"/gm)?.length).toBe(1);
    expect(applies(result.patch, { 'index.html': html })).toBe(true);
  });

  it('add-defer-script：只给外链且无 defer/async/module 的 script 加 defer', async () => {
    const html = `<script src="/a.js"></script>
<script src="/b.js" defer></script>
<script src="/c.js" async></script>
<script type="module" src="/d.js"></script>
<script>console.log('inline')</script>
`;
    const ctx = context({ 'index.html': html });
    const result = await executor.execute(
      candidate([{ type: 'ast', file: 'index.html', node: 'add-defer-script', description: '延迟' }]),
      ctx,
    );

    expect(result.patch.match(/^\+.*defer/gm)?.length).toBe(1);
    expect(applies(result.patch, { 'index.html': html })).toBe(true);
  });

  it('react-memo：用 ts-morph 包装函数组件', async () => {
    const tsx = `export default function App({ items }: Props) {
  return <ul>{items.map((i) => <li key={i}>{i}</li>)}</ul>;
}
`;
    const ctx = context({ 'src/App.tsx': tsx });
    const result = await executor.execute(
      candidate([{ type: 'ast', file: 'src/App.tsx', node: 'react-memo', description: 'memo 化' }]),
      ctx,
    );

    expect(result.patch).not.toBe('');
    expect(result.patch).toContain('memo');
    expect(applies(result.patch, { 'src/App.tsx': tsx })).toBe(true);
  });

  it('react-memo 遇到已 memo 的组件不重复包装', async () => {
    const tsx = `import { memo } from 'react';
export default memo(function App() { return <div />; });
`;
    const result = await createAstRewriterExecutor().execute(
      candidate([{ type: 'ast', file: 'src/App.tsx', node: 'react-memo', description: 'memo 化' }]),
      context({ 'src/App.tsx': tsx }),
    );

    expect(result.patch).toBe('');
    expect(result.summary).toContain('已经是 memo');
  });

  it('未知变换 id 不产出补丁，而是说明需要人工', async () => {
    const result = await executor.execute(
      candidate([
        { type: 'ast', file: 'src/List.tsx', node: 'list-render', description: '引入虚拟滚动' },
      ]),
      context({ 'src/List.tsx': 'export default function List() { return null; }' }),
    );

    expect(result.patch).toBe('');
    expect(result.summary).toContain('需人工处理');
  });

  it('文件不存在时不抛错，说明原因', async () => {
    const result = await executor.execute(
      candidate([{ type: 'ast', file: 'nope.html', node: 'add-loading-lazy', description: 'x' }]),
      context({}),
    );

    expect(result.patch).toBe('');
    expect(result.summary).toContain('文件不存在');
  });

  /**
   * 路由表的位置只有约定、没有定数：规划器只能声明一个最可能的路径，
   * 真正的核实由执行器完成。这条用例守的是"约定名要真的被用上"。
   */
  it('路由表不在声明位置时，按约定名找到它', async () => {
    const router = `import Settings from './views/Settings.vue'

export const routes = [{ path: '/settings', component: Settings }]
`;

    const result = await executor.execute(
      candidate([
        { type: 'ast', file: 'src/router/index.ts', node: 'lazy-route-component', description: '拆' },
      ]),
      context({ 'src/routes.ts': router }),
    );

    // 补丁落在真实存在的那个文件上，而不是凭空捏一个 src/router/index.ts
    expect(result.files).toEqual(['src/routes.ts']);
    expect(result.patch).toContain("component: () => import('./views/Settings.vue')");
    expect(applies(result.patch, { 'src/routes.ts': router })).toBe(true);
  });

  it('约定名也找不到路由表时如实跳过，绝不改一个碰巧存在的文件', async () => {
    const result = await executor.execute(
      candidate([
        { type: 'ast', file: 'src/router/index.ts', node: 'lazy-route-component', description: '拆' },
      ]),
      context({ 'src/main.ts': 'import { createApp } from "vue";\n' }),
    );

    expect(result.patch).toBe('');
    expect(result.summary).toContain('文件不存在');
  });
});

describe('ast 变换的纯函数层', () => {
  it('addLoadingLazy 不动已有 loading / fetchpriority=high 的 img', () => {
    const html = '<img src="a" loading="eager"><img src="b" fetchpriority="high"><img src="c">';
    const { html: out, changed } = addLoadingLazy(html);

    expect(changed).toBe(1);
    expect(out).toContain('<img src="a" loading="eager">');
    expect(out).toContain('<img src="c" loading="lazy">');
  });

  it('addDeferScript 不动内联脚本与 module', () => {
    const html = '<script>inline()</script><script type="module" src="m.js"></script>';
    expect(addDeferScript(html).changed).toBe(0);
  });

  it('wrapWithMemo 对没有默认导出的文件拒绝改写', () => {
    const result = wrapWithMemo('export const a = 1;');
    expect(result.changed).toBe(false);
    expect(result.reason).toContain('没有默认导出');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 2. config-editor
// ─────────────────────────────────────────────────────────────────────

describe('config-editor 执行器', () => {
  const executor = createConfigEditorExecutor();

  it('JSON 配置：按键路径改写并产出可 apply 的 patch', async () => {
    const before = `{
  "build": {
    "target": "es2015"
  }
}
`;
    const result = await executor.execute(
      candidate([
        { type: 'config', file: 'tsconfig.json', key: 'build.target', before: 'es2015', after: 'es2020' },
      ]),
      context({ 'tsconfig.json': before }),
    );

    expect(result.patch).toContain('-    "target": "es2015"');
    expect(result.patch).toContain('+    "target": "es2020"');
    expect(applies(result.patch, { 'tsconfig.json': before })).toBe(true);
  });

  it('现值和预期不符时拒绝改写（避免覆盖别人的修改）', async () => {
    const before = '{ "build": { "target": "es2017" } }';
    const result = await executor.execute(
      candidate([
        { type: 'config', file: 'tsconfig.json', key: 'build.target', before: 'es2015', after: 'es2020' },
      ]),
      context({ 'tsconfig.json': before }),
    );

    expect(result.patch).toBe('');
    expect(result.summary).toContain('与预期');
  });

  it('非 JSON 文件要求 before 可唯一定位；出现多次则拒绝', async () => {
    const config = `minify: false,\nfoo: 1,\nminify: false,\n`;
    const result = await executor.execute(
      candidate([{ type: 'config', file: 'vite.config.ts', key: 'minify', before: 'false', after: 'true' }]),
      context({ 'vite.config.ts': config }),
    );

    expect(result.patch).toBe('');
    expect(result.summary).toContain('出现多次');
  });

  it('JSON 缺失键时创建它（setByPath 沿途补对象）', async () => {
    const before = '{ "name": "demo" }\n';
    const result = await executor.execute(
      candidate([
        { type: 'config', file: 'package.json', key: 'sideEffects', before: null, after: false },
      ]),
      context({ 'package.json': before }),
    );

    expect(result.patch).toContain('+  "sideEffects": false');
    expect(applies(result.patch, { 'package.json': before })).toBe(true);
  });

  /**
   * 回归：候选里的文件名是**推断**出来的（诊断器归因写死 `vite.config.ts`），
   * 而真实项目常常是 `vite.config.js`。找不到就默默跳过的话，用户看到的是
   * "预期省 436KB"的候选配着"1 条无改动"，一点原因都拿不到。
   */
  it('扩展名与实际不符时，落到真实存在的同名文件上', async () => {
    const config = `export default {\n  build: {\n    target: 'es2015',\n  },\n};\n`;
    const result = await executor.execute(
      candidate([
        { type: 'config', file: 'vite.config.ts', key: 'build.target', before: 'es2015', after: 'es2020' },
      ]),
      context({ 'vite.config.js': config }),
    );

    // 补丁必须落在真实文件上，而不是凭空捏一个 vite.config.ts
    expect(result.files).toEqual(['vite.config.js']);
    expect(result.patch).toContain('--- a/vite.config.js');
    expect(applies(result.patch, { 'vite.config.js': config })).toBe(true);
  });

  it('同名文件一个都不存在时，如实说明原因而不是静默跳过', async () => {
    const result = await executor.execute(
      candidate([
        { type: 'config', file: 'vite.config.ts', key: 'build.target', before: 'es2015', after: 'es2020' },
      ]),
      context({ 'package.json': '{}\n' }),
    );

    expect(result.patch).toBe('');
    expect(result.summary).toContain('文件不存在：vite.config.ts');
  });

  /**
   * `before: null` 的语义是「这个键还不存在」，要做的是**插入**。
   *
   * 之前这类改动一律被拒（"需要 before 提供可定位的原文"），于是
   * `add-preload` 那条 **A 类**规则（会真的自动执行）从来没产出过补丁 ——
   * 一条能自动做的优化被静默关着。
   */
  it('HTML 里新建键 → 插到 </head> 之前，沿用该行缩进', async () => {
    const before = '<!doctype html>\n<html>\n  <head>\n    <title>demo</title>\n  </head>\n  <body></body>\n</html>\n';
    const snippet = '<link rel="preload" href="/assets/hero.png" as="image">';

    const result = await executor.execute(
      candidate([
        { type: 'config', file: 'index.html', key: 'preload:/assets/hero.png', before: null, after: snippet },
      ]),
      context({ 'index.html': before }),
    );

    expect(result.files).toEqual(['index.html']);
    expect(result.patch).toContain(`+    ${snippet}`);
    expect(applies(result.patch, { 'index.html': before })).toBe(true);
  });

  it('HTML 里没有独占一行的 </head> 时拒绝，而不是产出可疑补丁', async () => {
    const oneLine = '<!doctype html><html><head><title>demo</title></head><body></body></html>';

    const result = await executor.execute(
      candidate([
        { type: 'config', file: 'index.html', key: 'preload:/x.png', before: null, after: '<link rel="preload" href="/x.png" as="image">' },
      ]),
      context({ 'index.html': oneLine }),
    );

    expect(result.patch).toBe('');
    expect(result.summary).toContain('</head>');
  });

  it('JS 配置文件里新建键仍然拒绝：往用户配置里插代码代价太高', async () => {
    const result = await executor.execute(
      candidate([
        { type: 'config', file: 'vite.config.js', key: 'build.target', before: null, after: 'es2022' },
      ]),
      context({ 'vite.config.js': 'export default defineConfig({\n  plugins: [],\n})\n' }),
    );

    expect(result.patch).toBe('');
    expect(result.summary).toContain('刻意不支持');
  });
});

describe('config-editor 的纯函数层', () => {
  it('replaceUnique 命中 0 次或多次都拒绝', () => {
    expect(replaceUnique('a', 'z', 'y')).toHaveProperty('error');
    expect(replaceUnique('a b a', 'a', 'y')).toHaveProperty('error');
    expect(replaceUnique('a b', 'a', 'y')).toEqual({ content: 'y b' });
  });
});

// ─────────────────────────────────────────────────────────────────────
// 3. dependency-editor
// ─────────────────────────────────────────────────────────────────────

describe('dependency-editor 执行器', () => {
  const executor = createDependencyEditorExecutor();

  it('移除依赖并产出可 apply 的 patch', async () => {
    const before = `{
  "name": "demo",
  "dependencies": {
    "lodash": "^4.17.21",
    "react": "^18.0.0"
  }
}
`;
    const result = await executor.execute(
      candidate([{ type: 'dependency', remove: ['lodash'], reason: '未使用' }]),
      context({ 'package.json': before }),
    );

    expect(result.patch).toContain('-    "lodash": "^4.17.21"');
    expect(result.patch).not.toContain('-    "react"');
    expect(applies(result.patch, { 'package.json': before })).toBe(true);
  });

  it('替换依赖时保留版本号与原位置（产出的 diff 是"改一行"）', async () => {
    const before = `{
  "dependencies": {
    "moment": "^2.29.4",
    "react": "^18.0.0"
  }
}
`;
    const result = await executor.execute(
      candidate([{ type: 'dependency', replace: { from: 'moment', to: 'dayjs' }, reason: '更轻' }]),
      context({ 'package.json': before }),
    );

    expect(result.patch).toContain('-    "moment": "^2.29.4"');
    expect(result.patch).toContain('+    "dayjs": "^2.29.4"');
    expect(applies(result.patch, { 'package.json': before })).toBe(true);
  });

  it('替换成已存在的包时拒绝（会造成重复声明）', async () => {
    const before = '{ "dependencies": { "moment": "^2.29.4", "dayjs": "^1.11.0" } }';
    const result = await executor.execute(
      candidate([{ type: 'dependency', replace: { from: 'moment', to: 'dayjs' }, reason: 'x' }]),
      context({ 'package.json': before }),
    );

    expect(result.patch).toBe('');
    expect(result.summary).toContain('已存在');
  });

  it('移除不存在的依赖记为跳过，而不是失败', async () => {
    const before = '{ "dependencies": { "react": "^18.0.0" } }';
    const result = await executor.execute(
      candidate([{ type: 'dependency', remove: ['nonexistent'], reason: 'x' }]),
      context({ 'package.json': before }),
    );

    expect(result.patch).toBe('');
    expect(result.summary).toContain('不在依赖表中');
  });

  it('保留原文件的缩进风格（4 空格不变成 2 空格）', async () => {
    const before = `{
    "dependencies": {
        "moment": "^2.29.4"
    }
}
`;
    const result = await executor.execute(
      candidate([{ type: 'dependency', remove: ['moment'], reason: 'x' }]),
      context({ 'package.json': before }),
    );

    // 关键是**缩进风格没被改成 2 空格**：
    // 删掉唯一的依赖后 dependencies 变成空对象，JSON.stringify 会把它折成一行，
    // 所以新增行数不是 1 —— 但每一行新增都必须保持 4 空格缩进。
    const added = (result.patch.match(/^\+.*$/gm) ?? []).filter((l) => !l.startsWith('+++'));
    expect(added.length).toBeGreaterThan(0);
    for (const line of added) {
      const indent = /^\+(\s*)/.exec(line)?.[1] ?? '';
      if (indent.length > 0) expect(indent.length % 4, line).toBe(0);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// 4. asset-processor
// ─────────────────────────────────────────────────────────────────────

describe('asset-processor 执行器', () => {
  it('真实 sharp 转 WebP：体积下降、记录收益，且不产文本补丁', async () => {
    const { createSharpAssetProcessor } = await import('../asset/index.js');
    const executor = createAssetProcessorExecutor({
      processor: createSharpAssetProcessor(),
      writeOutput: false,
    });

    // 造一张 200x200 的 PNG
    const sharpMod = (await import('sharp')).default;
    const png = new Uint8Array(
      await sharpMod({
        create: { width: 200, height: 200, channels: 3, background: { r: 200, g: 50, b: 50 } },
      })
        .png()
        .toBuffer(),
    );

    const result = await executor.execute(
      candidate([
        { type: 'asset', file: 'assets/hero.png', operation: 'convert-webp', params: {} },
      ]),
      context({}, { 'assets/hero.png': png }),
    );

    expect(result.files).toEqual(['assets/hero.webp']);
    expect(result.summary).toContain('省');
    // 二进制改动没有文本补丁 —— ADR 006 的明确约定
    expect(result.patch).toBe('');
  });

  it('没有 readBinary 时明确说明，而不是静默失败', async () => {
    const executor = createAssetProcessorExecutor({ processor: createNullAssetProcessor() });
    const result = await executor.execute(
      candidate([{ type: 'asset', file: 'a.png', operation: 'compress', params: {} }]),
      { projectRoot: '/v', readFile: async () => null },
    );

    expect(result.summary).toContain('readBinary');
  });

  it('非图片文件被跳过', async () => {
    const executor = createAssetProcessorExecutor({ processor: createNullAssetProcessor() });
    const result = await executor.execute(
      candidate([{ type: 'asset', file: 'a.txt', operation: 'compress', params: {} }]),
      context({}, { 'a.txt': new Uint8Array([1, 2, 3]) }),
    );

    expect(result.files).toEqual([]);
    expect(result.summary).toContain('不是可处理的图片格式');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 注册表
// ─────────────────────────────────────────────────────────────────────

describe('createExecutorRegistry', () => {
  const registry = createExecutorRegistry({ assetProcessor: createNullAssetProcessor() });

  it('四类改动各自路由到对应执行器', () => {
    const cases: Array<[PlannedChange, string]> = [
      [{ type: 'ast', file: 'a.tsx', node: 'react-memo', description: '' }, 'ast-rewriter'],
      [{ type: 'asset', file: 'a.png', operation: 'compress', params: {} }, 'asset-processor'],
      [{ type: 'config', file: 'c.json', key: 'k', before: 1, after: 2 }, 'config-editor'],
      [{ type: 'dependency', remove: ['x'], reason: '' }, 'dependency-editor'],
    ];

    for (const [change, route] of cases) {
      expect(registry.forCandidate(candidate([change]))?.route, change.type).toBe(route);
    }
  });

  it('改动跨多类时没有执行器能认领（返回 null）', () => {
    const mixed = candidate([
      { type: 'ast', file: 'a.tsx', node: 'react-memo', description: '' },
      { type: 'config', file: 'c.json', key: 'k', before: 1, after: 2 },
    ]);

    expect(registry.forCandidate(mixed)).toBeNull();
  });

  it('all() 返回四个执行器', () => {
    expect(registry.all().map((e) => e.route).sort()).toEqual([
      'asset-processor',
      'ast-rewriter',
      'config-editor',
      'dependency-editor',
    ]);
  });
});

void createInMemorySourceMap;
