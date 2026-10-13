import {
  METRIC_SPECS,
  formatDuration,
  formatSignedScore,
  formatSignedValue,
  formatValue,
  type Candidate,
  type Decision,
  type Diagnosis,
  type Metric,
  type ReporterPort,
  type RunRecord,
  type Verification,
} from '@yuki-byte18/shared';

/**
 * MR / PR 评论（README §12、M7 验收 3）。
 *
 * 与 `report.md` 是**两种读物**，不是同一份东西的两个副本：
 *
 * | | report.md | MR 评论 |
 * | --- | --- | --- |
 * | 读者 | 专门来看诊断报告的人 | 正在评审这次改动的人 |
 * | 场景 | 主动打开 | 顺手扫一眼 |
 * | 该回答 | 全部细节 | 这次改动**让性能变差了吗**、要不要拦 |
 *
 * 因此这里刻意做减法：指标表 + 瓶颈 top3 + 决策摘要 + 报告链接。
 * 把 report.md 整份贴进 MR 的结果是没人读 —— 而 MR 评论的唯一价值
 * 就是在评审现场给出那一个判断。
 */

export const MR_COMMENT_MARKER = '<!-- perfpilot-report -->';

export interface MrCommentInput {
  run: RunRecord;
  diagnosis: Diagnosis | null;
  candidates?: readonly Candidate[];
  decisions?: readonly Decision[];
  verifications?: readonly Verification[];
  /** 报告链接（CI artifact 地址或服务端 URL） */
  reportUrl?: string | null;
  /** 门禁结论；不传则不显示门禁一节 */
  gate?: { passed: boolean; failures: string[] } | null;
}

/**
 * 渲染评论。
 *
 * 首行是一个 HTML 注释标记：CI 里同一个 MR 会被多次推送触发，
 * 没有标记就只能靠"看起来像不像"去判断哪条旧评论该更新，
 * 结果往往是每次推送都追加一条 —— 一个来回十几次的 MR 会攒出十几条评论。
 */
export function renderMrComment(input: MrCommentInput): string {
  const { run, diagnosis, decisions = [], verifications = [], reportUrl = null } = input;
  const lines: string[] = [MR_COMMENT_MARKER];

  const regressions = run.deltas
    .filter((d) => (d.scoreDelta ?? 0) < 0)
    .sort((a, b) => (a.scoreDelta ?? 0) - (b.scoreDelta ?? 0));

  lines.push(...renderHeadline(run, regressions.length));
  if (input.gate != null) lines.push(...renderGate(input.gate));
  lines.push(...renderMetricsTable(run));
  lines.push(...renderTopBottlenecks(diagnosis));
  lines.push(...renderDecisionSummary(decisions, verifications, input.candidates ?? []));
  lines.push(...renderFooter(run, reportUrl));

  return `${lines.join('\n')}\n`;
}

/** 一句话结论放最前面：评审的人可能只看这一行 */
function renderHeadline(run: RunRecord, regressionCount: number): string[] {
  const icon =
    run.status === 'failed' ? '❌' : regressionCount > 0 ? '⚠️' : run.status === 'partial' ? '⚡' : '✅';

  const summary =
    run.baseline === null
      ? '本次无基线可比，结果将作为后续基线'
      : regressionCount > 0
        ? `发现 **${regressionCount} 项回归**`
        : '未发现回归';

  return [
    `## ${icon} PerfPilot 性能门禁 · ${summary}`,
    '',
    `> 路由 \`${run.route}\` · 设备 \`${run.device}\` · 状态 \`${run.status}\` · 耗时 ${formatDuration(run.durationMs)} · run \`${run.id}\``,
    '',
  ];
}

function renderGate(gate: { passed: boolean; failures: string[] }): string[] {
  if (gate.passed) return ['**门禁：通过** ✅', ''];

  return [
    '**门禁：未通过** ⛔',
    '',
    ...gate.failures.map((f) => `- ${f}`),
    '',
  ];
}

/**
 * 指标表。
 *
 * 只列**有差值的**指标：MR 评论里放一堆「—」会让人以为工具没测出东西。
 * 首次运行没有基线时全部显示当前值 —— 那时读者关心的是"现在是多少"。
 */
function renderMetricsTable(run: RunRecord): string[] {
  if (run.metrics.length === 0) {
    return ['> ⚠️ 本次没有采集到任何指标，无法判定性能变化。', ''];
  }

  const sorted = [...run.metrics].sort((a, b) => a.name.localeCompare(b.name));
  const lines = ['| 指标 | 当前 | 基线 | 变化 | 分数变化 |', '| --- | ---: | ---: | ---: | ---: |'];

  const ratingIcon: Record<Metric['rating'], string> = {
    good: '🟢',
    'needs-improvement': '🟡',
    poor: '🔴',
  };

  for (const metric of sorted) {
    const spec = METRIC_SPECS[metric.name];
    const delta = run.deltas.find((d) => d.name === metric.name);
    lines.push(
      [
        `| ${ratingIcon[metric.rating]} ${metric.name}`,
        formatValue(metric.value, spec.unit, spec.precision),
        delta?.baseline == null ? '—' : formatValue(delta.baseline, spec.unit, spec.precision),
        formatSignedValue(delta?.delta ?? null, spec.unit, spec.precision),
        `${formatSignedScore(delta?.scoreDelta ?? null)} |`,
      ].join(' | '),
    );
  }

  lines.push('');
  return lines;
}

/** 瓶颈 top3：多了没人看，少了不够判断"要不要在这次 MR 里处理" */
function renderTopBottlenecks(diagnosis: Diagnosis | null): string[] {
  if (diagnosis === null || diagnosis.bottlenecks.length === 0) return [];

  const top = [...diagnosis.bottlenecks].sort((a, b) => b.severity - a.severity).slice(0, 3);
  const lines = ['### 主要瓶颈', ''];

  for (const bottleneck of top) {
    const where = describeWhere(bottleneck.attribution);
    lines.push(
      `- **${bottleneck.title}**（严重度 ${bottleneck.severity}${where === '' ? '' : ` · ${where}`}）`,
    );
  }

  const rest = diagnosis.bottlenecks.length - top.length;
  if (rest > 0) lines.push(`- 另有 ${rest} 项，见完整报告`);
  lines.push('');
  return lines;
}

/** 归因落到"改哪里"：文件:行 > 依赖 > 资源 > 组件 > 配置 */
function describeWhere(attribution: Diagnosis['bottlenecks'][number]['attribution']): string {
  switch (attribution.level) {
    case 'source':
      return `\`${attribution.file}${attribution.line === null ? '' : `:${attribution.line}`}\``;
    case 'dependency':
      return `依赖 \`${attribution.name}${attribution.version === null ? '' : `@${attribution.version}`}\``;
    case 'resource':
      return `资源 \`${shortenUrl(attribution.url)}\``;
    case 'component':
      return `组件 \`${attribution.name}\``;
    case 'config':
      return `配置 \`${attribution.file}${attribution.key === null ? '' : ` → ${attribution.key}`}\``;
    default:
      return '';
  }
}

function shortenUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.pathname.split('/').filter(Boolean).pop() ?? parsed.pathname;
  } catch {
    return url;
  }
}

/**
 * 决策与验证摘要。
 *
 * 「自动改了什么、结果如何」是评审者最需要知道、也最容易漏掉的一节：
 * 一个工具在 MR 上改了代码却只字不提，比不改更糟。
 */
function renderDecisionSummary(
  decisions: readonly Decision[],
  verifications: readonly Verification[],
  candidates: readonly Candidate[],
): string[] {
  if (decisions.length === 0) return [];

  const counts = {
    apply: decisions.filter((d) => d.verdict === 'apply').length,
    confirm: decisions.filter((d) => d.verdict === 'confirm').length,
    suggest: decisions.filter((d) => d.verdict === 'suggest').length,
    reject: decisions.filter((d) => d.verdict === 'reject').length,
  };

  const lines = [
    '### 优化决策',
    '',
    `自动执行 ${counts.apply} · 待人工确认 ${counts.confirm} · 仅建议 ${counts.suggest} · 不执行 ${counts.reject}`,
    '',
  ];

  if (verifications.length > 0) {
    const kept = verifications.filter((v) => v.status === 'kept');
    const rolled = verifications.filter((v) => v.status === 'rolled_back');
    const titleOf = new Map(candidates.map((c) => [c.id, c.title]));

    lines.push(`验证结果：**保留 ${kept.length}** · **回滚 ${rolled.length}**`, '');
    for (const verification of [...kept, ...rolled]) {
      const icon = verification.status === 'kept' ? '✅' : '↩️';
      const title = titleOf.get(verification.candidateId) ?? verification.candidateId;
      const gain = Object.entries(verification.gain)
        .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
        .map(([name, value]) => {
          const spec = METRIC_SPECS[name as keyof typeof METRIC_SPECS];
          return `${name} ${formatSignedValue(value, spec.unit, spec.precision)}`;
        })
        .join('、');

      lines.push(
        `- ${icon} **${title}** — ${verification.status}${gain === '' ? '' : `（实际收益 ${gain}）`}`,
      );
      if (verification.gate.failedRules.length > 0) {
        lines.push(`  - 未通过原因：${verification.gate.failedRules.join('；')}`);
      }
    }
    lines.push('');
  }

  const pending = decisions.filter((d) => d.verdict === 'confirm');
  if (pending.length > 0) {
    const titleOf = new Map(candidates.map((c) => [c.id, c.title]));
    lines.push(
      '> ✋ **需要人工确认**（已生成 patch，未自动应用）：',
      ...pending.map((d) => `> - ${titleOf.get(d.candidateId) ?? d.candidateId}`),
      '',
    );
  }

  return lines;
}

function renderFooter(run: RunRecord, reportUrl: string | null): string[] {
  const artifacts = `报告产物在 \`.perfpilot/runs/${run.id}/\``;
  return [
    '---',
    '',
    reportUrl === null || reportUrl === ''
      ? `<sub>由 PerfPilot Agent 生成 · ${artifacts}</sub>`
      : `<sub>由 PerfPilot Agent 生成 · [完整报告](${reportUrl}) · ${artifacts}</sub>`,
  ];
}

/** 把评论渲染成独立 reporter，便于像其它报告一样按格式产出 */
export function createMrCommentReporter(): ReporterPort {
  return {
    format: 'markdown',
    render: ({ run, diagnosis, candidates, decisions, verifications }) => ({
      format: 'markdown',
      filename: 'mr-comment.md',
      content: renderMrComment({
        run,
        diagnosis,
        candidates: candidates ?? [],
        decisions: decisions ?? [],
        verifications: verifications ?? [],
      }),
    }),
  };
}
