import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config-loader.js';

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'perfpilot-config-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function load(yaml: string) {
  await writeFile(join(dir, '.perfpilot.yml'), yaml, 'utf8');
  return loadConfig({ cwd: dir });
}

const MINIMAL = `project:
  name: demo
target:
  url: https://example.com
`;

/**
 * YAML 里"只写键、不写值"得到的是 `null`，而 zod 的 `.default()` 只认 `undefined`。
 *
 * 这组用例守住的是 `.perfpilot.yml.example` 里那句承诺 ——
 * 「`repo` 留空表示未接入 SCM」。承诺与实现对不上时，用户拿到的是
 * `Expected string, received null`，而错误信息完全没告诉他要写空串。
 */
describe('loadConfig — YAML 留空等于没写', () => {
  it('repo / branch 留空回落成默认值，而不是校验失败', async () => {
    const { config } = await load(`${MINIMAL}  repo:\n  branch:\n`);

    expect(config.target.repo).toBe('');
    expect(config.target.branch).toBe('main');
  });

  it('整段留空时，段内默认值全部生效', async () => {
    const { config } = await load(`${MINIMAL}collect:\nreport:\nllm:\n`);

    expect(config.collect.runs).toBe(1);
    expect(config.report.format).toEqual(['markdown', 'json']);
    // llm 本身可空，留空仍然解析成 null（而不是"缺字段"）
    expect(config.llm).toBeNull();
  });

  it('嵌套对象里的留空同样回落', async () => {
    const { config } = await load(`${MINIMAL}optimization:\n  auto_fix:\n  suggest_only:\n`);

    expect(config.optimization.auto_fix).toEqual([]);
    expect(config.optimization.suggest_only).toEqual([]);
  });

  it('类型写错照样报错 —— 放行的是"没写"，不是"写错"', async () => {
    await expect(load(`${MINIMAL}  repo: 123\n`)).rejects.toThrow(/repo/);
    await expect(load(`${MINIMAL}  url: 123\n`)).rejects.toThrow(/url/);
  });

  it('数组元素里的 null 不被吞掉（那是写错了，不是没写）', async () => {
    await expect(load(`${MINIMAL}  routes:\n    - /\n    -\n`)).rejects.toThrow(/routes/);
  });
});
