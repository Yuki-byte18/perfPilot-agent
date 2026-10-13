import type {
  CandidateLibraryEntry,
  DiagnosisHistoryEntry,
  FailureMemoryEntry,
  MemoryPort,
  ProjectProfile,
  RecallResult,
} from '@yuki-byte18/shared';
import {
  candidateParams,
  diagnosisParams,
  failureParams,
  profileParams,
  toCandidateEntry,
  toDiagnosis,
  toFailure,
  toProfile,
  type Row,
  type SqlParam,
} from './mapping.js';

/**
 * Postgres 记忆层**骨架**（README §10）。
 *
 * ## 这是一个诚实的"半成品"，说清楚它到哪一步
 *
 * - **写完的**：四张表的 SQL、九个方法的查询、占位符与行映射。
 *   与 SQLite 实现共用 `mapping.ts`，因此"一行长什么样"两边一致。
 * - **没做的**：驱动安装、连接池、真实数据库上的验证。
 *   因此 `createPostgresMemory` **不假装能用** —— 它要求调用方注入一个
 *   已经连好的 client，注入不了就抛错，而不是返回一个跑起来才炸的实现。
 *
 * M6 的验收标准只要求"骨架"，而这一步刻意停在这里的理由是：
 * 服务端（`server`）属于 M7，现在没有 Postgres 可连。
 * 写一个从未跑过的完整实现，比写一个明确标注未验证的骨架更危险 ——
 * 前者会让人以为它已经能用。
 *
 * ## 为什么驱动用注入而不是 import
 *
 * 与 `core/llm` 同一个理由：写成字面量 `import('pg')` 时 TypeScript 会去解析
 * 那个包的类型，没装就报 TS2307、整包编译不过 —— 可选依赖就悄悄变成了硬依赖。
 * 因此这里只声明我们用到的那一小块契约（`PgClientSurface`）。
 */

/** `pg` 的 `Client` / `Pool` 里我们真正用到的那一部分 */
export interface PgClientSurface {
  query(
    sql: string,
    params?: readonly SqlParam[],
  ): Promise<{
    rows: Array<Record<string, unknown>>;
    /** 受影响行数。`delete` 的返回值靠它，缺了就没法告诉用户"清掉了几条" */
    rowCount?: number | null;
  }>;
}

export interface PostgresMemoryOptions {
  client: PgClientSurface;
  /** 表名前缀，默认 `perfpilot_`；多项目共用一个库时用得上 */
  tablePrefix?: string;
}

/**
 * 建表语句（与 SQLite 版结构一致，类型换成 Postgres 的）。
 *
 * 与 SQLite 一样是幂等的：服务端可能被多个实例同时启动，
 * 迁移必须能重复执行。
 */
export const POSTGRES_MIGRATIONS: readonly { id: string; sql: string }[] = [
  {
    id: '001-init',
    sql: `
      create table if not exists perfpilot_schema_migrations (
        id         text primary key,
        applied_at timestamptz not null default now()
      );

      create table if not exists perfpilot_diagnoses (
        id               text primary key,
        run_id           text not null,
        project          text not null,
        route            text not null,
        bottleneck_kinds jsonb not null,
        created_at       timestamptz not null
      );
      create index if not exists perfpilot_diagnoses_project_route
        on perfpilot_diagnoses (project, route, created_at desc);

      create table if not exists perfpilot_candidate_library (
        id              text primary key,
        bottleneck_kind text not null,
        candidate       jsonb not null,
        actual_gain     double precision,
        actual_gain_by_metric jsonb,
        succeeded       boolean not null,
        project         text not null,
        tech_stack      text not null,
        created_at      timestamptz not null
      );
      create index if not exists perfpilot_candidates_project
        on perfpilot_candidate_library (project, bottleneck_kind);
      create index if not exists perfpilot_candidates_kind
        on perfpilot_candidate_library (bottleneck_kind);
      create index if not exists perfpilot_candidates_tech
        on perfpilot_candidate_library (tech_stack, bottleneck_kind);

      create table if not exists perfpilot_project_profiles (
        project          text primary key,
        tech_stack       text not null,
        build_tool       text not null,
        framework        text not null,
        baseline_metrics jsonb not null,
        updated_at       timestamptz not null
      );

      create table if not exists perfpilot_failure_memory (
        id                    text primary key,
        candidate_fingerprint text not null,
        bottleneck_kind       text not null,
        failure_reason        text not null,
        project               text not null,
        tech_stack            text not null,
        failed_at             timestamptz not null
      );
      create index if not exists perfpilot_failures_fingerprint
        on perfpilot_failure_memory (project, candidate_fingerprint);
      create index if not exists perfpilot_failures_kind
        on perfpilot_failure_memory (bottleneck_kind);
    `,
  },
];

export interface PostgresMemory extends MemoryPort {
  migrate(): Promise<void>;
}

/**
 * 从 `$start + 1` 开始生成 `count` 个 `$n` 占位符。
 *
 * Postgres 的占位符是**带编号**的，动态 `IN` 列表必须接着已用参数继续编号，
 * 否则要么报 "there is no parameter $1"，要么把参数对错位 —— 后者更糟：
 * SQL 不报错，但查出来的是别人的数据。
 */
function dollarList(start: number, count: number): string {
  return Array.from({ length: count }, (_, i) => `$${start + i + 1}`).join(', ');
}

export function createPostgresMemory(options: PostgresMemoryOptions): PostgresMemory {
  const { client } = options;
  const prefix = options.tablePrefix ?? 'perfpilot_';

  const table = (name: string): string => `${prefix}${name}`;

  const all = async (sql: string, params: SqlParam[] = []): Promise<Row[]> => {
    const result = await client.query(sql, params);
    return result.rows as Row[];
  };

  const one = async (sql: string, params: SqlParam[] = []): Promise<Row | null> =>
    (await all(sql, params))[0] ?? null;

  const byKinds = async (
    where: string,
    params: SqlParam[],
    kinds: readonly string[],
    limit: number,
  ): Promise<CandidateLibraryEntry[]> => {
    if (kinds.length === 0) return [];
    // `$n` 必须接着已用参数往下编号：where 里已经占了 $1（如果 where 用了参数）
    const list = dollarList(params.length, kinds.length);
    const limitRef = `$${params.length + kinds.length + 1}`;
    const rows = await all(
      `select * from ${table('candidate_library')} where ${where} bottleneck_kind in (${list}) limit ${limitRef}`,
      [...params, ...kinds, limit],
    );
    return rows.map(toCandidateEntry);
  };

  return {
    async migrate(): Promise<void> {
      await all(
        `create table if not exists ${table('schema_migrations')} (id text primary key, applied_at timestamptz not null default now())`,
      );
      const applied = new Set((await all(`select id from ${table('schema_migrations')}`)).map((r) => String(r['id'])));

      for (const migration of POSTGRES_MIGRATIONS) {
        if (applied.has(migration.id)) continue;
        await all(migration.sql);
        await all(`insert into ${table('schema_migrations')} (id) values ($1) on conflict do nothing`, [
          migration.id,
        ]);
      }
    },

    async saveDiagnosis(entry: DiagnosisHistoryEntry): Promise<void> {
      const p = diagnosisParams(entry);
      await all(
        `insert into ${table('diagnoses')} (id, run_id, project, route, bottleneck_kinds, created_at)
         values ($1, $2, $3, $4, $5::jsonb, $6)
         on conflict (id) do update set bottleneck_kinds = excluded.bottleneck_kinds`,
        p,
      );
    },

    async listDiagnoses(project, route, limit) {
      return (
        await all(
          `select * from ${table('diagnoses')} where project = $1 and route = $2
           order by created_at desc limit $3`,
          [project, route, limit],
        )
      ).map(toDiagnosis);
    },

    async saveCandidate(entry: CandidateLibraryEntry): Promise<void> {
      await all(
        `insert into ${table('candidate_library')}
         (id, bottleneck_kind, candidate, actual_gain, actual_gain_by_metric, succeeded, project, tech_stack, created_at)
         values ($1, $2, $3::jsonb, $4, $5::jsonb, $6, $7, $8, $9)
         on conflict (id) do update set actual_gain = excluded.actual_gain, succeeded = excluded.succeeded`,
        candidateParams(entry, 'postgres'),
      );
    },

    async recallCandidates({ project, bottleneckKinds, techStack, limit }): Promise<RecallResult> {
      return {
        byProject: await byKinds('project = $1 and', [project], bottleneckKinds, limit),
        byKind: await byKinds('', [], bottleneckKinds, limit),
        byTechStack: await byKinds('tech_stack = $1 and', [techStack], bottleneckKinds, limit),
        failures:
          bottleneckKinds.length === 0
            ? []
            : (
                await all(
                  `select * from ${table('failure_memory')} where bottleneck_kind in (${dollarList(0, bottleneckKinds.length)})`,
                  [...bottleneckKinds],
                )
              ).map(toFailure),
      };
    },

    async saveProfile(profile: ProjectProfile): Promise<void> {
      await all(
        `insert into ${table('project_profiles')}
         (project, tech_stack, build_tool, framework, baseline_metrics, updated_at)
         values ($1, $2, $3, $4, $5::jsonb, $6)
         on conflict (project) do update set
           tech_stack = excluded.tech_stack,
           build_tool = excluded.build_tool,
           framework = excluded.framework,
           baseline_metrics = excluded.baseline_metrics,
           updated_at = excluded.updated_at`,
        profileParams(profile),
      );
    },

    async getProfile(project) {
      const row = await one(`select * from ${table('project_profiles')} where project = $1`, [project]);
      return row === null ? null : toProfile(row);
    },

    async saveFailure(entry: FailureMemoryEntry): Promise<void> {
      await all(
        `insert into ${table('failure_memory')}
         (id, candidate_fingerprint, bottleneck_kind, failure_reason, project, tech_stack, failed_at)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (id) do nothing`,
        failureParams(entry),
      );
    },

    async hasFailedFailure(fingerprint, project) {
      return (
        (await one(
          `select 1 as hit from ${table('failure_memory')}
           where candidate_fingerprint = $1 and project = $2 limit 1`,
          [fingerprint, project],
        )) !== null
      );
    },

    async listFailures(project, limit) {
      return (
        await all(
          `select * from ${table('failure_memory')} where project = $1
           order by failed_at desc limit $2`,
          [project, limit],
        )
      ).map(toFailure);
    },

    async forgetFailures({ project, fingerprint, all }): Promise<number> {
      if (all !== true && fingerprint === undefined) return 0;

      const sql =
        all === true
          ? `delete from ${table('failure_memory')} where project = $1`
          : `delete from ${table('failure_memory')} where project = $1 and candidate_fingerprint = $2`;

      const params = all === true ? [project] : [project, fingerprint ?? ''];
      const result = await client.query(sql, params);

      // Postgres 的 rowCount 才是删除条数；返回 0 会让调用方以为"没找到"
      return result.rowCount ?? 0;
    },
  };
}
