import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  DiagnosisSchema,
  RunRecordSchema,
  isSafeId,
  parseExternal,
  parseJsonText,
  toPerfPilotError,
  type Device,
  type Diagnosis,
  type RawArtifact,
  type ReportOutput,
  type RunRecord,
  type RunStorePort,
  type RunSummary,
  type SavedRun,
} from '@yuki-byte18/shared';

export interface FileRunStoreOptions {
  /** 存储根目录，通常是 `<project.root>/.perfpilot` */
  baseDir: string;
}

interface PreparedRun {
  runId: string;
  dir: string;
  runFile: string;
}

/**
 * 把调用方给的相对路径清洗成**安全的、保留了目录结构的**相对路径。
 *
 * ## 为什么必须保留目录段（这里踩过一次坑）
 *
 * 旧实现是 `name.split(/[\\/]/).pop()` —— 把目录整个丢掉、只留文件名。
 * 于是 `executions/<候选id>.json` 与 `verifications/<候选id>.json`
 * **双双落到同一个 `<候选id>.json`**：验证阶段把执行阶段的记录覆盖掉了，
 * 逐候选的审计留痕静默丢了一半。
 *
 * 更糟的是内存实现不做这个扁平化，两个实现的行为因此不一致 ——
 * 单测跑在内存实现上永远发现不了，而生产用的是文件实现。
 *
 * ## 同时必须挡住路径穿越
 *
 * 这些名字来自 adapter 产物与调用方，属于**外部输入**。做法是逐段清洗 +
 * 丢掉 `.` / `..`：先清洗再判断，顺序反了就会漏（`..` 全是被允许的字符）。
 * 与 `isSafeId` 那道针对 runId 的检查是两层独立的防线。
 */
function safeRelativePath(name: string, fallback = 'artifact.json'): string {
  const segments = name
    .split(/[\\/]+/)
    // 只留保守字符集；`..` 恰好全在集合内，因此必须在**清洗之后**再丢
    .map((segment) => segment.replace(/[^A-Za-z0-9._-]/g, '_'))
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..');

  return segments.length > 0 ? segments.join('/') : fallback;
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'ENOENT';
}

/**
 * 按新旧排序，`startedAt` 相同时用 id 兜底。
 *
 * 只比时间戳是不够的：CI 里两次 run 可能落在同一毫秒（尤其是测试），
 * 此时排序结果取决于文件系统的返回顺序 —— 于是 `latestFor` 会随机
 * 挑中较旧的那次当基线，表现为「基线偶尔对偶尔错」这种最难查的 bug。
 * run id 里含时间戳，作为第二排序键即可给出确定的顺序。
 */
export function compareRunRecency(
  a: { startedAt: string; id: string },
  b: { startedAt: string; id: string },
): number {
  const byTime = b.startedAt.localeCompare(a.startedAt);
  return byTime !== 0 ? byTime : b.id.localeCompare(a.id);
}

/**
 * 文件系统存储。
 *
 * 布局：
 *   .perfpilot/
 *     runs/
 *       run_20260117T142530_a1b2c3/
 *         run.json          # RunRecord，报告与 Web 页的唯一数据源
 *         report.md
 *         artifacts/        # adapter 原始产物，M2 下钻取证用
 *         lighthouse-root.json
 *
 * 刻意不建索引文件：`list()` 直接遍历 run 目录读 run.json。
 * run 数量是「一个项目的诊断次数」量级，遍历足够快；
 * 而索引文件与真实数据不一致，是这类工具最常见的脏数据来源。
 */
export function createFileRunStore(options: FileRunStoreOptions): RunStorePort {
  const baseDir = resolve(options.baseDir);
  const runsDir = join(baseDir, 'runs');

  const dirOf = (runId: string): PreparedRun => {
    // runId 会参与路径拼接，且来自 CLI 参数或 API —— 必须先挡住 `../`
    if (!isSafeId(runId)) {
      throw toPerfPilotError(new Error(`非法的 runId: ${runId}`), 'STORE_FAILED');
    }
    const dir = join(runsDir, runId);
    return { runId, dir, runFile: join(dir, 'run.json') };
  };

  const prepare = async (runId: string): Promise<SavedRun> => {
    const prepared = dirOf(runId);
    await mkdir(prepared.dir, { recursive: true });
    return prepared;
  };

  const save = async (run: RunRecord): Promise<SavedRun> => {
    const prepared = dirOf(run.id);
    await mkdir(prepared.dir, { recursive: true });
    await writeFile(prepared.runFile, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
    return prepared;
  };

  const saveArtifacts = async (
    runId: string,
    artifacts: readonly RawArtifact[],
  ): Promise<void> => {
    if (artifacts.length === 0) return;
    const prepared = dirOf(runId);
    const artifactDir = join(prepared.dir, 'artifacts');
    await mkdir(artifactDir, { recursive: true });

    await Promise.all(
      artifacts.map(async (artifact, index) => {
        const name = artifact.file ?? `${String(index).padStart(2, '0')}-${artifact.adapter}.json`;
        const path = join(artifactDir, safeRelativePath(name));
        // adapter 可以给带子目录的相对路径，因此父目录要单独建
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
      }),
    );

    // 结构化产物索引，Web 报告页无需再解析大 JSON
    await writeFile(
      join(artifactDir, 'index.json'),
      `${JSON.stringify(
        artifacts.map((a) => ({ adapter: a.adapter, kind: a.kind, file: a.file })),
        null,
        2,
      )}\n`,
      'utf8',
    );
  };

  const saveDiagnosis = async (runId: string, diagnosis: Diagnosis): Promise<string> => {
    const prepared = dirOf(runId);
    await mkdir(prepared.dir, { recursive: true });
    const path = join(prepared.dir, 'diagnosis.json');
    await writeFile(path, `${JSON.stringify(diagnosis, null, 2)}\n`, 'utf8');
    return path;
  };

  const saveReport = async (runId: string, output: ReportOutput): Promise<string> => {
    const prepared = dirOf(runId);
    await mkdir(prepared.dir, { recursive: true });
    const path = join(prepared.dir, safeRelativePath(output.filename));
    await writeFile(path, output.content, 'utf8');
    return path;
  };

  const saveJson = async (runId: string, filename: string, data: unknown): Promise<string> => {
    const prepared = dirOf(runId);
    const path = join(prepared.dir, safeRelativePath(filename));
    // `verifications/<id>.json` 这类带子目录的名字要先把目录建出来
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    return path;
  };

  const loadJson = async (runId: string, filename: string): Promise<unknown | null> => {
    const prepared = dirOf(runId);
    try {
      // 与 saveJson 用**同一个**清洗函数：两处各写一遍迟早会对不上，
      // 表现为"写得进去、读不出来"
      const content = await readFile(join(prepared.dir, safeRelativePath(filename)), 'utf8');
      return parseJsonText(content);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw toPerfPilotError(err, 'STORE_FAILED');
    }
  };

  const savePatch = async (runId: string, candidateId: string, patch: string): Promise<string> => {
    if (!isSafeId(candidateId)) {
      throw toPerfPilotError(new Error(`非法的 candidateId: ${candidateId}`), 'STORE_FAILED');
    }
    const prepared = dirOf(runId);
    const patchDir = join(prepared.dir, 'patches');
    await mkdir(patchDir, { recursive: true });
    const path = join(patchDir, `${candidateId}.patch`);
    await writeFile(path, patch, 'utf8');
    return path;
  };

  const loadDiagnosis = async (runId: string): Promise<Diagnosis | null> => {
    const prepared = dirOf(runId);
    try {
      const content = await readFile(join(prepared.dir, 'diagnosis.json'), 'utf8');
      return parseExternal(DiagnosisSchema, parseJsonText(content), {
        what: `diagnosis ${runId}`,
        code: 'STORE_FAILED',
      });
    } catch (err) {
      if (isNotFound(err)) return null;
      throw toPerfPilotError(err, 'STORE_FAILED');
    }
  };

  const load = async (runId: string): Promise<RunRecord | null> => {
    const prepared = dirOf(runId);
    try {
      const content = await readFile(prepared.runFile, 'utf8');
      // 读回来的同样是外部输入：可能被手工改过（Windows 编辑器常加 BOM），
      // 也可能来自旧版本 schema
      return parseExternal(RunRecordSchema, parseJsonText(content), {
        what: `run 记录 ${runId}`,
        code: 'STORE_FAILED',
      });
    } catch (err) {
      if (isNotFound(err)) return null;
      throw toPerfPilotError(err, 'STORE_FAILED');
    }
  };

  const list = async (): Promise<RunSummary[]> => {
    let entries: string[];
    try {
      entries = await readdir(runsDir);
    } catch (err) {
      if (isNotFound(err)) return [];
      throw toPerfPilotError(err, 'STORE_FAILED');
    }

    const summaries = await Promise.all(
      entries.filter(isSafeId).map(async (runId): Promise<RunSummary | null> => {
        try {
          const content = await readFile(join(runsDir, runId, 'run.json'), 'utf8');
          const run = parseJsonText(content) as Partial<RunRecord>;
          return {
            id: runId,
            project: run.project ?? '',
            route: run.route ?? '',
            device: (run.device ?? 'mobile') as Device,
            status: run.status ?? 'failed',
            startedAt: run.startedAt ?? '',
            metricCount: run.metrics?.length ?? 0,
          };
        } catch {
          // 单个 run 损坏不应让 history 整体失败
          return null;
        }
      }),
    );

    return summaries
      .filter((s): s is RunSummary => s !== null)
      .sort((a, b) => compareRunRecency(a, b));
  };

  const latestFor = async (
    project: string,
    route: string,
    device: Device,
  ): Promise<RunRecord | null> => {
    const summaries = await list();
    const candidates = summaries.filter(
      (s) => s.project === project && s.route === route && s.device === device,
    );

    for (const candidate of candidates) {
      const run = await load(candidate.id);
      if (run !== null) return run;
    }
    return null;
  };

  return {
    prepare,
    save,
    saveArtifacts,
    saveDiagnosis,
    saveReport,
    saveJson,
    loadJson,
    savePatch,
    loadDiagnosis,
    load,
    list,
    latestFor,
  };
}
