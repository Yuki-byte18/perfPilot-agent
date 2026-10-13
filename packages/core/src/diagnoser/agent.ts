import type {
  Attribution,
  Bottleneck,
  DiagnoseEvidence,
  LlmFinding,
  Metric,
  MetricDelta,
  RawArtifact,
} from '@yuki-byte18/shared';
import {
  bundleScansOf,
  harEntriesOf,
  longTasksOf,
  tracePayloadsOf,
  webVitalsAttributionsOf,
} from './artifacts.js';

/**
 * 诊断 agent：证据摘要 + 结论合并。
 *
 * ## 为什么诊断可以由 LLM 主导，而决策不行
 *
 * `core/diagnoser` 的确定性规则是**模式匹配**：它只能认出"已知的问题形状"。
 * 而"这个页面为什么慢"本质上是个开放问题 —— 比如某个长任务与某个第三方脚本
 * 的加载时间重合，这需要跨来源关联，规则写不出来（规则是逐来源、逐模式的）。
 *
 * 但**决策**必须可复现（硬约束 7）：同一批候选必须给出同一批裁决，
 * 否则这个工具不能在 CI 里当门禁。所以 LLM 只在"看问题"和"给方案"这两处，
 * 绝不碰"改不改"。
 *
 * ## 这一层的三道闸
 *
 * 1. **证据**：`LlmFindingSchema` 强制至少一条 evidence，没有证据的结论直接丢弃
 * 2. **去重**：与规则结论"同种类 + 同归因"的新结论会被丢掉（换个说法重复一遍没有价值）
 * 3. **限量**：每轮最多新增 5 条结论，按 severity 取前 5 —— 报告不能被 LLM 刷屏
 */

/** 新增结论的数量上限。复核（`refines`）不受此限制 */
export const MAX_NEW_FINDINGS = 5;

/** 摘要里各类证据的条数上限：prompt 的体积要可控，否则成本和上下文一起爆 */
const TOP_ASSETS = 10;
const TOP_REQUESTS = 15;
const TOP_LONG_TASKS = 10;

/**
 * 把原始产物压缩成**有界**的证据摘要。
 *
 * 原始 Lighthouse JSON 几 MB、HAR 十几 MB，原样塞进 prompt 既超上下文也超预算。
 * 这里只保留"能支撑归因判断"的部分：最大的资源、最慢的请求、最长的任务，
 * 以及 Web Vitals 自带的元素级归因（INP 的目标元素、CLS 的偏移元素）。
 */
export function buildEvidence(input: {
  metrics: readonly Metric[];
  deltas: readonly MetricDelta[];
  artifacts: readonly RawArtifact[];
}): DiagnoseEvidence {
  const { metrics, deltas, artifacts } = input;

  const scans = bundleScansOf(artifacts);
  const assets = scans
    .flatMap((scan) => scan.files.map((file) => ({ path: file.path, size: file.size })))
    .sort((a, b) => b.size - a.size)
    .slice(0, TOP_ASSETS);

  const dependencies = scans
    .flatMap((scan) =>
      Object.entries(scan.packageJson?.dependencies ?? {}).map(([name, version]) => ({
        name,
        version,
      })),
    )
    .slice(0, 40);

  const entries = harEntriesOf(artifacts)
    .map((entry) => ({
      url: entry.url,
      resourceType: entry.resourceType,
      status: entry.status,
      // 未知体积与 0 字节是两回事：保留 null，让 LLM 知道"这项没测到"
      transferSize: entry.transferSize,
      timeMs: Math.round(entry.timeMs),
      fromCache: entry.fromCache,
      cacheControl: entry.cacheControl,
      initiatorType: entry.initiatorType,
      priority: entry.priority,
    }))
    // 按传输体积排序（未知体积按 0 参与排序，但它们仍然是 null 展示出来）
    .sort((a, b) => (b.transferSize ?? 0) - (a.transferSize ?? 0))
    .slice(0, TOP_REQUESTS);

  /**
   * 长任务：**带上 `topFrame`**。
   *
   * 这是整份摘要里信息量最大的一项，也是规则写不出来的部分：
   * 规则只能报"有个 320ms 的长任务"，而 topFrame 指向具体函数与文件，
   * 让 LLM 能把它和 HAR 里某个第三方脚本的加载时间对上 ——
   * 「这个长任务发生在某个 SDK 加载期间」这种结论需要跨来源关联。
   */
  const longTasks = longTasksOf(artifacts)
    .map((task) => ({
      durationMs: Math.round(task.durationMs),
      startMs: Math.round(task.startMs),
      scriptingMs: Math.round(task.scriptingMs),
      topFrame:
        task.topFrame === null
          ? null
          : {
              functionName: task.topFrame.functionName,
              url: task.topFrame.url,
              line: task.topFrame.line,
            },
    }))
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, TOP_LONG_TASKS);

  const totalBlockingMs = longTasksOf(artifacts).reduce(
    (sum, task) => sum + Math.max(0, task.durationMs - 50),
    0,
  );

  const vitals = webVitalsAttributionsOf(artifacts).map((item) => ({
    metric: item.metric,
    value: item.value,
    attribution: item.data,
  }));

  const sources: Record<string, unknown> = {
    // 采集到了什么：让 LLM 知道"哪些数据根本不存在"，而不是对着空白瞎猜
    collected: artifacts.map((a) => ({ adapter: a.adapter, kind: a.kind })),
    bundle: { assets, dependencies },
    har: { requests: entries, requestCount: harEntriesOf(artifacts).length },
    trace: {
      longTasks,
      totalBlockingMs: Math.round(totalBlockingMs),
      traceCount: tracePayloadsOf(artifacts).length,
    },
    'web-vitals': vitals,
  };

  return {
    metrics: metrics.map((m) => ({
      name: m.name,
      value: m.value,
      unit: m.unit,
      rating: m.rating,
      score: m.score ?? null,
    })),
    deltas: deltas.map((d) => ({
      name: d.name,
      delta: d.delta ?? null,
      scoreDelta: d.scoreDelta ?? null,
    })),
    sources,
  };
}

export interface MergeOutcome {
  bottlenecks: Bottleneck[];
  /** 被采纳的结论数（含对规则结论的复核） */
  adopted: number;
  /** 每条复核了哪条规则结论 */
  refined: string[];
  /** 被丢弃的结论及原因（进日志与报告，便于解释"LLM 说了但没被采纳"） */
  dropped: Array<{ title: string; reason: string }>;
}

/**
 * 合并规则结论与 LLM 结论。
 *
 * 优先级刻意是"规则为底、LLM 为改"：
 *
 * - `refines` 命中一条规则结论 → **用 LLM 的归因与严重度覆盖它**，保留原 id
 *   与 occurrences（同一件事不该在报告里变成两条）
 * - `refines` 指向不存在的 id → 忽略这个字段，按新增处理（LLM 编了 id）
 * - 与规则结论"同种类 + 同归因"的新结论 → 丢弃（重复表述没有价值）
 * - 其余按新增，最多 `MAX_NEW_FINDINGS` 条，按 severity 取前几
 */
export function mergeFindings(
  ruleFindings: readonly Bottleneck[],
  findings: readonly LlmFinding[],
): MergeOutcome {
  const merged = ruleFindings.map((b) => ({ ...b }));
  const byId = new Map(merged.map((b) => [b.id, b]));
  const byKey = new Map(merged.map((b) => [findingKey(b.kind, b.attribution), b]));

  const dropped: MergeOutcome['dropped'] = [];
  const refined: string[] = [];
  let adopted = 0;
  const additions: Bottleneck[] = [];

  for (const finding of findings) {
    const { bottleneck } = finding;

    // ── 1. 复核：覆盖归因与严重度，保留身份 ──────────────────────
    if (finding.refines !== null) {
      const target = byId.get(finding.refines);
      if (target !== undefined) {
        target.attribution = bottleneck.attribution;
        target.severity = bottleneck.severity;
        target.impact = bottleneck.impact;
        target.title = bottleneck.title;
        // 复核过的结论：置信度取两者较低值（多一道判断不代表更确定）
        target.confidence = Math.min(target.confidence, bottleneck.confidence);
        target.source = 'llm';
        // 证据合并：规则原本的证据同样有效，不该被丢掉
        target.evidence = [...target.evidence, ...bottleneck.evidence];
        refined.push(target.id);
        adopted += 1;
        continue;
      }
      dropped.push({
        title: bottleneck.title,
        reason: `refines 指向不存在的结论 ${finding.refines}，已按新增处理`,
      });
    }

    // ── 2. 与规则结论重复（同种类 + 同归因）──────────────────────
    const key = findingKey(bottleneck.kind, bottleneck.attribution);
    if (byKey.has(key)) {
      dropped.push({ title: bottleneck.title, reason: '与规则结论重复（同种类 + 同归因）' });
      continue;
    }

    // ── 3. 同一批 LLM 结论内部也可能重复 ──────────────────────────
    if (additions.some((b) => findingKey(b.kind, b.attribution) === key)) {
      dropped.push({ title: bottleneck.title, reason: '与本次 LLM 的另一条结论重复' });
      continue;
    }

    additions.push({ ...bottleneck });
    byKey.set(key, bottleneck);
  }

  // 限量：报告不能被 LLM 刷屏；按 severity 取前 N 条
  const kept = additions.sort((a, b) => b.severity - a.severity).slice(0, MAX_NEW_FINDINGS);
  for (const extra of additions.slice(MAX_NEW_FINDINGS)) {
    dropped.push({ title: extra.title, reason: `超出每轮新增上限 ${MAX_NEW_FINDINGS} 条` });
  }

  adopted += kept.length;

  return {
    bottlenecks: [...merged, ...kept].sort(
      (a, b) =>
        b.severity - a.severity ||
        b.confidence - a.confidence ||
        a.title.localeCompare(b.title),
    ),
    adopted,
    refined,
    dropped,
  };
}

/**
 * 归因指纹。
 *
 * 只到"哪一类归因、指向哪一个对象"这一层：同一个 chunk 上"太大了"和
 * "没有被压缩"确实是两个问题（kind 不同），但同一个 chunk 上两条都说"太大了"
 * （kind 相同）就是重复 —— 后者正是 LLM 最容易做的事。
 */
export function findingKey(kind: Bottleneck['kind'], attribution: Attribution): string {
  switch (attribution.level) {
    case 'resource':
      return `${kind}|resource:${attribution.url}`;
    case 'dependency':
      return `${kind}|dependency:${attribution.name}`;
    case 'source':
      return `${kind}|source:${attribution.file}:${attribution.line}`;
    case 'component':
      return `${kind}|component:${attribution.name}`;
    case 'config':
      return `${kind}|config:${attribution.file}:${attribution.key}`;
  }
}
