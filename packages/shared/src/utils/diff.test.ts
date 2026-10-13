import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createUnifiedDiff } from './diff.js';

/**
 * Unified diff 的正确性**不靠推导，靠 `git apply` 裁决**。
 *
 * hunk 头的起始行号约定（尤其纯插入时的 `-N,0`）极易写错，
 * 而写错的补丁 `git apply` 会直接拒绝。因此这里建一个真实 git 仓库，
 * 把生成的补丁喂给 `git apply --check` —— 这是唯一有说服力的验证。
 */

let repo: string;

const write = (name: string, content: string): void => {
  writeFileSync(join(repo, name), content, 'utf8');
};

const read = (name: string): string => readFileSync(join(repo, name), 'utf8');

const git = (...args: string[]): string =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** 补丁能否被 git apply（--check 不实际改动工作区） */
const applies = (patch: string): boolean => {
  const patchFile = join(repo, '__test.patch');
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
};

/** 真正应用并返回结果内容 */
const applyAndRead = (patch: string, name: string): string => {
  const patchFile = join(repo, '__test.patch');
  writeFileSync(patchFile, patch, 'utf8');
  git('apply', '--whitespace=nowarn', patchFile);
  rmSync(patchFile, { force: true });
  return read(name);
};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'perfpilot-diff-'));
  git('init', '--quiet');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'core.autocrlf', 'false');
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('createUnifiedDiff — 基本形态', () => {
  it('无变化时返回 null（不产出空补丁）', () => {
    expect(createUnifiedDiff('a.ts', 'same\n', 'same\n')).toBeNull();
  });

  it('产出带 a/ b/ 前缀的文件头，统计增删行数', () => {
    const result = createUnifiedDiff('src/a.ts', 'one\ntwo\n', 'one\nTWO\n');

    expect(result).not.toBeNull();
    expect(result?.patch).toContain('--- a/src/a.ts');
    expect(result?.patch).toContain('+++ b/src/a.ts');
    expect(result?.additions).toBe(1);
    expect(result?.deletions).toBe(1);
  });

  it('修改单行', () => {
    const before = 'line1\nline2\nline3\n';
    const after = 'line1\nCHANGED\nline3\n';

    const result = createUnifiedDiff('f.txt', before, after);
    expect(result?.patch).toContain('-line2');
    expect(result?.patch).toContain('+CHANGED');
  });
});

describe('createUnifiedDiff — git apply 实际校验', () => {
  /**
   * 这一组是核心：每一条都把补丁喂给真实的 `git apply`。
   * 只要 hunk 头行号或上下文行数算错，这里就会红。
   */
  const cases: Array<{ name: string; before: string; after: string }> = [
    { name: '单行修改', before: 'a\nb\nc\n', after: 'a\nB\nc\n' },
    { name: '文件头部插入', before: 'b\nc\n', after: 'a\nb\nc\n' },
    { name: '文件末尾追加', before: 'a\nb\n', after: 'a\nb\nc\n' },
    { name: '文件头部删除', before: 'a\nb\nc\n', after: 'b\nc\n' },
    { name: '文件末尾删除', before: 'a\nb\nc\n', after: 'a\nb\n' },
    { name: '整文件替换', before: 'a\nb\n', after: 'x\ny\n' },
    { name: '清空文件', before: 'a\nb\n', after: '' },
    { name: '从空文件写入', before: '', after: 'a\nb\n' },
    { name: '单行文件', before: 'only\n', after: 'changed\n' },
    {
      name: '多处相隔较远的修改（应产生多个 hunk）',
      before: Array.from({ length: 40 }, (_, i) => `line${i}`).join('\n') + '\n',
      after:
        Array.from({ length: 40 }, (_, i) =>
          i === 2 ? 'CHANGED-2' : i === 37 ? 'CHANGED-37' : `line${i}`,
        ).join('\n') + '\n',
    },
    {
      name: '相邻多处修改（应合并进一个 hunk）',
      before: Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n') + '\n',
      after:
        Array.from({ length: 20 }, (_, i) =>
          i >= 5 && i <= 9 ? `CHANGED-${i}` : `line${i}`,
        ).join('\n') + '\n',
    },
    {
      name: '新增多行',
      before: 'a\nz\n',
      after: 'a\nb\nc\nd\ne\nz\n',
    },
    {
      name: '删除多行',
      before: 'a\nb\nc\nd\ne\nz\n',
      after: 'a\nz\n',
    },
    {
      name: '含空行',
      before: 'a\n\nb\n',
      after: 'a\n\n\nb\n',
    },
    {
      name: '含尾随空格',
      before: 'a  \nb\n',
      after: 'a\nb\n',
    },
  ];

  it.each(cases)('$name', ({ before, after }) => {
    write('target.txt', before);

    const result = createUnifiedDiff('target.txt', before, after);
    expect(result, '应当产出补丁').not.toBeNull();

    expect(applies(result?.patch ?? ''), 'git apply --check 应当通过').toBe(true);
    expect(applyAndRead(result?.patch ?? '', 'target.txt'), '应用后的内容应与目标一致').toBe(after);
  });

  it('末尾无换行的文件也能正确 apply', () => {
    const before = 'a\nb';
    const after = 'a\nB';
    write('target.txt', before);

    const result = createUnifiedDiff('target.txt', before, after);
    expect(applies(result?.patch ?? '')).toBe(true);
    expect(applyAndRead(result?.patch ?? '', 'target.txt')).toBe(after);
  });

  it('从无换行变为有换行', () => {
    const before = 'a\nb';
    const after = 'a\nb\n';
    write('target.txt', before);

    const result = createUnifiedDiff('target.txt', before, after);
    expect(applies(result?.patch ?? '')).toBe(true);
  });

  it('子目录文件也能 apply', () => {
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
    const before = 'export const a = 1;\n';
    const after = 'export const a = 2;\n';
    writeFileSync(join(repo, 'src', 'deep', 'x.ts'), before, 'utf8');

    const result = createUnifiedDiff('src/deep/x.ts', before, after);
    expect(applies(result?.patch ?? '')).toBe(true);
  });

  it('JSON 配置修改（真实场景）能 apply', () => {
    const before = `{
  "name": "demo",
  "version": "1.0.0",
  "dependencies": {
    "lodash": "^4.17.21",
    "moment": "^2.29.4"
  }
}
`;
    const after = `{
  "name": "demo",
  "version": "1.0.0",
  "dependencies": {
    "dayjs": "^1.11.10"
  }
}
`;
    write('package.json', before);
    const result = createUnifiedDiff('package.json', before, after);

    expect(applies(result?.patch ?? '')).toBe(true);
    expect(applyAndRead(result?.patch ?? '', 'package.json')).toBe(after);
  });
});

describe('createUnifiedDiff — 上下文与 hunk 分组', () => {
  it('默认带 3 行上下文', () => {
    const before = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n') + '\n';
    const after = before.replace('l10', 'CHANGED');

    const patch = createUnifiedDiff('f.txt', before, after)?.patch ?? '';
    // l7..l9 与 l11..l13 作为上下文出现
    for (const n of [7, 8, 9, 11, 12, 13]) expect(patch).toContain(` l${n}`);
  });

  it('相隔很远的修改产生多个 hunk', () => {
    const before = Array.from({ length: 60 }, (_, i) => `l${i}`).join('\n') + '\n';
    const after = before.replace('l3', 'A').replace('l50', 'B');

    const patch = createUnifiedDiff('f.txt', before, after)?.patch ?? '';
    expect(patch.match(/^@@ /gm)?.length).toBe(2);
  });

  it('相邻修改合并进同一个 hunk', () => {
    const before = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n') + '\n';
    const after = before.replace('l10', 'A').replace('l12', 'B');

    const patch = createUnifiedDiff('f.txt', before, after)?.patch ?? '';
    expect(patch.match(/^@@ /gm)?.length).toBe(1);
  });

  it('context=0 时不带上下文行', () => {
    const before = 'a\nb\nc\n';
    const after = 'a\nB\nc\n';

    const patch = createUnifiedDiff('f.txt', before, after, { context: 0 })?.patch ?? '';
    // 只看 hunk 体（跳过 `--- a/...` 头，那行本身含 " a"）
    const body = patch
      .split(/\r?\n/)
      .filter((l) => !l.startsWith('---') && !l.startsWith('+++') && !l.startsWith('@@') && l !== '');

    expect(body).toEqual(['-b', '+B']);
  });
});

describe('createUnifiedDiff — 大文件', () => {
  it('1000 行文件中改一行仍然只产出一个 hunk，且能 apply', () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i}`);
    const before = lines.join('\n') + '\n';
    const after = [...lines.slice(0, 500), 'CHANGED', ...lines.slice(501)].join('\n') + '\n';

    write('big.txt', before);
    const result = createUnifiedDiff('big.txt', before, after);

    expect(result?.patch.match(/^@@ /gm)?.length).toBe(1);
    expect(applies(result?.patch ?? '')).toBe(true);
  });
});

/**
 * hunk 头的行号。
 *
 * 判据是「`0` 只与 count 0 一起出现」：一侧有行时，起始行就是那一行的 1-based
 * 行号，与**首行是什么类型**无关。
 *
 * 早先按首行类型分支，于是"顶部删除"会产出 `+0`、"顶部插入"会产出 `-0`。
 * `git apply` 容忍这两种写法，所以 27 个用例一直是绿的 —— 但这个 bug 潜伏到
 * 路由分割（需要删掉文件开头那几行 import）才第一次浮出来。
 */
describe('createUnifiedDiff — hunk 头的行号', () => {
  const headerOf = (before: string, after: string): string => {
    const patch = createUnifiedDiff('a.txt', before, after)?.patch ?? '';
    return patch.split(/\r?\n/).find((line) => line.startsWith('@@')) ?? '';
  };

  it('顶部删除：新侧从 1 开始，不是 0', () => {
    expect(headerOf('A\nB\n', 'B\n')).toBe('@@ -1,2 +1 @@');
  });

  it('顶部插入：旧侧从 1 开始（0 只用于空侧）', () => {
    expect(headerOf('B\n', 'X\nB\n')).toBe('@@ -1 +1,2 @@');
  });

  it('整文件替换：两侧都从 1 开始', () => {
    expect(headerOf('A\n', 'Z\n')).toBe('@@ -1 +1 @@');
  });

  it('空文件 → 新文件：只有这时才用 0', () => {
    expect(headerOf('', 'A\n')).toBe('@@ -0,0 +1 @@');
  });
});
