import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as NodeSqlite from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  CandidateLibraryEntry,
  FailureMemoryEntry,
  MemoryPort,
  ProjectProfile,
} from '@yuki-byte18/shared';
import { createCandidateFixture } from './test-fixtures.js';
import { createSqliteMemory, MIGRATIONS, type SqliteMemory } from './sqlite.js';

/**
 * SQLite 记忆层的验收测试（M6 验收 1/2/5）。
 *
 * 用**真实数据库文件**而不是 `:memory:` 为主：验收 1 的关键是
 * "迁移可重复执行"，而那只有关了连接再打开同一个文件才能验 ——
 * 内存库每次都是全新的，永远看不出迁移是不是幂等。
 */

let dir = '';
const open: SqliteMemory[] = [];

afterEach(async () => {
  for (const db of open.splice(0)) db.close();
  if (dir !== '') await rm(dir, { recursive: true, force: true });
  dir = '';
});

async function tempDbPath(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'perfpilot-mem-'));
  return join(dir, '.perfpilot', 'memory.db');
}

function track(db: SqliteMemory): SqliteMemory {
  open.push(db);
  return db;
}

const candidateEntry = (
  overrides: Partial<CandidateLibraryEntry> = {},
): CandidateLibraryEntry => ({
  id: 'lib_1',
  bottleneckKind: 'OVERSIZED_IMAGE',
  candidate: createCandidateFixture(),
  actualGain: 12.5,
  succeeded: true,
  project: 'demo',
  techStack: 'vite+react',
  createdAt: '2026-01-17T14:25:30.000Z',
  ...overrides,
});

const profile = (overrides: Partial<ProjectProfile> = {}): ProjectProfile => ({
  project: 'demo',
  techStack: 'vite+react',
  buildTool: 'vite',
  framework: 'react',
  baselineMetrics: { LCP: 2800 },
  updatedAt: '2026-01-17T14:25:30.000Z',
  ...overrides,
});

// ─────────────────────────────────────────────────────────────────────
// 验收 1：四张表 + 迁移幂等
// ─────────────────────────────────────────────────────────────────────

describe('M6 验收 1 — 建表与幂等迁移', () => {
  it('四张表建成，且迁移可重复执行（关掉再打开同一个库文件）', async () => {
    const url = await tempDbPath();

    const first = track(createSqliteMemory({ url }));
    expect(first.appliedMigrations()).toEqual(MIGRATIONS.map((m) => m.id));

    // 写一条数据，用来证明第二次打开**没有重建**数据库
    await first.saveProfile(profile());
    first.close();
    open.splice(open.indexOf(first), 1);

    const second = track(createSqliteMemory({ url }));
    // 迁移没有重复应用
    expect(second.appliedMigrations()).toEqual(MIGRATIONS.map((m) => m.id));
    // 数据还在 —— 幂等 ≠ 清空重来
    expect((await second.getProfile('demo'))?.techStack).toBe('vite+react');
  });

  it('四类数据各能写入并读回（表结构对得上）', async () => {
    const db = track(createSqliteMemory({ url: ':memory:' }));

    await db.saveDiagnosis({
      id: 'diag_1',
      runId: 'run_1',
      project: 'demo',
      route: '/',
      bottleneckKinds: ['OVERSIZED_IMAGE'],
      createdAt: '2026-01-17T14:25:30.000Z',
    });
    await db.saveCandidate(candidateEntry());
    await db.saveProfile(profile());
    await db.saveFailure({
      id: 'fail_1',
      candidateFingerprint: 'OVERSIZED_IMAGE|asset',
      bottleneckKind: 'OVERSIZED_IMAGE',
      failureReason: '收益 0.4 < min_gain 5',
      project: 'demo',
      techStack: 'vite+react',
      failedAt: '2026-01-17T14:25:30.000Z',
    });

    const diagnoses = await db.listDiagnoses('demo', '/', 10);
    expect(diagnoses).toHaveLength(1);
    expect(diagnoses[0]?.bottleneckKinds).toEqual(['OVERSIZED_IMAGE']);

    // 候选是 JSON 列，读回来必须过 schema 且字段完整
    const recalled = await db.recallCandidates({
      project: 'demo',
      bottleneckKinds: ['OVERSIZED_IMAGE'],
      techStack: 'vite+react',
      limit: 10,
    });
    expect(recalled.byKind[0]?.candidate.changes).toHaveLength(1);
    expect(recalled.byKind[0]?.actualGain).toBe(12.5);

    expect((await db.getProfile('demo'))?.baselineMetrics).toEqual({ LCP: 2800 });
    expect(await db.listFailures('demo', 10)).toHaveLength(1);
  });

  it('画像按项目 upsert，不会越写越多', async () => {
    const db = track(createSqliteMemory({ url: ':memory:' }));

    await db.saveProfile(profile());
    await db.saveProfile(profile({ techStack: 'next', updatedAt: '2026-01-18T00:00:00.000Z' }));

    const current = await db.getProfile('demo');
    expect(current?.techStack).toBe('next');
    expect(current?.updatedAt).toBe('2026-01-18T00:00:00.000Z');
  });
});

// ─────────────────────────────────────────────────────────────────────
// 验收 2：三条召回路径
// ─────────────────────────────────────────────────────────────────────

describe('M6 验收 2 — 项目 / 问题类型 / 技术栈三条召回路径', () => {
  /**
   * 三条路径各自只该命中自己那一维：
   * 按项目召回混进别的项目的历史，会让"这个改法在我们这儿成功过"变成一句假话。
   */
  async function seeded(): Promise<MemoryPort> {
    const db = track(createSqliteMemory({ url: ':memory:' }));
    await db.saveCandidate(candidateEntry({ id: 'same_project', project: 'demo', techStack: 'vite+react' }));
    await db.saveCandidate(candidateEntry({ id: 'other_project', project: 'other', techStack: 'vite+react' }));
    await db.saveCandidate(
      candidateEntry({ id: 'other_tech', project: 'demo', techStack: 'webpack+react' }),
    );
    await db.saveCandidate(
      candidateEntry({ id: 'other_kind', bottleneckKind: 'LARGE_JS_BUNDLE', project: 'demo', techStack: 'vite+react' }),
    );
    return db;
  }

  it('按项目召回：只要本项目的', async () => {
    const db = await seeded();
    const recall = await db.recallCandidates({
      project: 'demo',
      bottleneckKinds: ['OVERSIZED_IMAGE'],
      techStack: 'vite+react',
      limit: 10,
    });

    expect(recall.byProject.map((e) => e.id)).toEqual(['same_project', 'other_tech']);
  });

  it('按问题类型召回：跨项目、跨技术栈都能命中', async () => {
    const db = await seeded();
    const recall = await db.recallCandidates({
      project: 'demo',
      bottleneckKinds: ['OVERSIZED_IMAGE'],
      techStack: 'vite+react',
      limit: 10,
    });

    expect(recall.byKind.map((e) => e.id).sort()).toEqual([
      'other_project',
      'other_tech',
      'same_project',
    ]);
  });

  it('按技术栈召回：只认技术栈相同的', async () => {
    const db = await seeded();
    const recall = await db.recallCandidates({
      project: 'demo',
      bottleneckKinds: ['OVERSIZED_IMAGE'],
      techStack: 'vite+react',
      limit: 10,
    });

    expect(recall.byTechStack.map((e) => e.id)).toEqual(['same_project', 'other_project']);
  });

  it('瓶颈类型为空时不查库、不报错（`IN ()` 是语法错误）', async () => {
    const db = await seeded();
    const recall = await db.recallCandidates({
      project: 'demo',
      bottleneckKinds: [],
      techStack: 'vite+react',
      limit: 10,
    });

    expect(recall).toEqual({ byProject: [], byKind: [], byTechStack: [], failures: [] });
  });
});

// ─────────────────────────────────────────────────────────────────────
// 失败记忆 + 跨进程存活
// ─────────────────────────────────────────────────────────────────────

describe('M6 — 失败记忆与持久化', () => {
  it('失败记忆按项目 + 指纹命中，换项目不命中', async () => {
    const db = track(createSqliteMemory({ url: ':memory:' }));
    const entry: FailureMemoryEntry = {
      id: 'fail_1',
      candidateFingerprint: 'OVERSIZED_IMAGE|asset',
      bottleneckKind: 'OVERSIZED_IMAGE',
      failureReason: '引入了新错误 3 > max_new_errors 0',
      project: 'demo',
      techStack: 'vite+react',
      failedAt: '2026-01-17T14:25:30.000Z',
    };
    await db.saveFailure(entry);

    expect(await db.hasFailedFailure('OVERSIZED_IMAGE|asset', 'demo')).toBe(true);
    // 经验按项目隔离：别的项目上失败过，不代表这里也不行
    expect(await db.hasFailedFailure('OVERSIZED_IMAGE|asset', 'other')).toBe(false);
    expect(await db.hasFailedFailure('别的指纹', 'demo')).toBe(false);
  });

  it('同一个失败重复写入不会变成两条（同一轮 run 跑两次）', async () => {
    const db = track(createSqliteMemory({ url: ':memory:' }));
    const entry: FailureMemoryEntry = {
      id: 'fail_1',
      candidateFingerprint: 'k|asset',
      bottleneckKind: 'OVERSIZED_IMAGE',
      failureReason: '收益不足',
      project: 'demo',
      techStack: 'vite+react',
      failedAt: '2026-01-17T14:25:30.000Z',
    };

    await db.saveFailure(entry);
    await db.saveFailure({ ...entry, failureReason: '收益不足（第二次）' });

    const failures = await db.listFailures('demo', 10);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.failureReason).toBe('收益不足（第二次）');
  });

  it('记忆能跨"进程"存活 —— 这正是它存在的意义', async () => {
    const url = await tempDbPath();

    const writer = track(createSqliteMemory({ url }));
    await writer.saveFailure({
      id: 'fail_1',
      candidateFingerprint: 'OVERSIZED_IMAGE|asset',
      bottleneckKind: 'OVERSIZED_IMAGE',
      failureReason: '收益 0.4 < min_gain 5',
      project: 'demo',
      techStack: 'vite+react',
      failedAt: '2026-01-17T14:25:30.000Z',
    });
    writer.close();
    open.splice(open.indexOf(writer), 1);

    // 下一轮运行：全新连接，仍然记得上次失败过
    const reader = track(createSqliteMemory({ url }));
    expect(await reader.hasFailedFailure('OVERSIZED_IMAGE|asset', 'demo')).toBe(true);
    expect((await reader.listFailures('demo', 10))[0]?.failureReason).toContain('min_gain');
  });

  it('库里被写坏的数据会被 schema 拦下，而不是变成一条类型谎话', async () => {
    const url = await tempDbPath();
    const db = track(createSqliteMemory({ url }));
    await db.saveCandidate(candidateEntry());
    db.close();
    open.splice(open.indexOf(db), 1);

    // 模拟被别的工具/手工写坏的 JSON 列
    const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof NodeSqlite;
    const raw = new DatabaseSync(url);
    raw.prepare('update candidate_library set candidate = ?').run('{"id":"x"}');
    raw.close();

    const reopened = track(createSqliteMemory({ url }));
    await expect(
      reopened.recallCandidates({
        project: 'demo',
        bottleneckKinds: ['OVERSIZED_IMAGE'],
        techStack: 'vite+react',
        limit: 10,
      }),
    ).rejects.toThrow(/校验失败/);
  });
});
