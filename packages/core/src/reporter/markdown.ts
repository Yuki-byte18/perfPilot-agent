import {
  METRIC_SPECS,
  describeAttribution,
  formatDuration,
  formatSignedPercent,
  formatSignedScore,
  formatSignedValue,
  formatValue,
  type Bottleneck,
  type Candidate,
  type Decision,
  type Diagnosis,
  type ExecutionResult,
  type Metric,
  type MetricDelta,
  type MetricName,
  type OptimizationClass,
  type ReporterPort,
  type Verdict,
  type Verification,
  type RunRecord,
} from '@yuki-byte18/shared';

/**
 * 报告必须显式回答的三个问题。
 * 这是质量的「必答集」：LCP/CLS/INP 少任何一个，用户都需要立刻知道，
 * 而不是从一张只有 5 行的表里自己发现少了一行。
 */
const CORE_METRICS: readonly MetricName[] = ['LCP', 'CLS', 'INP'];

const RATING_ICON: Record<Metric['rating'], string> = {
  good: '🟢',
  'needs-improvement': '🟡',
  poor: '🔴',
};

/**
 * Markdown 报告。纯函数：`RunRecord` 进，字符串出。
 *
 * 排版上的三个取舍：
 * 1. **回归单独成节并置顶**，而不是只体现在表格里的负号。CI 里人会只扫一眼，
 *    那一眼必须能看到「变差了什么」。
 * 2. **未采集指标单独列出**。「没有数据」和「数据正常」是两件事，
 *    混在同一个表格里会让人把缺失读成通过。
 * 3. **告警区不折叠**。降级采集是这个工具最需要被察觉的状态。
 */
export function renderMarkdown(
  run: RunRecord,
  diagnosis: Diagnosis | null = null,
  candidates: readonly Candidate[] = [],
  decisions: readonly Decision[] = [],
  executions: readonly ExecutionResult[] = [],
  verifications: readonly Verification[] = [],
): string {
  const lines: string[] = [];

  lines.push(`# PerfPilot 性能报告 — ${run.project}`, '');
  lines.push(...renderMeta(run));
  lines.push(...renderVerdict(run));
  lines.push(...renderRegressions(run));
  lines.push(...renderMetricsTable(run));
  lines.push(...renderMissingMetrics(run));
  lines.push(...renderDiagnosis(diagnosis));
  lines.push(...renderCandidates(candidates));
  lines.push(...renderDecisions(decisions, candidates));
  lines.push(...renderVerifications(verifications, candidates, executions));
  lines.push(...renderWarnings(run));
  lines.push(...renderStages(run));
  lines.push(...renderFooter(run));

  return `${lines.join('\n')}\n`;
}

/**
 * 执行与验证区（M5）。
 *
 * 这一节回答的是整个工具最要紧的一个问题：**「你改了我的代码没有？现在是什么状态？」**
 *
 * 因此三件事必须逐条写出来：
 * 1. 每个候选产出了什么（补丁 / 哪些文件 / 摘要）—— 这是人工确认 B 类的唯一依据
 * 2. 验证跑过了什么检查（跳过与通过要分开）
 * 3. 最后**保留还是回滚**，以及未通过时**具体哪一条判据没过**
 *
 * 回滚必须显眼：一次被回滚的改动如果只以 `rejected` 悄悄消失，
 * 读者会以为「什么都没发生」，而实际上工作区经历了一次改动 + 一次 reset。
 */
function renderVerifications(
  verifications: readonly Verification[],
  candidates: readonly Candidate[],
  executions: readonly ExecutionResult[],
): string[] {
  if (verifications.length === 0 && executions.length === 0) return [];

  const titleOf = new Map(candidates.map((c) => [c.id, c.title]));
  const lines: string[] = ['## 🔧 执行与验证', ''];

  if (executions.length > 0) {
    lines.push('| 方案 | 路由 | 产物 | 文件 |', '| --- | --- | --- | --- |');
    for (const execution of executions) {
      const artifact =
        execution.patch !== ''
          ? 'patch'
          : execution.applied
            ? '二进制已写入'
            : '仅评估（未写入）';
      lines.push(
        `| ${escapeCell(titleOf.get(execution.candidateId) ?? execution.candidateId)} | \`${execution.route}\` | ${artifact} | ${escapeCell(execution.files.join(', ') || '—')} |`,
      );
    }
    lines.push('');

    // 摘要单独列：它是人工确认时唯一能看到的"改了什么、省了多少"
    for (const execution of executions) {
      const details = execution.summary.split('\n').filter((l) => l.trim() !== '');
      if (details.length <= 1) continue;
      lines.push(
        `<details><summary>${escapeCell(titleOf.get(execution.candidateId) ?? execution.candidateId)} 的改动明细</summary>`,
        '',
        ...details.map((line) => `- ${escapeCell(line)}`),
        '',
        '</details>',
        '',
      );
    }
  }

  if (verifications.length === 0) {
    lines.push('_本次没有任何候选被验证（没有 apply 裁决，或缺少 git / 重采集能力）。_', '');
    return lines;
  }

  const kept = verifications.filter((v) => v.status === 'kept').length;
  const rolled = verifications.length - kept;
  lines.push(
    `共验证 **${verifications.length}** 个候选：**保留 ${kept}**、**回滚 ${rolled}**。`,
    '',
  );

  for (const verification of verifications) {
    const icon = verification.status === 'kept' ? '✅' : '↩️';
    const title = titleOf.get(verification.candidateId) ?? verification.candidateId;
    lines.push(`### ${icon} ${escapeCell(title)} — ${verification.status}`, '');

    const gain = Object.entries(verification.gain)
      .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
      .map(([name, value]) => {
        const spec = METRIC_SPECS[name as MetricName];
        return `${name} ${formatSignedValue(value, spec.unit, spec.precision)}`;
      })
      .join(' · ');
    lines.push(`- **实际收益**：${gain === '' ? '无指标变化' : escapeCell(gain)}`);
    lines.push(
      `- **门禁**：${verification.gate.passed ? '通过' : '未通过'}` +
        (verification.git === null
          ? ''
          : ` · 回滚目标 \`${verification.git.baseRef}\`` +
            (verification.git.resultRef !== null ? ` · 结果 \`${verification.git.resultRef}\`` : '') +
            (verification.git.reverted ? ' · **已回滚**' : '')),
    );
    lines.push(
      `- **检查**：${verification.checks
        .map((c) => `${c.kind}${c.skipped ? '(跳过)' : c.passed ? '✅' : '❌'}`)
        .join(' · ')}`,
    );

    if (verification.gate.failedRules.length > 0) {
      lines.push(`- **未通过原因**：${escapeCell(verification.gate.failedRules.join('；'))}`);
    }
    // 检查失败要给出输出摘要，否则只有"单测挂了"这句话，人还得自己去翻日志
    for (const check of verification.checks) {
      if (check.passed || check.output === null) continue;
      lines.push(
        '',
        `  <details><summary>${check.kind} 输出</summary>`,
        '',
        '```',
        check.output,
        '```',
        '',
        '  </details>',
      );
    }
    lines.push('');
  }

  return lines;
}

/**
 * 决策区。
 *
 * 与「优化方案」分开成两节是刻意的：方案是**提议**，决策是**裁决**。
 * 读者最关心「哪些会被自动改」—— 混在一起就得逐行去猜哪条真要落地。
 *
 * 被拒绝的候选**必须列出来并附理由**：「为什么没做」和「做了什么」一样重要，
 * 只记录执行过的会让报告失去解释力（「我提的建议去哪了？」）。
 */
function renderDecisions(
  decisions: readonly Decision[],
  candidates: readonly Candidate[],
): string[] {
  if (decisions.length === 0) return [];

  const titleOf = new Map(candidates.map((c) => [c.id, c.title]));
  const lines: string[] = ['## ⚖️ Jev 决策', ''];

  const verdictMeta: Record<Verdict, string> = {
    apply: '全自动执行',
    confirm: '待人工确认',
    suggest: '仅建议',
    reject: '不执行',
  };

  lines.push(
    (['apply', 'confirm', 'suggest', 'reject'] as const)
      .map((v) => `${verdictMeta[v]} ${decisions.filter((d) => d.verdict === v).length}`)
      .join(' · '),
    '',
  );

  lines.push(
    '| 裁决 | 方案 | utility | 收益×置信 | 成本 | 风险 | 等级 | 路由 |',
    '| :---: | --- | ---: | ---: | ---: | ---: | :---: | --- |',
  );

  const verdictIcon: Record<Verdict, string> = {
    apply: '🚀',
    confirm: '✋',
    suggest: '💡',
    reject: '⛔',
  };

  for (const decision of decisions) {
    const gain = `${decision.utility.expectedGain.toFixed(0)}×${decision.utility.confidence.toFixed(2)}`;
    lines.push(
      `| ${verdictIcon[decision.verdict]} ${decision.verdict} | ${escapeCell(titleOf.get(decision.candidateId) ?? decision.candidateId)} | ${decision.score.toFixed(1)} | ${gain} | ${decision.utility.cost.toFixed(0)} | ${decision.utility.risk.toFixed(0)} | ${decision.riskLevel} | \`${decision.route}\` |`,
    );
  }
  lines.push('');

  const rejected = decisions.filter((d) => d.verdict === 'reject');
  if (rejected.length > 0) {
    lines.push('### 未执行的原因', '');
    for (const decision of rejected) {
      lines.push(
        `- **${escapeCell(titleOf.get(decision.candidateId) ?? decision.candidateId)}**：${escapeCell(decision.reasons.slice(-2).join('；'))}`,
      );
    }
    lines.push('');
  }

  return lines;
}

/**
 * 优化方案区。
 *
 * 按分级（A/B/C）分组而不是一锅端：读者对这三类的**下一步动作**完全不同 ——
 * A 类可以直接看会不会被自动执行，B 类需要人工确认，C 类只需知道。
 * 混在一张表里，读者得逐行判断「这条我要不要管」。
 */
function renderCandidates(candidates: readonly Candidate[]): string[] {
  if (candidates.length === 0) return [];

  const lines: string[] = ['## 🛠 优化方案', ''];

  const label: Record<OptimizationClass, string> = {
    A: 'A 类 · 全自动（不改运行时语义，可直接执行）',
    B: 'B 类 · 半自动（生成 patch，需人工确认）',
    C: 'C 类 · 仅建议（不产出 patch）',
  };

  lines.push(
    `共 ${candidates.length} 个候选：` +
      (['A', 'B', 'C'] as const)
        .map((c) => `${c} 类 ${candidates.filter((x) => x.class === c).length} 个`)
        .join('、'),
    '',
  );

  for (const klass of ['A', 'B', 'C'] as const) {
    const group = candidates.filter((c) => c.class === klass);
    if (group.length === 0) continue;

    lines.push(`### ${label[klass]}`, '');
    lines.push('| 方案 | 预期收益 | 置信度 | 风险 | 可逆 | 来源 |', '| --- | --- | ---: | :---: | :---: | --- |');

    for (const candidate of group) {
      const gain = Object.entries(candidate.expectedGain)
        .filter(([, v]) => v !== undefined && v !== 0)
        .map(([name, v]) => {
          const spec = METRIC_SPECS[name as keyof typeof METRIC_SPECS];
          return `${name} ${formatValue(v as number, spec.unit, spec.precision)}`;
        })
        .join(' · ');

      lines.push(
        `| ${escapeCell(candidate.title)} | ${gain === '' ? '—' : escapeCell(gain)} | ${(candidate.confidence * 100).toFixed(0)}% | ${candidate.risk} | ${candidate.reversible ? '✅' : '❌'} | \`${candidate.origin}\`${candidate.promptVersion === null ? '' : ` (${candidate.promptVersion})`} |`,
      );
    }
    lines.push('');

    /**
     * 说明文字单独列出来。
     *
     * 表格里塞不下它，但「为什么这么改」全在 `description` 里 ——
     * 只渲染标题，读者拿到的是一句论断，无从判断该不该采纳，
     * 更看不到具体要改什么（例如那条只在配置里加一行的建议）。
     */
    for (const candidate of group) {
      lines.push(`- **${escapeCell(candidate.title)}**：${escapeCell(candidate.description)}`);
    }
    lines.push('');
  }

  return lines;
}

/**
 * 瓶颈区。
 *
 * 排序、合并、归因全部已经在诊断层做完，这里只负责**排版**。
 * 三个刻意的取舍：
 * 1. **归因放在标题下一行**，因为「改哪里」比「有多严重」更可行动。
 * 2. **影响量用原始单位**（ms / KB），不用分数 —— 分数是给门禁用的，
 *    开发者要看到的是「能省 240KB」。
 * 3. **证据折叠进 details**。默认只给结论，需要复核时再展开，
 *    否则一份报告会被原始 JSON 淹没。
 */
function renderDiagnosis(diagnosis: Diagnosis | null): string[] {
  if (diagnosis === null) return [];

  const lines: string[] = ['## 🔍 诊断结论', ''];
  lines.push(`> ${diagnosis.summary}`, '');

  if (diagnosis.bottlenecks.length === 0) {
    lines.push('_未发现瓶颈。_', '');
    return lines;
  }

  const severityIcon = (severity: number): string =>
    severity >= 70 ? '🔴' : severity >= 40 ? '🟡' : '⚪';

  lines.push(
    '| 严重度 | 瓶颈 | 归因 | 影响 | 出现 | 置信度 | 来源 |',
    '| :---: | --- | --- | --- | ---: | ---: | :---: |',
  );

  for (const bottleneck of diagnosis.bottlenecks) {
    lines.push(
      `| ${severityIcon(bottleneck.severity)} ${bottleneck.severity} | ${escapeCell(bottleneck.title)} | ${escapeCell(describeAttribution(bottleneck.attribution))} | ${formatImpact(bottleneck.impact)} | ${bottleneck.occurrences} | ${(bottleneck.confidence * 100).toFixed(0)}% | ${bottleneck.source === 'llm' ? '🤖 LLM' : '规则'} |`,
    );
  }
  lines.push('');

  /**
   * 来源列必须解释清楚，否则"🤖 LLM"会被读成"更权威"。
   * 事实相反：LLM 的结论上限置信度 75%、必须带证据，而且**可能被丢弃**
   * （重复、无证据、超出每轮上限）。
   */
  if (diagnosis.bottlenecks.some((b) => b.source === 'llm')) {
    lines.push(
      '> 来源：**规则**＝确定性规则算出来的（可复现）；**🤖 LLM**＝诊断 agent 给的' +
        '（必须带证据、置信度上限 75%；与规则重复或无证据的结论会被丢弃）。',
      '',
    );
  }

  // 证据单独成节，默认折叠
  for (const bottleneck of diagnosis.bottlenecks.slice(0, 5)) {
    if (bottleneck.evidence.length === 0) continue;
    lines.push(
      `<details><summary>证据：${escapeCell(bottleneck.title)}</summary>`,
      '',
    );
    for (const evidence of bottleneck.evidence) {
      lines.push(`- ${escapeCell(evidence.description)}`);
    }
    lines.push(
      '',
      '```json',
      truncateJson(bottleneck.evidence[0]?.payload),
      '```',
      '',
      '</details>',
      '',
    );
  }

  return lines;
}

/** 影响量按单位渲染；时间类取最大、体积类求和（见 merge.ts 的说明） */
function formatImpact(impact: Bottleneck['impact']): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(impact)) {
    if (value === undefined || value === 0) continue;
    const spec = METRIC_SPECS[name as keyof typeof METRIC_SPECS];
    parts.push(`${name} ${formatValue(value, spec.unit, spec.precision)}`);
  }
  return parts.length === 0 ? '—' : escapeCell(parts.join(' · '));
}

function truncateJson(payload: unknown): string {
  const text = JSON.stringify(payload, null, 2) ?? 'null';
  return text.length > 1_200 ? `${text.slice(0, 1_200)}\n  … (已截断)` : text;
}

function renderMeta(run: RunRecord): string[] {
  const baseline = run.baseline
    ? `\`${run.baseline.ref}\`${run.baseline.runId ? ` (${run.baseline.runId})` : ''}`
    : '无';
  return [
    `**路由** \`${run.route}\` · **设备** \`${run.device}\` · **状态** \`${run.status}\``,
    '',
    `**运行** \`${run.id}\` · **开始** ${run.startedAt} · **耗时** ${formatDuration(run.durationMs)}`,
    '',
    `**目标** ${run.url} · **基线** ${baseline} · **版本** v${run.perfpilotVersion}` +
      // 花了钱就得写在最显眼的地方；没接 LLM 时（0）不显示这一项
      (run.llmCostUsd > 0 ? ` · **LLM 花费** $${run.llmCostUsd.toFixed(4)}` : ''),
    '',
  ];
}

function renderVerdict(run: RunRecord): string[] {
  const comparable = run.deltas.filter((d) => d.scoreDelta !== null);
  const improved = comparable.filter((d) => (d.scoreDelta ?? 0) > 0);
  const regressed = comparable.filter((d) => (d.scoreDelta ?? 0) < 0);
  const unchanged = comparable.length - improved.length - regressed.length;

  if (run.baseline === null) {
    return [
      '> **无基线可比**：本次是首个可对比的基线，指标仅作记录，不判定改善或回归。',
      '',
    ];
  }

  const tone = regressed.length > 0 ? '⚠️' : improved.length > 0 ? '✅' : '➖';
  return [
    `> ${tone} 共 ${comparable.length} 项指标与基线可比：**${improved.length} 项改善**、**${regressed.length} 项回归**、${unchanged} 项持平。`,
    '',
  ];
}

function renderRegressions(run: RunRecord): string[] {
  const regressions = run.deltas
    .filter((d) => (d.scoreDelta ?? 0) < 0)
    .sort((a, b) => (a.scoreDelta ?? 0) - (b.scoreDelta ?? 0));

  if (regressions.length === 0) return [];

  const lines = [
    '## ⚠️ 回归指标',
    '',
    '| 指标 | 基线 | 当前 | Δ% | 分数变化 |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const delta of regressions) {
    const spec = METRIC_SPECS[delta.name];
    lines.push(
      `| **${delta.name}** | ${formatValue(delta.baseline ?? 0, spec.unit, spec.precision)} | ${formatValue(
        delta.current,
        spec.unit,
        spec.precision,
      )} | ${formatSignedPercent(delta.deltaPercent)} | ${formatSignedScore(delta.scoreDelta)} |`,
    );
  }
  lines.push('');
  return lines;
}

function renderMetricsTable(run: RunRecord): string[] {
  if (run.metrics.length === 0) {
    return ['## 指标', '', '_本次运行未采集到任何指标。_', ''];
  }

  const sorted = [...run.metrics].sort((a, b) => a.name.localeCompare(b.name));
  const lines = [
    '## 指标',
    '',
    '| 指标 | 当前 | 评级 | 分数 | 基线 | Δ | Δ% | 分数变化 | 来源 |',
    '| --- | ---: | :---: | ---: | ---: | ---: | ---: | ---: | --- |',
  ];

  for (const metric of sorted) {
    const delta = run.deltas.find((d) => d.name === metric.name);
    lines.push(renderMetricRow(metric, delta ?? null));
  }

  lines.push('');
  return lines;
}

function renderMetricRow(metric: Metric, delta: MetricDelta | null): string {
  const spec = METRIC_SPECS[metric.name];
  const current = formatValue(metric.value, spec.unit, spec.precision);
  const baseline = delta?.baseline == null ? '—' : formatValue(delta.baseline, spec.unit, spec.precision);
  const change = formatSignedValue(delta?.delta ?? null, spec.unit, spec.precision);

  return [
    `| ${RATING_ICON[metric.rating]} ${metric.name}`,
    current,
    metric.rating,
    metric.score.toFixed(1),
    baseline,
    change,
    formatSignedPercent(delta?.deltaPercent ?? null),
    formatSignedScore(delta?.scoreDelta ?? null),
    `\`${metric.source}\` |`,
  ].join(' | ');
}

/**
 * 「没有数据」必须被说出来。
 *
 * 一个只列已采集指标的表格，会让 INP 缺失看起来像是「INP 没问题」。
 * 报告的第一职责是让读者知道**自己不知道什么**。
 */
function renderMissingMetrics(run: RunRecord): string[] {
  const present = new Set<MetricName>(run.metrics.map((m) => m.name));
  const missing = CORE_METRICS.filter((name) => !present.has(name));
  if (missing.length === 0) return [];

  const lines = [
    '## ❓ 未采集的核心指标',
    '',
    '以下指标本次没有数据。**它们不代表「正常」**，只代表没有被测量：',
    '',
  ];
  for (const name of missing) {
    lines.push(`- **${name}** — ${missingHint(name)}`);
  }
  lines.push('');
  return lines;
}

function missingHint(name: MetricName): string {
  switch (name) {
    case 'LCP':
      return 'Lighthouse 未运行成功，或未产出该审计项';
    case 'CLS':
      return 'Lighthouse 未运行成功，或未产出该审计项';
    case 'INP':
      return '需要页面侧 web-vitals 上报（`.perfpilot/vitals.json`），实验室环境无法产出';
    default:
      return '采集来源未产出该指标';
  }
}

function renderWarnings(run: RunRecord): string[] {
  if (run.warnings.length === 0) return [];

  const icon = { info: 'ℹ️', degraded: '⚠️' } as const;
  const lines = [
    '## ⚡ 采集告警',
    '',
    '| 级别 | 适配器 | 代码 | 说明 |',
    '| :---: | --- | --- | --- |',
  ];
  for (const warning of run.warnings) {
    lines.push(
      `| ${icon[warning.severity]} ${warning.severity} | \`${warning.adapter ?? '—'}\` | \`${warning.code}\` | ${escapeCell(warning.message)} |`,
    );
  }
  lines.push('');
  return lines;
}

function renderStages(run: RunRecord): string[] {
  const icon = { ok: '✅', skipped: '⏭️', failed: '❌' } as const;
  const lines = [
    '## 流水线阶段',
    '',
    '| 阶段 | 状态 | 耗时 | 备注 |',
    '| --- | :---: | ---: | --- |',
  ];
  for (const stage of run.stages) {
    lines.push(
      `| ${stage.name} | ${icon[stage.status]} ${stage.status} | ${formatDuration(
        stage.durationMs,
      )} | ${stage.note === null ? '—' : escapeCell(stage.note)} |`,
    );
  }
  lines.push('');
  return lines;
}

function renderFooter(run: RunRecord): string[] {
  return [
    '---',
    '',
    `<sub>由 PerfPilot Agent 生成 · run \`${run.id}\` · 原始数据见 \`.perfpilot/runs/${run.id}/run.json\`</sub>`,
    '',
  ];
}

/** 表格单元格里的 `|` 会截断 Markdown 表格 */
function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function createMarkdownReporter(): ReporterPort {
  return {
    format: 'markdown',
    render: ({ run, diagnosis, candidates, decisions, executions, verifications }) => ({
      format: 'markdown',
      filename: 'report.md',
      content: renderMarkdown(
        run,
        diagnosis,
        candidates ?? [],
        decisions ?? [],
        executions ?? [],
        verifications ?? [],
      ),
    }),
  };
}
