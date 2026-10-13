import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PerfPilotError } from '@yuki-byte18/shared';
import { compareRunRecency, createFileRunStore } from './file-run-store.js';
import { metric, runFixture } from '../fixtures/index.js';

let dir: string;
let store: ReturnType<typeof createFileRunStore>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'perfpilot-store-'));
  store = createFileRunStore({ baseDir: dir });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('FileRunStore — 基本读写', () => {
  it('save 写出 run.json 并可完整读回', async () => {
    const run = runFixture({ id: 'run_a', metrics: [metric('LCP', 3000)] });
    const saved = await store.save(run);

    expect(existsSync(saved.runFile)).toBe(true);
    const loaded = await store.load('run_a');

    expect(loaded?.id).toBe('run_a');
    expect(loaded?.metrics[0]?.value).toBe(3000);
    expect(loaded?.metrics[0]?.source).toBe('lighthouse');
  });

  it('load 不存在的 run 返回 null 而不是抛错', async () => {
    expect(await store.load('run_missing')).toBeNull();
  });

  it('prepare 可重复调用（幂等），采集阶段需要提前建目录', async () => {
    await store.prepare('run_b');
    const second = await store.prepare('run_b');

    expect(existsSync(second.dir)).toBe(true);
  });

  it('list 按时间倒序，忽略非 run 目录', async () => {
    await store.save(runFixture({ id: 'run_old', startedAt: '2026-01-01T00:00:00.000Z' }));
    await store.save(runFixture({ id: 'run_new', startedAt: '2026-06-01T00:00:00.000Z' }));
    await mkdir(join(dir, 'runs', 'not-a-run'), { recursive: true });

    const summaries = await store.list();
    expect(summaries.map((s) => s.id)).toEqual(['run_new', 'run_old']);
  });

  it('空目录下列表为空，不抛错', async () => {
    expect(await store.list()).toEqual([]);
  });
});

describe('FileRunStore — 报告与产物落盘', () => {
  it('saveReport 落盘并返回绝对路径', async () => {
    await store.prepare('run_c');
    const path = await store.saveReport('run_c', {
      format: 'markdown',
      filename: 'report.md',
      content: '# hello',
    });

    expect(path).toContain('report.md');
    expect(await readFile(path, 'utf8')).toBe('# hello');
  });

  it('saveArtifacts 写入产物与索引', async () => {
    await store.prepare('run_d');
    await store.saveArtifacts('run_d', [
      {
        adapter: 'lighthouse',
        kind: 'lighthouse-result',
        payload: { big: 'json' },
        collectedAt: '2026-01-17T14:25:30.000Z',
        route: '/',
        device: 'mobile',
        file: 'lighthouse-root.json',
      },
      {
        adapter: 'web-vitals',
        kind: 'web-vitals',
        payload: { metrics: {} },
        collectedAt: '2026-01-17T14:25:30.000Z',
        route: '/',
        device: 'mobile',
        file: null,
      },
    ]);

    const artifactDir = join(dir, 'runs', 'run_d', 'artifacts');
    expect(existsSync(join(artifactDir, 'lighthouse-root.json'))).toBe(true);
    // file 为 null 时用序号命名，不会全部撞成同一个文件名
    expect(existsSync(join(artifactDir, '01-web-vitals.json'))).toBe(true);

    const index = JSON.parse(await readFile(join(artifactDir, 'index.json'), 'utf8')) as unknown[];
    expect(index).toHaveLength(2);
  });

  it('无产物时 saveArtifacts 是空操作', async () => {
    await store.prepare('run_e');
    await store.saveArtifacts('run_e', []);
    expect(existsSync(join(dir, 'runs', 'run_e', 'artifacts'))).toBe(false);
  });

  it('产物文件名里的路径分隔符被清理，不会写到目录外', async () => {
    await store.prepare('run_f');
    await store.saveArtifacts('run_f', [
      {
        adapter: 'lighthouse',
        kind: 'lighthouse-result',
        payload: {},
        collectedAt: '2026-01-17T14:25:30.000Z',
        route: '/',
        device: 'mobile',
        file: '../../escaped.json',
      },
    ]);

    expect(existsSync(join(dir, 'runs', 'run_f', 'artifacts', 'escaped.json'))).toBe(true);
    expect(existsSync(join(dir, 'runs', 'escaped.json'))).toBe(false);
  });
});

describe('FileRunStore — saveJson / loadJson 的路径语义', () => {
  /**
   * 这一组锁死一个真实发生过的缺陷：旧实现把目录段整个丢掉，
   * 于是 `executions/<id>.json` 与 `verifications/<id>.json`
   * **落到同一个文件**，验证记录把执行记录覆盖了 —— 逐候选的审计留痕丢了一半。
   *
   * 而内存实现不做扁平化，所以单测跑在内存实现上永远发现不了。
   */
  it('带子目录的名字保留目录结构，不再与其它用途撞名', async () => {
    const runId = 'run_paths';
    await store.prepare(runId);

    await store.saveJson(runId, `executions/cand_1.json`, { kind: 'execution' });
    await store.saveJson(runId, `verifications/cand_1.json`, { kind: 'verification' });

    const execution = await store.loadJson(runId, `executions/cand_1.json`);
    const verification = await store.loadJson(runId, `verifications/cand_1.json`);

    // 两者都能读回各自的内容 —— 这就是修复前丢掉的东西
    expect(execution).toEqual({ kind: 'execution' });
    expect(verification).toEqual({ kind: 'verification' });

    // 磁盘上确实是两个不同的文件
    const base = join(dir, 'runs', runId);
    expect(existsSync(join(base, 'executions', 'cand_1.json'))).toBe(true);
    expect(existsSync(join(base, 'verifications', 'cand_1.json'))).toBe(true);
  });

  it('同一个 key 重复写是覆盖（幂等），不产生第二份', async () => {
    const runId = 'run_twice';
    await store.prepare(runId);

    await store.saveJson(runId, 'gate.json', { passed: false });
    await store.saveJson(runId, 'gate.json', { passed: true });

    expect(await store.loadJson(runId, 'gate.json')).toEqual({ passed: true });
  });

  it('无目录的名字仍然落在 run 目录根部（既有布局不变）', async () => {
    const runId = 'run_flat';
    await store.saveJson(runId, 'candidates.json', []);

    expect(existsSync(join(dir, 'runs', runId, 'candidates.json'))).toBe(true);
  });

  it('路径穿越被清洗掉，读不到 run 目录之外的文件', async () => {
    const runId = 'run_escape';
    await store.prepare(runId);

    // 上层目录放一个"秘密"文件
    await writeFile(join(dir, 'secret.json'), JSON.stringify({ secret: true }), 'utf8');

    await store.saveJson(runId, '../../../../secret.json', { overwritten: true });

    // 秘密文件没被改写（它本该落在 run 目录之内，而不是穿越出去）
    expect(JSON.parse(await readFile(join(dir, 'secret.json'), 'utf8'))).toEqual({ secret: true });
    // 且读的时候同样穿越不出去
    expect(await store.loadJson(runId, '../../../../secret.json')).not.toEqual({ secret: true });
  });

  it('全是被丢弃的段时回落到默认名，而不是拼出一个空路径', async () => {
    const runId = 'run_dots';
    await store.saveJson(runId, '../..', { ok: true });

    expect(await store.loadJson(runId, '../..')).toEqual({ ok: true });
  });

  it('不存在的键返回 null（与内存实现一致）', async () => {
    await store.prepare('run_missing_key');
    expect(await store.loadJson('run_missing_key', 'nope/x.json')).toBeNull();
  });
});

describe('FileRunStore — 安全与健壮性', () => {
  it('非法 runId 被拒绝，挡住路径穿越', async () => {
    await expect(store.load('../../../etc/passwd')).rejects.toThrow(PerfPilotError);
    await expect(store.prepare('a/b')).rejects.toThrow(PerfPilotError);
    await expect(store.save(runFixture({ id: '..' }))).rejects.toThrow(PerfPilotError);
  });

  it('单个 run.json 损坏不会让 list 整体失败', async () => {
    await store.save(runFixture({ id: 'run_ok', startedAt: '2026-01-01T00:00:00.000Z' }));
    await mkdir(join(dir, 'runs', 'run_broken'), { recursive: true });
    await writeFile(join(dir, 'runs', 'run_broken', 'run.json'), '{ not json', 'utf8');

    const summaries = await store.list();
    expect(summaries.map((s) => s.id)).toEqual(['run_ok']);
  });

  it('内容损坏的 run.json 在 load 时抛 STORE_FAILED（而不是静默返回半个对象）', async () => {
    await mkdir(join(dir, 'runs', 'run_bad'), { recursive: true });
    await writeFile(
      join(dir, 'runs', 'run_bad', 'run.json'),
      JSON.stringify({ id: 'run_bad', schemaVersion: 1 }),
      'utf8',
    );

    await expect(store.load('run_bad')).rejects.toThrow(PerfPilotError);
  });
});

describe('FileRunStore — 基线查找', () => {
  it('latestFor 只认同一 project + route + device', async () => {
    await store.save(runFixture({ id: 'run_1', route: '/', project: 'shop' }));
    await store.save(runFixture({ id: 'run_2', route: '/other', project: 'shop' }));
    await store.save(runFixture({ id: 'run_3', route: '/', project: 'blog' }));

    const found = await store.latestFor('shop', '/', 'mobile');
    expect(found?.id).toBe('run_1');
  });

  it('无匹配时返回 null', async () => {
    expect(await store.latestFor('nope', '/', 'mobile')).toBeNull();
  });

  it('同一毫秒的两次运行按 id 兜底排序，结果确定', async () => {
    const same = '2026-01-17T14:25:30.000Z';
    await store.save(runFixture({ id: 'run_aaa', startedAt: same }));
    await store.save(runFixture({ id: 'run_zzz', startedAt: same }));

    const list = await store.list();
    expect(list.map((s) => s.id)).toEqual(['run_zzz', 'run_aaa']);
  });
});

describe('compareRunRecency', () => {
  it('时间新的在前', () => {
    expect(
      compareRunRecency(
        { startedAt: '2026-06-01T00:00:00.000Z', id: 'a' },
        { startedAt: '2026-01-01T00:00:00.000Z', id: 'b' },
      ),
    ).toBeLessThan(0);
  });

  it('时间相同时比较 id，保证顺序稳定（否则基线会随机挑中旧的）', () => {
    const t = '2026-01-01T00:00:00.000Z';
    expect(compareRunRecency({ startedAt: t, id: 'b' }, { startedAt: t, id: 'a' })).toBeLessThan(0);
    expect(compareRunRecency({ startedAt: t, id: 'a' }, { startedAt: t, id: 'a' })).toBe(0);
  });
});
