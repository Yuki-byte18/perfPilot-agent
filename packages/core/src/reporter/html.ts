import {
  describeAttribution,
  formatDuration,
  formatValue,
  METRIC_SPECS,
  type Candidate,
  type Decision,
  type Diagnosis,
  type ExecutionResult,
  type MetricDelta,
  type MetricName,
  type ReporterPort,
  type RunRecord,
  type Verification,
} from '@yuki-byte18/shared';

/**
 * HTML 报告。
 *
 * ## 它存在的理由
 *
 * Markdown 是给**评审现场**看的（MR 评论、终端），JSON 是给机器看的。
 * HTML 是给**归档**看的：CI artifact 下载下来双击就能打开，
 * 不依赖任何工具链，也不用把 markdown 渲染成网页。
 * `report.format` 从第一天起就声明了 `html` 这一项，之前一直是静默跳过。
 *
 * ## 为什么手写字符串而不是引模板引擎
 *
 * 一个模板引擎为了"支持 HTML 报告"这件事引入的依赖，比这个文件本身还大。
 * 这份报告的结构是固定的几张表，`lines.push` 就够了。
 *
 * ## 转义是这一页唯一的风险点
 *
 * 报告里的内容全部来自被测项目（URL、源码路径、图片名、依赖名、错误信息）。
 * 这些是**外部输入**：一个叫 `<img src=x onerror=alert(1)>.png` 的图片
 * 就能在这份报告里执行脚本 —— 而报告会被上传成 CI artifact、被人打开。
 * 因此 `esc()` 用在**每一个**插入点上，包括属性值。
 */

const RATING_COLOR: Record<RunRecord['metrics'][number]['rating'], string> = {
  good: '#14803c',
  'needs-improvement': '#a15c00',
  poor: '#b42318',
};

/** HTML 转义。属性值也走它，因此引号必须一起转 */
function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderHtml(input: {
  run: RunRecord;
  diagnosis: Diagnosis | null;
  candidates?: readonly Candidate[];
  decisions?: readonly Decision[];
  executions?: readonly ExecutionResult[];
  verifications?: readonly Verification[];
}): string {
  const { run, diagnosis } = input;
  const candidates = input.candidates ?? [];
  const decisions = input.decisions ?? [];
  const verifications = input.verifications ?? [];

  const body = [
    `<h1>PerfPilot 性能报告 — ${esc(run.project)}</h1>`,
    renderMeta(run),
    renderOverview(run),
    renderRegressions(run),
    renderMetrics(run),
    renderMissing(run),
    renderDiagnosis(diagnosis),
    renderDecisions(decisions, candidates),
    renderVerifications(verifications, candidates),
    renderWarnings(run),
    renderStages(run),
  ].join('\n');

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PerfPilot 报告 — ${esc(run.project)} · ${esc(run.route)}</title>
<style>
  :root { color-scheme: light dark; --fg:#1c1f23; --muted:#6b7280; --line:#e5e7eb; --bg:#fff; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e8eaed; --muted:#9aa0a6; --line:#2f333b; --bg:#16181d; } }
  body { margin:0; padding:24px 20px 64px; background:var(--bg); color:var(--fg);
         font:15px/1.55 system-ui,-apple-system,"Segoe UI","Noto Sans SC",sans-serif; }
  main { max-width:1080px; margin:0 auto; }
  h1 { font-size:1.5rem; } h2 { font-size:1.1rem; margin-top:28px; }
  table { width:100%; border-collapse:collapse; margin:10px 0; font-size:.92rem; }
  th,td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-weight:500; }
  code { font-family:ui-monospace,SFMono-Regular,Consolas,monospace; font-size:.92em; }
  .muted { color:var(--muted); }
  .stats { display:flex; flex-wrap:wrap; gap:10px; margin:14px 0; }
  .stat { border:1px solid var(--line); border-radius:10px; padding:10px 14px; min-width:110px; }
  .stat b { display:block; font-size:1.5rem; }
  details { margin:8px 0; } summary { cursor:pointer; color:var(--muted); }
  pre { overflow:auto; background:rgba(127,127,127,.08); padding:10px; border-radius:8px; }
</style>
</head>
<body>
<main>
${body}
<hr>
<p class="muted"><small>由 PerfPilot Agent 生成 · run <code>${esc(run.id)}</code></small></p>
</main>
</body>
</html>
`;
}

function renderMeta(run: RunRecord): string {
  const baseline =
    run.baseline === null
      ? '无'
      : `<code>${esc(run.baseline.ref)}</code>${run.baseline.runId === null || run.baseline.runId === undefined ? '' : ` (${esc(run.baseline.runId)})`}`;

  return `<p class="muted">
路由 <code>${esc(run.route)}</code> · 设备 <code>${esc(run.device)}</code> · 状态 <code>${esc(run.status)}</code><br>
运行 <code>${esc(run.id)}</code> · 开始 ${esc(run.startedAt)} · 耗时 ${formatDuration(run.durationMs)}<br>
目标 ${esc(run.url)} · 基线 ${baseline} · 版本 v${esc(run.perfpilotVersion)}
</p>`;
}

/** 概览数字。回归数放在最前面 —— 报告的第一职责是让人看见"变差了没有" */
function renderOverview(run: RunRecord): string {
  const comparable = run.deltas.filter((d) => d.scoreDelta !== null);
  const regressed = comparable.filter((d) => (d.scoreDelta ?? 0) < 0).length;
  const improved = comparable.filter((d) => (d.scoreDelta ?? 0) > 0).length;

  const stat = (value: number | string, label: string, color?: string): string =>
    `<div class="stat"><b${color === undefined ? '' : ` style="color:${color}"`}>${esc(String(value))}</b><span class="muted">${esc(label)}</span></div>`;

  return `<div class="stats">
${stat(regressed, '回归指标', regressed > 0 ? RATING_COLOR.poor : RATING_COLOR.good)}
${stat(improved, '改善指标', RATING_COLOR.good)}
${stat(run.metrics.length, '采集指标')}
${stat(run.warnings.filter((w) => w.severity === 'degraded').length, '降级告警')}
</div>`;
}

function renderRegressions(run: RunRecord): string {
  const regressions = run.deltas
    .filter((d) => (d.scoreDelta ?? 0) < 0)
    .sort((a, b) => (a.scoreDelta ?? 0) - (b.scoreDelta ?? 0));

  if (regressions.length === 0) return '';

  return `<h2>回归指标</h2>
<table><thead><tr><th>指标</th><th>基线</th><th>当前</th><th>Δ%</th><th>分数变化</th></tr></thead><tbody>
${regressions.map((d) => renderDeltaRow(d)).join('\n')}
</tbody></table>`;
}

function renderDeltaRow(delta: MetricDelta): string {
  const spec = METRIC_SPECS[delta.name];
  const percent = delta.deltaPercent === null ? '—' : `${delta.deltaPercent > 0 ? '+' : ''}${delta.deltaPercent}%`;

  return `<tr><td><b>${esc(delta.name)}</b></td>
<td>${delta.baseline === null ? '—' : formatValue(delta.baseline, spec.unit, spec.precision)}</td>
<td>${formatValue(delta.current, spec.unit, spec.precision)}</td>
<td>${esc(percent)}</td>
<td style="color:${(delta.scoreDelta ?? 0) < 0 ? RATING_COLOR.poor : RATING_COLOR.good}">${delta.scoreDelta === null ? '—' : `${delta.scoreDelta > 0 ? '+' : ''}${delta.scoreDelta}`}</td></tr>`;
}

function renderMetrics(run: RunRecord): string {
  if (run.metrics.length === 0) return '<h2>指标</h2><p class="muted">本次运行未采集到任何指标。</p>';

  const sorted = [...run.metrics].sort((a, b) => a.name.localeCompare(b.name));

  return `<h2>指标</h2>
<table><thead><tr><th>指标</th><th>当前</th><th>评级</th><th>分数</th><th>来源</th></tr></thead><tbody>
${sorted
  .map((metric) => {
    const spec = METRIC_SPECS[metric.name];
    return `<tr><td>${esc(metric.name)}</td>
<td>${formatValue(metric.value, spec.unit, spec.precision)}</td>
<td style="color:${RATING_COLOR[metric.rating]}">${esc(metric.rating)}</td>
<td>${metric.score.toFixed(1)}</td>
<td><code>${esc(metric.source)}</code></td></tr>`;
  })
  .join('\n')}
</tbody></table>`;
}

/** 缺失的核心指标必须单独说 —— 「没测到」和「没问题」是两件事 */
function renderMissing(run: RunRecord): string {
  const present = new Set<MetricName>(run.metrics.map((m) => m.name));
  const missing = (['LCP', 'CLS', 'INP'] as const).filter((name) => !present.has(name));
  if (missing.length === 0) return '';

  return `<h2>未采集的核心指标</h2>
<p class="muted">以下指标本次没有数据。<b>它们不代表「正常」</b>，只代表没有被测量：</p>
<ul>${missing.map((name) => `<li><b>${esc(name)}</b></li>`).join('')}</ul>`;
}

function renderDiagnosis(diagnosis: Diagnosis | null): string {
  if (diagnosis === null) return '';

  if (diagnosis.bottlenecks.length === 0) {
    return `<h2>诊断结论</h2><p class="muted">${esc(diagnosis.summary)}</p>`;
  }

  return `<h2>诊断结论</h2>
<p class="muted">${esc(diagnosis.summary)}</p>
<table><thead><tr><th>严重度</th><th>瓶颈</th><th>归因</th><th>出现</th></tr></thead><tbody>
${diagnosis.bottlenecks
  .map(
    (b) =>
      `<tr><td>${b.severity}</td><td>${esc(b.title)}</td><td><code>${esc(describeAttribution(b.attribution))}</code></td><td>${b.occurrences}</td></tr>`,
  )
  .join('\n')}
</tbody></table>`;
}

function renderDecisions(decisions: readonly Decision[], candidates: readonly Candidate[]): string {
  if (decisions.length === 0) return '';
  const titleOf = new Map(candidates.map((c) => [c.id, c.title]));

  return `<h2>决策</h2>
<table><thead><tr><th>裁决</th><th>方案</th><th>utility</th><th>路由</th><th>理由</th></tr></thead><tbody>
${decisions
  .map(
    (d) =>
      `<tr><td>${esc(d.verdict)}</td><td>${esc(titleOf.get(d.candidateId) ?? d.candidateId)}</td><td>${d.score.toFixed(1)}</td><td><code>${esc(d.route)}</code></td><td class="muted">${esc(d.reasons.slice(-1).join(''))}</td></tr>`,
  )
  .join('\n')}
</tbody></table>`;
}

function renderVerifications(
  verifications: readonly Verification[],
  candidates: readonly Candidate[],
): string {
  if (verifications.length === 0) return '';
  const titleOf = new Map(candidates.map((c) => [c.id, c.title]));

  return `<h2>执行与验证</h2>
${verifications
  .map((v) => {
    const gain = Object.entries(v.gain)
      .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
      .map(([name, value]) => `${name} ${value > 0 ? '+' : ''}${value}`)
      .join('、');

    return `<details${v.status === 'rolled_back' ? ' open' : ''}>
<summary><b>${esc(titleOf.get(v.candidateId) ?? v.candidateId)}</b> — ${esc(v.status)}${gain === '' ? '' : `（实际收益 ${esc(gain)}）`}</summary>
<ul>
<li>检查：${esc(v.checks.map((c) => `${c.kind}${c.skipped ? '(跳过)' : c.passed ? '✓' : '✗'}`).join(' · '))}</li>
${v.gate.failedRules.length === 0 ? '' : `<li style="color:${RATING_COLOR.poor}">未通过原因：${esc(v.gate.failedRules.join('；'))}</li>`}
</ul>
</details>`;
  })
  .join('\n')}`;
}

function renderWarnings(run: RunRecord): string {
  if (run.warnings.length === 0) return '';

  return `<h2>采集告警</h2>
<table><thead><tr><th>级别</th><th>适配器</th><th>代码</th><th>说明</th></tr></thead><tbody>
${run.warnings
  .map(
    (w) =>
      `<tr><td style="color:${w.severity === 'degraded' ? RATING_COLOR['needs-improvement'] : 'inherit'}">${esc(w.severity)}</td><td><code>${esc(w.adapter ?? '—')}</code></td><td><code>${esc(w.code)}</code></td><td>${esc(w.message)}</td></tr>`,
  )
  .join('\n')}
</tbody></table>`;
}

function renderStages(run: RunRecord): string {
  if (run.stages.length === 0) return '';

  return `<h2>流水线阶段</h2>
<table><thead><tr><th>阶段</th><th>状态</th><th>耗时</th><th>备注</th></tr></thead><tbody>
${run.stages
  .map(
    (s) =>
      `<tr><td>${esc(s.name)}</td><td>${esc(s.status)}</td><td>${formatDuration(s.durationMs)}</td><td class="muted">${esc(s.note ?? '—')}</td></tr>`,
  )
  .join('\n')}
</tbody></table>`;
}

export function createHtmlReporter(): ReporterPort {
  return {
    format: 'html',
    render: ({ run, diagnosis, candidates, decisions, executions, verifications }) => ({
      format: 'html',
      filename: 'report.html',
      content: renderHtml({
        run,
        diagnosis,
        candidates: candidates ?? [],
        decisions: decisions ?? [],
        executions: executions ?? [],
        verifications: verifications ?? [],
      }),
    }),
  };
}
