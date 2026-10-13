import {
  AdapterError,
  METRIC_SOURCE_PRIORITY,
  buildMetric,
  toPerfPilotError,
  type AdapterId,
  type CollectorPort,
  type CollectContext,
  type Device,
  type LoggerPort,
  type Metric,
  type MetricName,
  type MetricSample,
  type MetricThresholdsOverride,
  type RawArtifact,
  type RunWarning,
} from '@yuki-byte18/shared';

export interface CollectorOptions {
  collectors: readonly CollectorPort[];
  logger: LoggerPort;
  /** 项目级的指标阈值覆盖，作用于打分与评级 */
  thresholds?: MetricThresholdsOverride;
  /** run 目录，adapter 把原始产物写在这里 */
  outputDir: string;
  url: string;
  route: string;
  device: Device;
  timeoutMs: number;
  /**
   * 采集轮次，默认 1。>1 时**逐指标取中位数**降噪。
   *
   * 性能指标天然有抖动：同一份代码两次测出的 LCP 差几十毫秒是常事，
   * 而门禁判的正是差值 —— 单轮采集的抖动会被读成"回归"。
   * 轮次之间**串行**执行（不是并发）：并发跑多个 Lighthouse 会争抢 CPU，
   * 测出来的数反映的是机器负载，取中位数也救不回来。
   */
  runs?: number;
  now?: () => Date;
}

export interface CollectResult {
  metrics: Metric[];
  artifacts: RawArtifact[];
  warnings: RunWarning[];
  /** 真正被调用过的 adapter（探活未通过的不算） */
  attempted: AdapterId[];
  succeeded: AdapterId[];
  failed: AdapterId[];
  /** 每个指标最终采用的来源，进报告用于解释「这次为什么和上次不可比」 */
  sources: Partial<Record<MetricName, AdapterId>>;
  /** 实际完成的采集轮次（< runs 说明中途有轮次全失败） */
  completedRuns: number;
}

interface SourcedSample extends MetricSample {
  source: AdapterId;
  collectedAt: string;
}

/**
 * 采集阶段：并发调起全部可用 adapter，归并成 `Metric[]`。
 *
 * 三个决策：
 *
 * 1. **用 `Promise.allSettled` 而非 `Promise.all`**（M1 验收标准第 4 条）。
 *    一个 adapter 挂掉——Playwright 崩了、报告端点没启动——不应该让整轮诊断作废。
 *    失败的 adapter 变成 run 记录里的一条 warning，报告里显式写明「某指标未采集」。
 *
 * 2. **同一指标只取一个来源**，按 `METRIC_SOURCE_PRIORITY` 仲裁。
 *    基线和本次必须同源测量，否则「换了个工具」会被误读成「性能变了」。
 *
 * 3. **走到非首选来源时记 warning**。不是错误，但报告读者有权知道
 *    「这次 LCP 是 web-vitals 给的，不是 Lighthouse」，否则跨次对比没有意义。
 */
export async function collect(options: CollectorOptions): Promise<CollectResult> {
  const { collectors, logger, outputDir, url, route, device, timeoutMs } = options;
  const now = options.now ?? (() => new Date());
  const runs = Math.max(1, options.runs ?? 1);
  const warnings: RunWarning[] = [];

  const usable: CollectorPort[] = [];
  for (const collector of collectors) {
    try {
      if (await collector.isAvailable()) {
        usable.push(collector);
      } else {
        warnings.push({
          adapter: collector.id,
          code: 'ADAPTER_UNAVAILABLE',
          severity: 'degraded',
          message: `${collector.id} 不可用（外部工具未安装或输入缺失），该来源的指标本次跳过`,
        });
        logger.warn('adapter 不可用', { adapter: collector.id });
      }
    } catch (err) {
      const error = toPerfPilotError(err, 'ADAPTER_UNAVAILABLE');
      warnings.push({
        adapter: collector.id,
        code: 'ADAPTER_UNAVAILABLE',
        severity: 'degraded',
        message: `${collector.id} 探活失败：${error.message}`,
      });
      logger.warn('adapter 探活失败', { adapter: collector.id, error: error.message });
    }
  }

  const ctx: CollectContext = { url, route, device, outputDir, timeoutMs, logger };

  const allSamples: SourcedSample[] = [];
  const succeeded = new Set<AdapterId>();
  const failed = new Set<AdapterId>();
  /** 落盘产物只保留**最后一轮**：多轮的产物写在同一批文件名上，列 N 份只会让人困惑 */
  let artifacts: RawArtifact[] = [];
  let completedRuns = 0;
  const seenWarnings = new Set<string>();

  for (let run = 0; run < runs; run += 1) {
    const pass = await collectOnce(usable, ctx, now, logger);

    allSamples.push(...pass.samples);
    for (const id of pass.succeeded) succeeded.add(id);
    for (const id of pass.failed) failed.add(id);

    // 同一轮里多条相同告警会重复（每个 adapter 各一条），跨轮更会重复 —— 按内容去重
    for (const warning of pass.warnings) {
      const key = `${warning.adapter ?? '-'}|${warning.code}|${warning.message}`;
      if (seenWarnings.has(key)) continue;
      seenWarnings.add(key);
      warnings.push(warning);
    }

    if (pass.succeeded.length > 0) {
      completedRuns += 1;
      artifacts = pass.artifacts;
      continue;
    }

    /**
     * 一轮下来一个来源都没成功：**不再跑剩下的轮次**。
     *
     * 多轮的意义是"消除抖动"，而全军覆没说明工具本身挂了（Chrome 崩了、
     * 端点没起来），再跑 N-1 次只是把同样的失败重复 N-1 遍，白等 timeout。
     */
    if (runs > 1) {
      warnings.push({
        adapter: null,
        code: 'ADAPTER_FAILED',
        severity: 'degraded',
        message: `第 ${run + 1} 轮采集全部失败，跳过剩余 ${runs - run - 1} 轮（多轮只用于降噪，不用于重试）`,
      });
    }
    break;
  }

  // 逐指标取中位数：同一指标必须**同源**才可比，因此按 (指标, 来源) 分组
  const merged = runs > 1 ? medianBySource(allSamples) : allSamples;

  const { metrics, sources, arbitrationWarnings } = arbitrate(
    merged,
    route,
    device,
    options.thresholds,
  );
  warnings.push(...arbitrationWarnings);

  if (runs > 1 && completedRuns > 0) {
    logger.info('多轮采集完成', { runs, completedRuns, metrics: metrics.length });
  }

  return {
    metrics,
    artifacts,
    warnings,
    attempted: usable.map((c) => c.id),
    succeeded: [...succeeded],
    failed: [...failed],
    sources,
    completedRuns,
  };
}

/** 单轮采集：并发调起全部可用 adapter，归并成带来源标记的样本 */
async function collectOnce(
  usable: readonly CollectorPort[],
  ctx: CollectContext,
  now: () => Date,
  logger: LoggerPort,
): Promise<{
  artifacts: RawArtifact[];
  samples: SourcedSample[];
  succeeded: AdapterId[];
  failed: AdapterId[];
  warnings: RunWarning[];
}> {
  const settled = await Promise.allSettled(usable.map((collector) => collector.collect(ctx)));

  const artifacts: RawArtifact[] = [];
  const samples: SourcedSample[] = [];
  const succeeded: AdapterId[] = [];
  const failed: AdapterId[] = [];
  const warnings: RunWarning[] = [];

  settled.forEach((outcome, index) => {
    const collector = usable[index];
    if (collector === undefined) return;

    if (outcome.status === 'rejected') {
      const error = toPerfPilotError(outcome.reason, 'ADAPTER_FAILED');
      failed.push(collector.id);
      warnings.push({
        adapter: collector.id,
        code: error.code,
        severity: 'degraded',
        message: `${collector.id} 采集失败：${error.message}`,
      });
      logger.error('adapter 采集失败', { adapter: collector.id, code: error.code });
      return;
    }

    const produced = outcome.value;
    artifacts.push(...produced);

    // 采集成功但解析失败同样是「这个来源没数据」，与采集失败同等对待
    try {
      const producedSamples = collector.toMetrics(produced);
      const collectedAt = now().toISOString();
      for (const sample of producedSamples) {
        samples.push({ ...sample, source: collector.id, collectedAt });
      }
      succeeded.push(collector.id);
      logger.debug('adapter 采集完成', {
        adapter: collector.id,
        artifacts: produced.length,
        samples: producedSamples.length,
      });
    } catch (err) {
      const error = toPerfPilotError(err, 'ADAPTER_OUTPUT_INVALID');
      failed.push(collector.id);
      warnings.push({
        adapter: collector.id,
        code: error.code,
        severity: 'degraded',
        message: `${collector.id} 输出无法解析：${error.message}`,
      });
      logger.error('adapter 输出解析失败', { adapter: collector.id, error: error.message });
    }
  });

  return { artifacts, samples, succeeded, failed, warnings };
}

/**
 * 逐 (指标, 来源) 取中位数。
 *
 * 为什么按来源分组而不是按指标直接取中位数：同一个指标的两次测量
 * 若来自不同工具（Lighthouse vs web-vitals），**它们的数字本来就不是一回事**，
 * 取中位数只是把两个口径平均了一下，毫无意义。仲裁（选哪个来源）在下一步做。
 *
 * 偶数个样本取中间两个的平均值 —— 这是中位数的标准定义之一，
 * 比"取偏小那个"更不容易被极端值带偏。
 */
export function medianBySource(samples: readonly SourcedSample[]): SourcedSample[] {
  const groups = new Map<string, SourcedSample[]>();

  for (const sample of samples) {
    const key = `${sample.name}\u0000${sample.source}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [sample]);
    else group.push(sample);
  }

  const merged: SourcedSample[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => a.value - b.value);
    const middle = Math.floor(sorted.length / 2);

    const median =
      sorted.length % 2 === 1
        ? sorted[middle]
        : // 偶数个：中间两个的平均；用后一个样本携带来源等元数据
          averagePair(sorted[middle - 1], sorted[middle]);

    if (median !== undefined) merged.push(median);
  }

  return merged;
}

function averagePair(
  left: SourcedSample | undefined,
  right: SourcedSample | undefined,
): SourcedSample | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return { ...right, value: (left.value + right.value) / 2 };
}

/**
 * 来源仲裁：每个指标只保留优先级最高的那个样本。
 *
 * 同时处理一个容易忽略的情况：**首选来源产出了数据、但没产出这个指标**。
 * 例如 Lighthouse 跑通了却没给出 INP（实验室测不准），此时落到 web-vitals，
 * 是合理的降级，但必须在报告里说出来。
 */
function arbitrate(
  samples: readonly SourcedSample[],
  route: string,
  device: Device,
  thresholds?: MetricThresholdsOverride,
): {
  metrics: Metric[];
  sources: Partial<Record<MetricName, AdapterId>>;
  arbitrationWarnings: RunWarning[];
} {
  const byMetric = new Map<MetricName, SourcedSample[]>();
  for (const sample of samples) {
    const existing = byMetric.get(sample.name);
    if (existing) existing.push(sample);
    else byMetric.set(sample.name, [sample]);
  }

  const metrics: Metric[] = [];
  const sources: Partial<Record<MetricName, AdapterId>> = {};
  const arbitrationWarnings: RunWarning[] = [];

  for (const [name, candidates] of byMetric) {
    const priority = METRIC_SOURCE_PRIORITY[name];
    const ranked = [...candidates].sort(
      (a, b) => rankOf(priority, a.source) - rankOf(priority, b.source),
    );
    const chosen = ranked[0];
    if (chosen === undefined) continue;

    if (rankOf(priority, chosen.source) > 0) {
      arbitrationWarnings.push({
        adapter: chosen.source,
        code: 'METRIC_SOURCE_FALLBACK',
        severity: 'info',
        message: `${name} 本次来源为 ${chosen.source}（首选 ${priority[0] ?? '无'} 未产出该指标），跨次对比时请确认来源一致`,
      });
    }

    sources[name] = chosen.source;
    metrics.push(
      buildMetric({
        name,
        value: chosen.value,
        route,
        device,
        source: chosen.source,
        collectedAt: chosen.collectedAt,
        ...(thresholds !== undefined ? { overrides: thresholds } : {}),
      }),
    );
  }

  return { metrics, sources, arbitrationWarnings };
}

function rankOf(priority: readonly AdapterId[], source: AdapterId): number {
  const index = priority.indexOf(source);
  // 不在优先级表里的来源排在最后，但仍然可以用（新增 adapter 时不至于丢数据）
  return index === -1 ? priority.length + 1 : index;
}

/**
 * 全部**被调用的** adapter 都失败时抛错。
 *
 * 与「部分失败」的区别很重要：部分失败产出的是**可用的不完整报告**，
 * 全部失败产出的是**零指标报告**——后者如果只记 warning，
 * CI 会看到一个「没有回归」的绿色结果，而真相是根本没测成。
 *
 * 分母用 `attempted` 而不是 `collectors.length`：探活就没通过、从一开始
 * 就没参与的 adapter 不该被算作「失败」，也不该因此掩盖真实的全军覆没。
 */
export function assertCollectionUsable(result: CollectResult): void {
  if (result.attempted.length > 0 && result.failed.length === result.attempted.length) {
    throw new AdapterError(`全部 ${result.attempted.length} 个采集适配器均失败，无法产出指标`, {
      code: 'COLLECT_FAILED',
      stage: 'collect',
      retryable: true,
      details: { warnings: result.warnings },
    });
  }
}
