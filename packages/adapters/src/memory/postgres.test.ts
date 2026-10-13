import { describe, expect, it } from 'vitest';
import type { BottleneckKind, CandidateLibraryEntry, FailureMemoryEntry } from '@yuki-byte18/shared';
import { CandidateSchema } from '@yuki-byte18/shared';
import { createPostgresMemory, type PgClientSurface } from './postgres.js';

/**
 * Postgres 路径的测试（M6 遗留：这一条以前是"写了但没跑过"）。
 *
 * ## 用一个记录 SQL 的假 client，而不是真数据库
 *
 * 这一组验的是**我们发出去的 SQL 长什么样**，而不是 Postgres 能不能执行它：
 * 占位符编号、`jsonb` 转换、`on conflict` 子句、参数顺序 ——
 * 这些错一个就会在生产上得到"参数对错位"（SQL 不报错，查出来的是别人的数据）
 * 或者"there is no parameter $3"。
 *
 * 真正需要真库才能验的东西（类型转换、索引、并发）如实留白：
 * 没有可连的数据库时不假装测过。
 */

interface Recorded {
  sql: string;
  params: readonly unknown[];
}

/** 按顺序回放预设结果集的假 client，同时记录收到的每一条 SQL */
function fakeClient(results: Array<Array<Record<string, unknown>>> = []): PgClientSurface & {
  recorded: Recorded[];
} {
  const recorded: Recorded[] = [];
  let call = 0;

  return {
    recorded,
    async query(sql, params) {
      recorded.push({ sql: sql.replace(/\s+/g, ' ').trim(), params: params ?? [] });
      const rows = results[Math.min(call, results.length - 1)] ?? [];
      call += 1;
      return { rows, rowCount: rows.length };
    },
  };
}

const candidate = CandidateSchema.parse({
  id: 'cand_1',
  runId: 'run_1',
  bottleneckIds: ['bn_1'],
  class: 'A',
  title: '压缩图片',
  description: 'x',
  origin: 'rule',
  ruleId: 'r1',
  promptVersion: null,
  changes: [{ type: 'asset', file: 'a.png', operation: 'compress', params: { quality: 80 } }],
  expectedGain: {},
  confidence: 0.8,
  risk: 'low',
  effort: 'low',
  reversible: true,
  recalledFrom: [],
  bottleneckKinds: ['OVERSIZED_IMAGE' as BottleneckKind],
});

describe('Postgres 记忆层 — SQL 生成', () => {
  it('迁移是幂等的：先建迁移表，再逐条记录', async () => {
    const client = fakeClient([[], []]);
    await createPostgresMemory({ client }).migrate();

    const sql = client.recorded.map((r) => r.sql).join('\n');
    expect(sql).toContain('create table if not exists perfpilot_schema_migrations');
    expect(sql).toContain('create table if not exists perfpilot_failure_memory');
    // 已应用的迁移会写进迁移表
    expect(sql).toContain('insert into perfpilot_schema_migrations');
  });

  it('表名前缀可覆盖（多项目共用一个库时用得上）', async () => {
    const client = fakeClient([[]]);
    await createPostgresMemory({ client, tablePrefix: 'myapp_' }).migrate();

    expect(client.recorded[0]?.sql).toContain('myapp_schema_migrations');
  });

  it('候选写入用 $n 占位符并把对象转成 jsonb', async () => {
    const client = fakeClient([[]]);
    const entry: CandidateLibraryEntry = {
      id: 'lib_1',
      bottleneckKind: 'OVERSIZED_IMAGE',
      candidate,
      actualGain: 12.5,
      succeeded: true,
      project: 'demo',
      techStack: 'vite+react',
      createdAt: '2026-01-17T14:25:30.000Z',
    };

    await createPostgresMemory({ client }).saveCandidate(entry);

    const sql = client.recorded[0]?.sql ?? '';
    expect(sql).toContain('$3::jsonb');
    expect(sql).toContain('on conflict (id) do update');
    // 参数顺序必须与占位符一一对应：错位不会报错，但会写进别人的数据
    expect(client.recorded[0]?.params).toEqual([
      'lib_1',
      'OVERSIZED_IMAGE',
      JSON.stringify(candidate),
      12.5,
      // 没给逐指标收益 → 写 null（列可以为空）
      null,
      // **布尔保持原生 boolean**：Postgres 的列是 boolean，塞整数会报类型错
      true,
      'demo',
      'vite+react',
      '2026-01-17T14:25:30.000Z',
    ]);
  });

  it('逐指标原始收益被存下来（校准 planner 估计的唯一数据来源）', async () => {
    const client = fakeClient([[]]);
    const entry: CandidateLibraryEntry = {
      id: 'lib_1',
      bottleneckKind: 'OVERSIZED_IMAGE',
      candidate,
      actualGain: 12.5,
      actualGainByMetric: { IMAGE_SIZE: -82_000 },
      succeeded: true,
      project: 'demo',
      techStack: 'vite+react',
      createdAt: '2026-01-17T14:25:30.000Z',
    };

    await createPostgresMemory({ client }).saveCandidate(entry);

    expect(client.recorded[0]?.sql).toContain('actual_gain_by_metric');
    expect(client.recorded[0]?.params[4]).toBe(JSON.stringify({ IMAGE_SIZE: -82_000 }));
  });

  it('SQLite 与 Postgres 的布尔编码不同（这是方言差异，不是笔误）', async () => {
    const entry: CandidateLibraryEntry = {
      id: 'lib_1',
      bottleneckKind: 'OVERSIZED_IMAGE',
      candidate,
      actualGain: null,
      succeeded: true,
      project: 'demo',
      techStack: 'vite+react',
      createdAt: '2026-01-17T14:25:30.000Z',
    };

    const { candidateParams } = await import('./mapping.js');

    // SQLite 没有 boolean 类型，node:sqlite 连 JS 的 true 都不收
    expect(candidateParams(entry, 'sqlite')[5]).toBe(1);
    expect(candidateParams(entry, 'postgres')[5]).toBe(true);
  });

  it('召回的 IN 列表接着已用参数继续编号（否则报 no parameter $3）', async () => {
    const client = fakeClient([[], [], [], []]);
    await createPostgresMemory({ client }).recallCandidates({
      project: 'demo',
      bottleneckKinds: ['OVERSIZED_IMAGE', 'UNCOMPRESSED_IMAGE'],
      techStack: 'vite+react',
      limit: 20,
    });

    const [byProject, byKind, byTech] = client.recorded;

    // 按项目：project 占 $1，kind 列表是 $2/$3，limit 是 $4
    expect(byProject?.sql).toContain('bottleneck_kind in ($2, $3) limit $4');
    expect(byProject?.params).toEqual(['demo', 'OVERSIZED_IMAGE', 'UNCOMPRESSED_IMAGE', 20]);

    // 按问题类型：没有前置参数，kind 从 $1 开始，limit 是 $3
    expect(byKind?.sql).toContain('bottleneck_kind in ($1, $2) limit $3');

    // 按技术栈：techStack 占 $1，kind 是 $2/$3
    expect(byTech?.sql).toContain('tech_stack = $1 and bottleneck_kind in ($2, $3)');
    expect(byTech?.params).toEqual(['vite+react', 'OVERSIZED_IMAGE', 'UNCOMPRESSED_IMAGE', 20]);
  });

  it('瓶颈类型为空时不发查询（`in ()` 是语法错误）', async () => {
    const client = fakeClient([[]]);
    const result = await createPostgresMemory({ client }).recallCandidates({
      project: 'demo',
      bottleneckKinds: [],
      techStack: 'vite+react',
      limit: 20,
    });

    expect(result).toEqual({ byProject: [], byKind: [], byTechStack: [], failures: [] });
    // 一条 SQL 都不该发出去
    expect(client.recorded).toEqual([]);
  });

  it('失败记忆去重：重复写同一条不报错', async () => {
    const client = fakeClient([[]]);
    const entry: FailureMemoryEntry = {
      id: 'fail_1',
      candidateFingerprint: 'k|asset',
      bottleneckKind: 'OVERSIZED_IMAGE',
      failureReason: '收益不足',
      project: 'demo',
      techStack: 'vite+react',
      failedAt: '2026-01-17T14:25:30.000Z',
    };

    await createPostgresMemory({ client }).saveFailure(entry);

    expect(client.recorded[0]?.sql).toContain('on conflict (id) do nothing');
  });

  it('撤销失败记忆返回受影响行数（rowCount，不是 rows.length）', async () => {
    const client: PgClientSurface = {
      async query() {
        return { rows: [], rowCount: 3 };
      },
    };

    const removed = await createPostgresMemory({ client }).forgetFailures({ project: 'demo', all: true });
    expect(removed).toBe(3);
  });

  it('撤销时既没给指纹也没给 all → 什么都不做（避免误删整表）', async () => {
    const client = fakeClient([[]]);

    const removed = await createPostgresMemory({ client }).forgetFailures({ project: 'demo' });

    expect(removed).toBe(0);
    expect(client.recorded).toEqual([]);
  });
});
