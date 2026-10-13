import {
  CandidateSchema,
  parseExternal,
  type BottleneckKind,
  type Candidate,
  type CandidateLibraryEntry,
  type DiagnosisHistoryEntry,
  type FailureMemoryEntry,
  type ProjectProfile,
} from '@yuki-byte18/shared';

/**
 * 记忆层四张表的**行 ↔ 实体**映射。
 *
 * 抽出来是因为 SQLite 与 Postgres 两种实现的 SQL 方言不同（`?` vs `$1`），
 * 但"一行长什么样"必须完全一致 —— 否则同一份数据换存储后召回结果会变，
 * 那是这个模块最难查的一类 bug。
 *
 * 另一件事：**从数据库读回来的数据同样是外部输入**。它可以被别的进程改、
 * 被手工 UPDATE、被上一次版本写坏。因此 `candidate` 这个 JSON 列一定要过
 * `CandidateSchema`，而不是 `JSON.parse` 完直接 `as Candidate` ——
 * 一条脏数据不该让整轮 CI 崩在一个类型谎话上。
 */

/** SQLite 只有 null / number / bigint / string / Uint8Array，布尔与对象都要自己编码 */
export type SqlValue = null | number | bigint | string | Uint8Array;
export type Row = Record<string, SqlValue>;

/**
 * 写进数据库的参数值。
 *
 * 比 `SqlValue` 多一个 `boolean`：**Postgres 的 boolean 列要收原生 true/false**。
 * 两个类型分开是为了让"哪一层需要什么"在签名上就看得见 ——
 * 之前只有 `SqlValue`，于是 Postgres 的布尔列被塞了整数 1，会报
 * "column succeeded is of type boolean but expression is of type integer"。
 * 那条路径当时没有任何测试，因此这个 bug 一直没暴露。
 */
export type SqlParam = SqlValue | boolean;

/** 布尔列怎么编码，取决于方言 */
export type SqlDialect = 'sqlite' | 'postgres';

const toBoolValue = (value: boolean, dialect: SqlDialect): SqlParam =>
  dialect === 'sqlite' ? (value ? 1 : 0) : value;

/**
 * 读回来的布尔。
 *
 * 三种形态都要认：SQLite 给 `1` / `1n`，Postgres 给 `true`。
 * 只认数字的话，Postgres 读回来的 `true` 会被判成 false ——
 * 一个"成功过的方案"被记成失败的，而记忆层的全部判断都建立在这个字段上。
 */
const fromBoolValue = (value: SqlValue | boolean | undefined): boolean =>
  value === true || value === 1 || value === 1n || value === '1';

function requireString(row: Row, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') {
    throw new Error(`记忆层读取失败：列 ${column} 期望 string，实际为 ${typeof value}`);
  }
  return value;
}

function optionalNumber(row: Row, column: string): number | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new Error(`记忆层读取失败：列 ${column} 期望 number，实际为 ${typeof value}`);
}

/** `bottleneck_kinds` 是 JSON 数组列；解析失败时**不猜**，直接抛错 */
function parseKindList(raw: string): BottleneckKind[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('记忆层读取失败：bottleneck_kinds 不是数组');
  }
  return parsed.filter((item): item is BottleneckKind => typeof item === 'string');
}

// ─────────────────────────────────────────────────────────────────────
// 写入参数：实体 → 列值（顺序与 INSERT 语句一致）
// ─────────────────────────────────────────────────────────────────────

export function diagnosisParams(entry: DiagnosisHistoryEntry): SqlValue[] {
  return [
    entry.id,
    entry.runId,
    entry.project,
    entry.route,
    JSON.stringify(entry.bottleneckKinds),
    entry.createdAt,
  ];
}

/**
 * 候选的写入参数。
 *
 * **重载而不是统一成 `SqlParam[]`**：SQLite 那边（`node:sqlite` 的
 * `SQLInputValue`）在类型上就不接受 boolean，而 Postgres 必须收 boolean。
 * 让返回值随方言变化，编译器就能替我们盯着"别把 true 塞给 SQLite"。
 */
export function candidateParams(entry: CandidateLibraryEntry, dialect: 'sqlite'): SqlValue[];
export function candidateParams(entry: CandidateLibraryEntry, dialect: 'postgres'): SqlParam[];
export function candidateParams(entry: CandidateLibraryEntry, dialect: SqlDialect): SqlParam[];
export function candidateParams(entry: CandidateLibraryEntry, dialect: SqlDialect): SqlParam[] {
  return [
    entry.id,
    entry.bottleneckKind,
    JSON.stringify(entry.candidate),
    entry.actualGain,
    // 逐指标原始收益存成 JSON 文本（SQLite 没有 jsonb；Postgres 那边用 jsonb 转换）
    entry.actualGainByMetric === undefined ? null : JSON.stringify(entry.actualGainByMetric),
    toBoolValue(entry.succeeded, dialect),
    entry.project,
    entry.techStack,
    entry.createdAt,
  ];
}

export function profileParams(profile: ProjectProfile): SqlValue[] {
  return [
    profile.project,
    profile.techStack,
    profile.buildTool,
    profile.framework,
    JSON.stringify(profile.baselineMetrics),
    profile.updatedAt,
  ];
}

export function failureParams(entry: FailureMemoryEntry): SqlValue[] {
  return [
    entry.id,
    entry.candidateFingerprint,
    entry.bottleneckKind,
    entry.failureReason,
    entry.project,
    entry.techStack,
    entry.failedAt,
  ];
}

// ─────────────────────────────────────────────────────────────────────
// 读取映射：行 → 实体
// ─────────────────────────────────────────────────────────────────────

export function toDiagnosis(row: Row): DiagnosisHistoryEntry {
  return {
    id: requireString(row, 'id'),
    runId: requireString(row, 'run_id'),
    project: requireString(row, 'project'),
    route: requireString(row, 'route'),
    bottleneckKinds: parseKindList(requireString(row, 'bottleneck_kinds')),
    createdAt: requireString(row, 'created_at'),
  };
}

export function toCandidateEntry(row: Row): CandidateLibraryEntry {
  const candidate: Candidate = parseExternal(
    CandidateSchema,
    JSON.parse(requireString(row, 'candidate')),
    { what: '记忆层里的候选方案' },
  );

  const gainByMetric = parseGainByMetric(row['actual_gain_by_metric']);

  const entry: CandidateLibraryEntry = {
    id: requireString(row, 'id'),
    bottleneckKind: requireString(row, 'bottleneck_kind') as BottleneckKind,
    candidate,
    actualGain: optionalNumber(row, 'actual_gain'),
    succeeded: fromBoolValue(row['succeeded']),
    project: requireString(row, 'project'),
    techStack: requireString(row, 'tech_stack'),
    createdAt: requireString(row, 'created_at'),
  };

  // 赋值而不是条件展开：`exactOptionalPropertyTypes` 下
  // `{...(x ? {k: x} : {})}` 推出来的类型带 `| undefined`，与可选属性不兼容
  if (gainByMetric !== undefined) entry.actualGainByMetric = gainByMetric;

  return entry;
}

/**
 * `actual_gain_by_metric` 列 → 数字字典。
 *
 * 这一列**可以不存在**（002 迁移之前写入的旧行），也可以是脏的，
 * 因此解析失败一律当"没有这个数据"处理 —— 校准少一份样本只是不生效，
 * 而让它抛错会连带整条召回路径失败。
 */
function parseGainByMetric(value: SqlValue | undefined): Record<string, number> | undefined {
  if (typeof value !== 'string' || value === '') return undefined;

  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;

    const result: Record<string, number> = {};
    for (const [key, item] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof item === 'number' && Number.isFinite(item)) result[key] = item;
    }
    return Object.keys(result).length > 0 ? result : undefined;
  } catch {
    return undefined;
  }
}

export function toProfile(row: Row): ProjectProfile {
  const metrics: unknown = JSON.parse(requireString(row, 'baseline_metrics'));
  const baselineMetrics: Record<string, number> = {};
  if (typeof metrics === 'object' && metrics !== null) {
    for (const [key, value] of Object.entries(metrics as Record<string, unknown>)) {
      if (typeof value === 'number') baselineMetrics[key] = value;
    }
  }

  return {
    project: requireString(row, 'project'),
    techStack: requireString(row, 'tech_stack'),
    buildTool: requireString(row, 'build_tool'),
    framework: requireString(row, 'framework'),
    baselineMetrics,
    updatedAt: requireString(row, 'updated_at'),
  };
}

export function toFailure(row: Row): FailureMemoryEntry {
  return {
    id: requireString(row, 'id'),
    candidateFingerprint: requireString(row, 'candidate_fingerprint'),
    bottleneckKind: requireString(row, 'bottleneck_kind') as BottleneckKind,
    failureReason: requireString(row, 'failure_reason'),
    project: requireString(row, 'project'),
    techStack: requireString(row, 'tech_stack'),
    failedAt: requireString(row, 'failed_at'),
  };
}

/**
 * 把 `IN (?, ?, ...)` 展开成占位符。
 *
 * 空数组必须**提前返回**：`IN ()` 在 SQLite 与 Postgres 里都是语法错误，
 * 而"这次没有瓶颈类型"是完全正常的输入（候选列表为空时）。
 * 这类边界不处理的话，表现为整轮运行在一个空查询上崩掉。
 */
export function placeholders(count: number, style: 'question' | 'dollar' = 'question'): string {
  return Array.from({ length: count }, (_, i) => (style === 'question' ? '?' : `$${i + 1}`)).join(
    ', ',
  );
}
