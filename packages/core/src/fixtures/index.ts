import {
  SCHEMA_VERSION,
  type AdapterId,
  type CollectorPort,
  type Device,
  type Metric,
  type MetricSample,
  type PerfPilotConfig,
  type RawArtifact,
  type RunRecord,
  type Candidate,
} from '@yuki-byte18/shared';
import { CandidateSchema, PerfPilotConfigSchema, buildMetric } from '@yuki-byte18/shared';

export interface FakeCollectorOptions {
  id: AdapterId;
  /** 直接产出样本（走 collect → toMetrics 的正常路径） */
  samples?: readonly MetricSample[];
  /** true：探活返回 false */
  unavailable?: boolean;
  /** true：探活抛异常 */
  probeThrows?: boolean;
  /** true：collect 抛异常（模拟外部工具崩溃） */
  collectThrows?: boolean;
  /** true：toMetrics 抛异常（模拟输出格式变了） */
  parseThrows?: boolean;
  /** 自定义产物，用于断言落盘 */
  artifacts?: readonly RawArtifact[];
}

/**
 * 可编程的假 adapter。
 *
 * 存在的理由不是「省事」，而是**让失败路径可以被测试**：
 * Lighthouse 崩了、报告端点没启动、上游 JSON 结构变了 —— 这三种情况
 * 在真实环境里都只是偶发，但在代码里必须每条都有确定的行为。
 * 只有能随手造出失败的替身，才能把它们钉进单测。
 */
export function fakeCollector(options: FakeCollectorOptions): CollectorPort {
  const {
    id,
    samples = [],
    unavailable = false,
    probeThrows = false,
    collectThrows = false,
    parseThrows = false,
    artifacts,
  } = options;

  const produced: RawArtifact[] =
    artifacts !== undefined
      ? [...artifacts]
      : samples.length > 0
        ? [
            {
              adapter: id,
              kind: `${id}-payload`,
              payload: { samples },
              collectedAt: '2026-01-17T14:25:30.000Z',
              route: '/',
              device: 'mobile',
              file: null,
            },
          ]
        : [];

  return {
    id,
    isAvailable: async () => {
      if (probeThrows) throw new Error(`${id} 探活失败`);
      return !unavailable;
    },
    collect: async () => {
      if (collectThrows) throw new Error(`${id} 执行失败`);
      return produced;
    },
    toMetrics: () => {
      if (parseThrows) throw new Error(`${id} 输出结构不可解析`);
      return [...samples];
    },
  };
}

export function metric(name: Metric['name'], value: number, overrides: Partial<Metric> = {}): Metric {
  return {
    ...buildMetric({
      name,
      value,
      route: '/',
      device: 'mobile',
      source: 'lighthouse',
      collectedAt: '2026-01-17T14:25:30.000Z',
    }),
    ...overrides,
  };
}

/**
 * 候选 fixture。
 *
 * 过一遍 `CandidateSchema`：候选上的跨字段约束（rule 来源必须有 ruleId、
 * 不可逆只能是 C 类）会在这里被挡住，而不是在某个测试的断言里
 * 以一句莫名其妙的失败暴露出来。
 */
export function candidateFixture(overrides: Partial<Candidate> = {}): Candidate {
  const base = {
    id: 'cand_1',
    runId: 'run_1',
    bottleneckIds: ['bn_1'],
    class: 'A',
    title: '开启静态资源长缓存',
    description: '把 assets 目录下的文件设为 immutable 长缓存',
    origin: 'rule',
    ruleId: 'cache-static-assets',
    promptVersion: null,
    changes: [
      {
        type: 'config',
        file: 'vite.config.ts',
        key: 'build.assetsDir',
        before: null,
        after: 'assets',
      },
    ],
    expectedGain: { LCP: 200 },
    confidence: 0.9,
    risk: 'low',
    effort: 'low',
    reversible: true,
    recalledFrom: [],
    bottleneckKinds: ['CACHE_MISS'],
  };

  return CandidateSchema.parse({ ...base, ...overrides });
}

export interface RunFixtureOptions {
  id?: string;
  project?: string;
  route?: string;
  device?: Device;
  status?: RunRecord['status'];
  startedAt?: string;
  metrics?: Metric[];
  /** 与基线的差值。造"有回归的 run"时必须显式给，否则门禁判不出东西 */
  deltas?: RunRecord['deltas'];
  baseline?: RunRecord['baseline'];
  warnings?: RunRecord['warnings'];
  stages?: RunRecord['stages'];
}

export function runFixture(options: RunFixtureOptions = {}): RunRecord {
  const {
    id = 'run_20260117T142530_aaaaaa',
    project = 'demo',
    route = '/',
    device = 'mobile',
    status = 'success',
    startedAt = '2026-01-17T14:25:30.000Z',
    metrics = [metric('LCP', 3000)],
    deltas = [],
    baseline = null,
    warnings = [],
    stages = [],
  } = options;

  return {
    schemaVersion: SCHEMA_VERSION,
    // 默认不接 LLM：成本 0（字段必填，schema 的默认值也是 0）
    llmCostUsd: 0,
    id,
    project,
    route,
    device,
    url: 'https://staging.example.com',
    status,
    startedAt,
    finishedAt: startedAt,
    durationMs: 1000,
    perfpilotVersion: '0.1.0',
    stages,
    metrics,
    baseline,
    deltas,
    warnings,
    artifacts: [],
  };
}

/**
 * 配置 fixture。
 *
 * **刻意过一遍 schema**，而不是手写一个完整的对象字面量。
 *
 * 手写版本会随着 schema 演进而悄悄失效 —— 比如 `decision.weights` 是后来加的，
 * 手写的 fixture 里没有它，测试就会在运行时炸出
 * 「Cannot read properties of undefined」。过 schema 之后，
 * 新增字段自动带上默认值，fixture 永远不可能与真实配置的形状脱节。
 */
export function configFixture(overrides: Record<string, unknown> = {}): PerfPilotConfig {
  const base = {
    project: { name: 'demo', root: '.' },
    target: { url: 'https://staging.example.com', routes: ['/'] },
    baseline: { ref: 'last-run', metrics: {} },
    report: { format: ['markdown', 'json'] },
  };

  return PerfPilotConfigSchema.parse(deepMerge(base, overrides));
}

/** 只做一层深合并：配置是两层结构，够用且行为可预测 */
function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): unknown {
  const result: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(patch)) {
    const current = result[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      result[key] = deepMerge(current, value);
    } else {
      result[key] = value;
    }
  }

  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
