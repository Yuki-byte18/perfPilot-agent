import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type * as NodeSqlite from 'node:sqlite';
import type {
  DiagnosisHistoryEntry,
  MemoryPort,
  ProjectProfile,
  RecallResult,
} from '@yuki-byte18/shared';
import {
  candidateParams,
  diagnosisParams,
  failureParams,
  placeholders,
  profileParams,
  toCandidateEntry,
  toDiagnosis,
  toFailure,
  toProfile,
  type Row,
  type SqlValue,
} from './mapping.js';

/**
 * SQLite 记忆层（README §10、ADR 007）。
 *
 * ## 为什么用 `node:sqlite` 而不是 better-sqlite3
 *
 * CI 里多一个**原生扩展**就多一类"在我机器上能跑"的问题：需要编译工具链、
 * 需要匹配 Node ABI、Windows 上尤其麻烦。`node:sqlite` 是 Node 自带的，
 * 零依赖、零编译。代价是它仍标记为 experimental（启动时会有一条
 * ExperimentalWarning），因此**驱动被包在这一层后面**：
 * 将来要换成 better-sqlite3 或 Postgres，改的是这个文件，不是 core。
 *
 * ## 迁移是幂等的
 *
 * `schema_migrations` 记录已应用的迁移 id，重复调用 `migrate()` 不会重复执行。
 * 这不只是"好看"：`perfpilot run` 每次启动都会打开这个库，
 * 若迁移不幂等，第二次运行就会炸在建表上。
 */

export interface SqliteMemoryOptions {
  /** 数据库文件路径，通常是 `.perfpilot/memory.db`；`:memory:` 用于测试 */
  url: string;
  /** 是否在启动时执行迁移，默认 true */
  migrate?: boolean;
}

/** 在 MemoryPort 之上补一个 `close()`：Windows 上不关掉连接就删不掉库文件 */
export interface SqliteMemory extends MemoryPort {
  close(): void;
  /** 已应用的迁移 id，测试断言幂等性用 */
  appliedMigrations(): string[];
}

interface Migration {
  id: string;
  sql: string;
}

/**
 * 取 `node:sqlite`，走 `process.getBuiltinModule` 而不是静态 import。
 *
 * 两个理由，都不是洁癖：
 *
 * 1. **打包器不认它。** Vite / vitest 的内置模块清单是在 node:sqlite 出现之前
 *    定的，静态 `import 'node:sqlite'` 会被当成普通包去解析，
 *    报 `Failed to load url sqlite`（剥掉 `node:` 前缀后去找一个叫 sqlite 的包）。
 *    测试里配 `server.deps.external` 也压不住。
 * 2. **它确实还不是稳定 API。** 用一个显式取值 + 显式报错的入口，
 *    比一条"模块找不到"的堆栈更能说清发生了什么：Node 版本太老时得到的是
 *    "需要 Node ≥ 22.5"这句话，而不是 ENOENT。
 */
function loadSqlite(): typeof NodeSqlite {
  const mod = process.getBuiltinModule('node:sqlite') as typeof NodeSqlite | undefined;

  if (mod === undefined) {
    throw new Error(
      'node:sqlite 不可用：需要 Node ≥ 22.5。可以换用别的 MemoryPort 实现，或注入内存实现。',
    );
  }
  return mod;
}

/**
 * 迁移列表。
 *
 * **只追加、不修改**：已经发出去过的迁移改了 SQL，别人机器上早就应用过，
 * 新代码不会再执行它 —— 于是"本地能跑、CI 上表结构不对"。
 * 要改结构就加一条新的。
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    id: '001-init',
    sql: `
      create table if not exists diagnoses (
        id               text primary key,
        run_id           text not null,
        project          text not null,
        route            text not null,
        bottleneck_kinds text not null,
        created_at       text not null
      );
      create index if not exists idx_diagnoses_project_route
        on diagnoses (project, route, created_at desc);

      create table if not exists candidate_library (
        id              text primary key,
        bottleneck_kind text not null,
        candidate       text not null,
        actual_gain     real,
        succeeded       integer not null,
        project         text not null,
        tech_stack      text not null,
        created_at      text not null
      );
      create index if not exists idx_candidates_project
        on candidate_library (project, bottleneck_kind);
      create index if not exists idx_candidates_kind
        on candidate_library (bottleneck_kind);
      create index if not exists idx_candidates_tech
        on candidate_library (tech_stack, bottleneck_kind);

      create table if not exists project_profiles (
        project          text primary key,
        tech_stack       text not null,
        build_tool       text not null,
        framework        text not null,
        baseline_metrics text not null,
        updated_at       text not null
      );

      create table if not exists failure_memory (
        id                    text primary key,
        candidate_fingerprint text not null,
        bottleneck_kind       text not null,
        failure_reason        text not null,
        project               text not null,
        tech_stack            text not null,
        failed_at             text not null
      );
      create index if not exists idx_failures_fingerprint
        on failure_memory (project, candidate_fingerprint);
      create index if not exists idx_failures_kind
        on failure_memory (bottleneck_kind);
    `,
  },
  {
    /**
     * 追加"逐指标原始收益"列（`actualGainByMetric`）。
     *
     * 这一列是**校准 planner 估计**的唯一数据来源：`actual_gain` 存的是
     * 归一化分数（门禁判据），而 planner 的 `expectedGain` 用原始单位
     * （ms / byte）—— 只有一个刻度就永远没法反哺另一个。
     *
     * 用 `alter table add column` 而不是重建表：SQLite 支持加列，而且旧数据
     * 保留（新列为 NULL，读回来就是"没有这个字段"，校准自然跳过）。
     * 这也顺带验证了迁移设计的假设：**只追加、不修改**，
     * 已经应用过 001 的库会在这里补上 002。
     */
    id: '002-actual-gain-by-metric',
    sql: `
      alter table candidate_library add column actual_gain_by_metric text;
    `,
  },
];

export function createSqliteMemory(options: SqliteMemoryOptions): SqliteMemory {
  const file = options.url === ':memory:' ? ':memory:' : resolve(options.url);

  if (file !== ':memory:') {
    // 目录不存在时 SQLite 只会报 "unable to open database file"，
    // 完全看不出是"少了 .perfpilot 目录"
    mkdirSync(dirname(file), { recursive: true });
  }

  const { DatabaseSync } = loadSqlite();
  const db: NodeSqlite.DatabaseSync = new DatabaseSync(file);
  // 外键与 WAL 都不需要（没有外键、单进程写入），但 busy_timeout 需要：
  // 两个 perfpilot 进程同时跑时，默认行为是立刻抛 SQLITE_BUSY
  db.exec('pragma busy_timeout = 5000;');

  const applied = new Set<string>();

  const migrate = (): void => {
    db.exec('create table if not exists schema_migrations (id text primary key, applied_at text not null);');

    const rows = db.prepare('select id from schema_migrations').all() as Row[];
    for (const row of rows) {
      const id = row['id'];
      if (typeof id === 'string') applied.add(id);
    }

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.id)) continue;
      db.exec('begin;');
      try {
        db.exec(migration.sql);
        db.prepare('insert or replace into schema_migrations (id, applied_at) values (?, ?)').run(
          migration.id,
          new Date().toISOString(),
        );
        db.exec('commit;');
        applied.add(migration.id);
      } catch (err) {
        db.exec('rollback;');
        db.close();
        throw new Error(
          `迁移 ${migration.id} 失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  };

  if (options.migrate !== false) migrate();

  const all = (sql: string, params: SqlValue[] = []): Row[] =>
    db.prepare(sql).all(...params) as Row[];

  const one = (sql: string, params: SqlValue[] = []): Row | null =>
    (db.prepare(sql).get(...params) as Row | undefined) ?? null;

  const run = (sql: string, params: SqlValue[]): void => {
    db.prepare(sql).run(...params);
  };

  /** 三条召回路径共用的一段：按 kind 集合查询 */
  const byKinds = (
    where: string,
    params: SqlValue[],
    kinds: readonly string[],
    limit: number,
  ): ReturnType<typeof toCandidateEntry>[] => {
    if (kinds.length === 0) return [];
    const rows = all(
      `select * from candidate_library where ${where} bottleneck_kind in (${placeholders(kinds.length)}) limit ?`,
      [...params, ...kinds, limit],
    );
    return rows.map(toCandidateEntry);
  };

  return {
    close(): void {
      db.close();
    },

    appliedMigrations(): string[] {
      return [...applied];
    },

    // ── 历史诊断 ────────────────────────────────────────────────
    async saveDiagnosis(entry: DiagnosisHistoryEntry): Promise<void> {
      run(
        `insert or replace into diagnoses
         (id, run_id, project, route, bottleneck_kinds, created_at)
         values (?, ?, ?, ?, ?, ?)`,
        diagnosisParams(entry),
      );
    },

    async listDiagnoses(project: string, route: string, limit: number): Promise<DiagnosisHistoryEntry[]> {
      return all(
        `select * from diagnoses where project = ? and route = ?
         order by created_at desc limit ?`,
        [project, route, limit],
      ).map(toDiagnosis);
    },

    // ── 方案库 ──────────────────────────────────────────────────
    async saveCandidate(entry): Promise<void> {
      run(
        `insert or replace into candidate_library
         (id, bottleneck_kind, candidate, actual_gain, actual_gain_by_metric, succeeded, project, tech_stack, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        candidateParams(entry, 'sqlite'),
      );
    },

    async recallCandidates({ project, bottleneckKinds, techStack, limit }): Promise<RecallResult> {
      return {
        byProject: byKinds('project = ? and', [project], bottleneckKinds, limit),
        byKind: byKinds('', [], bottleneckKinds, limit),
        byTechStack: byKinds('tech_stack = ? and', [techStack], bottleneckKinds, limit),
        failures:
          bottleneckKinds.length === 0
            ? []
            : all(
                `select * from failure_memory where bottleneck_kind in (${placeholders(bottleneckKinds.length)})`,
                [...bottleneckKinds],
              ).map(toFailure),
      };
    },

    // ── 项目画像 ────────────────────────────────────────────────
    async saveProfile(profile: ProjectProfile): Promise<void> {
      run(
        `insert or replace into project_profiles
         (project, tech_stack, build_tool, framework, baseline_metrics, updated_at)
         values (?, ?, ?, ?, ?, ?)`,
        profileParams(profile),
      );
    },

    async getProfile(project: string): Promise<ProjectProfile | null> {
      const row = one('select * from project_profiles where project = ?', [project]);
      return row === null ? null : toProfile(row);
    },

    // ── 失败记忆 ────────────────────────────────────────────────
    async saveFailure(entry): Promise<void> {
      run(
        `insert or replace into failure_memory
         (id, candidate_fingerprint, bottleneck_kind, failure_reason, project, tech_stack, failed_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
        failureParams(entry),
      );
    },

    async hasFailedFailure(fingerprint: string, project: string): Promise<boolean> {
      const row = one(
        'select 1 as hit from failure_memory where candidate_fingerprint = ? and project = ? limit 1',
        [fingerprint, project],
      );
      return row !== null;
    },

    async listFailures(project: string, limit: number) {
      return all(
        'select * from failure_memory where project = ? order by failed_at desc limit ?',
        [project, limit],
      ).map(toFailure);
    },

    /**
     * 忘掉失败记忆。
     *
     * 返回**删除条数**而不是布尔：调用方要能把"清掉了 3 条"写进输出 ——
     * "忘了 0 条"和"忘了 3 条"是完全不同的反馈（前者说明指纹写错了）。
     */
    async forgetFailures({ project, fingerprint, all }): Promise<number> {
      if (all !== true && fingerprint === undefined) return 0;

      const before = (one('select count(*) as n from failure_memory where project = ?', [project])?.[
        'n'
      ] ?? 0) as number;

      if (all === true) {
        db.prepare('delete from failure_memory where project = ?').run(project);
      } else {
        db.prepare('delete from failure_memory where project = ? and candidate_fingerprint = ?').run(
          project,
          fingerprint ?? '',
        );
      }

      const after = (one('select count(*) as n from failure_memory where project = ?', [project])?.[
        'n'
      ] ?? 0) as number;

      return Number(before) - Number(after);
    },
  };
}

/** 默认库位置：`<root>/.perfpilot/memory.db`（与配置里的 `memory.url` 默认值一致） */
export function defaultMemoryUrl(root: string): string {
  return join(root, '.perfpilot', 'memory.db');
}
