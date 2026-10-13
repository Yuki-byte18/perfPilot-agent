import type { Bottleneck, MetricName } from '@yuki-byte18/shared';
import {
  Badge,
  Card,
  ChangeBadge,
  RatingBadge,
  ScoreBar,
  Sparkline,
  Stat,
  toneOfScore,
} from './components.js';
import {
  STATUS_LABEL,
  buildCollection,
  buildHeadline,
  buildMetricRows,
  buildOverview,
  buildStages,
  buildTimeline,
  describeAttribution,
  describeImpact,
  formatMetric,
  formatMetricValue,
  formatNumber,
  type CollectionView,
  type StageView,
  type Tone,
  type TrendView,
} from './data.js';
import type { RunDetail } from './api.js';

/**
 * 报告页的五个区块。
 *
 * 每个区块只回答一个问题，并且**先把结论写在最上面**：
 *
 * - 总览：这一轮到底怎么样，我需不需要做点什么
 * - 指标：具体是哪些数字、比上次好还是差
 * - 诊断：为什么会这样（瓶颈与归因）
 * - 优化：工具做了什么 / 建议做什么（候选 → 决策 → 执行 → 验证）
 * - 趋势：把视角拉到跨 run，看的是方向而不是某一轮
 *
 * 组件全部是纯渲染：数字由 `data.ts` 的纯函数算好。
 */

// ─────────────────────────────────────────────────────────────────────
// 总览
// ─────────────────────────────────────────────────────────────────────

export function OverviewView({ detail }: { detail: RunDetail }): JSX.Element {
  const headline = buildHeadline(detail);
  const overview = buildOverview(detail);
  const collection = buildCollection(detail);
  const stages = buildStages(detail.run);

  return (
    <>
      <section className={`headline headline-${headline.tone}`}>
        <p className="headline-text">{headline.text}</p>
        <ul className="headline-facts">
          {headline.facts.map((fact) => (
            <li key={fact}>{fact}</li>
          ))}
        </ul>
      </section>

      <div className="overview">
        <Stat label="采集指标" value={overview.metricCount} hint="这一轮实际拿到的指标条数" />
        <Stat
          label="可比指标"
          value={overview.comparableCount}
          hint="既有本次值、又有基线值的指标数量；其余只显示当前值"
        />
        <Stat
          label="改善"
          value={overview.improvedCount}
          tone={overview.improvedCount > 0 ? 'good' : 'neutral'}
          hint="分数比基线高的指标数"
        />
        <Stat
          label="回归"
          value={overview.regressionCount}
          tone={overview.regressionCount > 0 ? 'bad' : 'good'}
          hint="分数比基线低的指标数 —— CI 门禁拦的就是这个"
        />
        <Stat label="瓶颈" value={overview.bottleneckCount} hint="诊断阶段归因出的问题数" />
        <Stat
          label="产出补丁"
          value={overview.patchCount}
          hint="执行阶段真的产出了 patch 或文件改动的候选数"
        />
        <Stat
          label="保留改动"
          value={overview.keptCount}
          tone={overview.keptCount > 0 ? 'good' : 'neutral'}
          hint="通过验证并被记入仓库历史的改动"
        />
        <Stat
          label="回滚改动"
          value={overview.rolledBackCount}
          tone={overview.rolledBackCount > 0 ? 'warn' : 'neutral'}
          hint="没通过验证、已被自动回滚的改动"
        />
        <Stat
          label="待人工确认"
          value={overview.needsConfirmation}
          tone={overview.needsConfirmation > 0 ? 'warn' : 'neutral'}
          hint="B 类候选：补丁已生成，等你决定要不要用"
        />
      </div>

      <Stages stages={stages} />
      <Sources collection={collection} />
      <Warnings detail={detail} />
    </>
  );
}

function Stages({ stages }: { stages: readonly StageView[] }): JSX.Element {
  if (stages.length === 0) {
    return (
      <Card title="流水线阶段">
        <p className="muted">这条 run 记录里没有阶段信息（可能是早期版本落盘的）。</p>
      </Card>
    );
  }

  return (
    <Card
      title="流水线阶段"
      subtitle="八段线性流水线。skipped 不等于「没问题」——它表示这一次根本没有做那一步。"
    >
      <ol className="stages">
        {stages.map((stage) => (
          <li key={stage.name} className={`stage stage-${stage.status}`}>
            <span className="stage-name">
              {stage.status === 'ok' ? '✅' : stage.status === 'skipped' ? '⏭️' : '❌'} {stage.label}
            </span>
            <span className="stage-time">{formatDuration(stage.durationMs)}</span>
            {stage.note === null ? null : <span className="stage-note">{stage.note}</span>}
          </li>
        ))}
      </ol>
    </Card>
  );
}

function Sources({ collection }: { collection: CollectionView }): JSX.Element {
  return (
    <Card
      title="数据来源"
      subtitle="这一轮的数据是谁给的、谁没给。指标条数多不等于测得全 —— 来源缺失时对应指标会整块缺席。"
      right={
        <span className="muted small">
          {collection.okSources} 可用 · {collection.unavailableSources} 不可用
          {collection.failedSources > 0 ? ` · ${collection.failedSources} 失败` : ''}
        </span>
      }
    >
      {collection.sources.length === 0 ? (
        <p className="muted">没有记录到任何数据来源。</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>来源</th>
              <th>状态</th>
              <th className="num">指标</th>
              <th className="num">原始产物</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            {collection.sources.map((source) => (
              <tr key={source.adapter}>
                <td className="mono">{source.adapter}</td>
                <td>
                  <Badge tone={SOURCE_TONE[source.state] ?? 'neutral'}>
                    {SOURCE_LABEL[source.state] ?? source.state}
                  </Badge>
                </td>
                <td className="num">{source.metricCount}</td>
                <td className="num">{source.artifacts}</td>
                <td className="muted small">{source.message ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  ok: '已采集',
  unavailable: '不可用',
  failed: '失败',
  idle: '未参与',
};

const SOURCE_TONE: Record<string, Tone> = {
  ok: 'good',
  unavailable: 'warn',
  failed: 'bad',
  idle: 'neutral',
};

function Warnings({ detail }: { detail: RunDetail }): JSX.Element | null {
  const warnings = detail.run.warnings;
  if (warnings.length === 0) return null;

  return (
    <Card
      title="采集告警"
      subtitle="degraded 表示这次的结果不完整（有数据没测到）；info 只是提示。"
    >
      <ul className="warnings">
        {warnings.map((warning) => (
          <li
            key={`${warning.adapter ?? 'core'}-${warning.code}-${warning.message}`}
            className={warning.severity === 'degraded' ? 'warn' : ''}
          >
            <Badge tone={warning.severity === 'degraded' ? 'warn' : 'neutral'}>
              {warning.severity}
            </Badge>{' '}
            {warning.adapter === null ? null : (
              <span className="mono small">{warning.adapter} · </span>
            )}
            <code>{warning.code}</code> {warning.message}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} 分 ${Math.round((ms % 60_000) / 1000)} 秒`;
}

// ─────────────────────────────────────────────────────────────────────
// 指标对比
// ─────────────────────────────────────────────────────────────────────

export function MetricsView({ detail }: { detail: RunDetail }): JSX.Element {
  const rows = buildMetricRows(detail.run);
  const baselineRunId = detail.run.baseline?.runId ?? null;

  if (rows.length === 0) {
    return (
      <Card title="指标对比">
        <p className="muted">
          这一轮一条指标都没采到。<strong>这不代表页面没问题</strong> —— 它只代表这次没测到。
        </p>
      </Card>
    );
  }

  return (
    <Card
      title="指标对比"
      subtitle={
        baselineRunId === null
          ? '这是首次运行：没有基线，因此只有当前值。下一次运行才会出现「变好了还是变差了」。'
          : `基线是本项目上一次运行（${baselineRunId}）。箭头按「变好 / 变差」画，不是按数值方向 —— 分数已经把方向编码进去了。`
      }
    >
      <table className="table metrics">
        <thead>
          <tr>
            <th>指标</th>
            <th className="num">当前</th>
            <th className="num">基线</th>
            <th>变化</th>
            <th className="score-col">分数</th>
            <th>评级</th>
            <th>来源</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.name} className={`row-${row.change}`}>
              <td>
                <span className="metric-name">{row.name}</span>
                {row.hint === null ? null : <span className="metric-hint">{row.hint}</span>}
              </td>
              <td className="num mono">{formatMetric(row.current, row.unit)}</td>
              <td className="num mono muted">{formatMetric(row.baseline, row.unit)}</td>
              <td>
                <ChangeBadge
                  change={row.change}
                  delta={row.delta}
                  unit={row.unit}
                  deltaPercent={row.deltaPercent}
                />
              </td>
              <td className="score-col">
                <ScoreBar score={row.score} />
                {row.scoreDelta === null || row.scoreDelta === 0 ? null : (
                  <span className={`score-delta delta-${row.scoreDelta > 0 ? 'good' : 'bad'}`}>
                    {row.scoreDelta > 0 ? '+' : ''}
                    {row.scoreDelta.toFixed(1)}
                  </span>
                )}
              </td>
              <td>
                <RatingBadge rating={row.rating} />
              </td>
              <td className="mono small muted">{row.source ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small legend">
        分数是 0–100 的归一化刻度（阈值由 <code>baseline.metrics</code> 配置）：90 以上绿色、50
        以下红色。原始值仍按原单位显示 —— 两者回答的是不同问题：前者是「离标准多远」，
        后者是「到底是多少」。
      </p>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────────
// 诊断
// ─────────────────────────────────────────────────────────────────────

export function DiagnosisView({ detail }: { detail: RunDetail }): JSX.Element {
  const diagnosis = detail.diagnosis;

  if (diagnosis === null) {
    return (
      <Card title="诊断">
        <p className="muted">
          这一轮没有诊断记录。常见原因：只跑了采集（裁剪掉了诊断阶段），或者这条记录来自更早的版本。
        </p>
      </Card>
    );
  }

  if (diagnosis.bottlenecks.length === 0) {
    return (
      <Card
        title="诊断"
        subtitle={`规则集 ${diagnosis.ruleSetVersion} · ${diagnosis.metrics.length} 项指标参与`}
      >
        <p className="muted">
          没有命中任何诊断规则。<strong>这不等于页面没问题</strong> ——
          先确认上面的数据来源是否齐全：没测到的指标不会产生瓶颈。
        </p>
      </Card>
    );
  }

  return (
    <Card
      title="诊断"
      subtitle={diagnosis.summary}
      right={
        <span className="muted small">
          规则集 {diagnosis.ruleSetVersion} · {diagnosis.bottlenecks.length} 个瓶颈
        </span>
      }
    >
      <div className="bottlenecks">
        {diagnosis.bottlenecks.map((bottleneck) => (
          <BottleneckCard key={bottleneck.id} bottleneck={bottleneck} detail={detail} />
        ))}
      </div>
    </Card>
  );
}

function BottleneckCard({
  bottleneck,
  detail,
}: {
  bottleneck: Bottleneck;
  detail: RunDetail;
}): JSX.Element {
  /**
   * 关联候选：**一个瓶颈可能没有任何候选**（规则库没有对应修法），
   * 这恰恰是最需要说清楚的情况 —— 否则读者会把"没显示"读成"没问题"。
   */
  const related = detail.candidates.filter((c) => c.bottleneckIds.includes(bottleneck.id));
  const verdictOf = new Map(detail.decisions.map((d) => [d.candidateId, d.verdict]));

  return (
    <article className="bottleneck">
      <header className="bn-head">
        <span className={`severity severity-${toneOfScore(100 - bottleneck.severity)}`}>
          {bottleneck.severity}
        </span>
        <div>
          <h3>{bottleneck.title}</h3>
          <p className="muted small">
            <code>{bottleneck.kind}</code> · 置信度 {(bottleneck.confidence * 100).toFixed(0)}% ·
            出现 {bottleneck.occurrences} 次 ·{' '}
            {/* 来源必须标出来：LLM 的结论与规则结论可信度不同，混在一起就是骗人 */}
            <Badge tone={bottleneck.source === 'llm' ? 'warn' : 'neutral'}>
              {bottleneck.source === 'llm' ? '🤖 诊断 agent' : '确定性规则'}
            </Badge>
          </p>
        </div>
      </header>

      <dl className="bn-meta">
        <div>
          <dt>归因</dt>
          <dd className="mono">{describeAttribution(bottleneck.attribution)}</dd>
        </div>
        <div>
          <dt>影响量</dt>
          <dd>
            {describeImpact(bottleneck.impact).map((item) => (
              <Badge key={item.name} tone="warn">
                {item.name} {item.text}
              </Badge>
            ))}
            {describeImpact(bottleneck.impact).length === 0 ? <span className="muted">—</span> : null}
          </dd>
        </div>
      </dl>

      {related.length === 0 ? (
        <p className="bn-empty">
          规则库对这个瓶颈<strong>没有给出修法</strong>。这意味着「没有建议」，
          而不是「不需要处理」。
        </p>
      ) : (
        <ul className="bn-candidates">
          {related.map((candidate) => {
            const verdict = verdictOf.get(candidate.id) ?? null;
            return (
              <li key={candidate.id}>
                <Badge
                  tone={candidate.class === 'A' ? 'good' : candidate.class === 'B' ? 'warn' : 'neutral'}
                >
                  {candidate.class} 类
                </Badge>{' '}
                {verdict === null ? null : <Badge>{verdict}</Badge>}{' '}
                <strong>{candidate.title}</strong>
                <div className="muted small">{candidate.description}</div>
              </li>
            );
          })}
        </ul>
      )}

      {bottleneck.evidence.length === 0 ? null : (
        <details className="bn-evidence">
          <summary>证据（{bottleneck.evidence.length} 条）</summary>
          <ul>
            {bottleneck.evidence.map((item, index) => (
              <li key={`${item.kind}-${index}`}>
                <code>{item.kind}</code> {item.description}
                <pre className="payload">{JSON.stringify(item.payload, null, 2)}</pre>
              </li>
            ))}
          </ul>
        </details>
      )}
    </article>
  );
}

// ─────────────────────────────────────────────────────────────────────
// 优化（候选 → 决策 → 执行 → 验证）
// ─────────────────────────────────────────────────────────────────────

export function OptimizationView({ detail }: { detail: RunDetail }): JSX.Element {
  const entries = buildTimeline(detail);

  if (entries.length === 0) {
    return (
      <Card title="优化" subtitle="候选方案 → 决策 → 执行 → 验证。">
        <p className="muted">
          这一轮没有产出候选方案。可能是没发现瓶颈，也可能是发现的瓶颈没有已知修法 ——
          两种情况都会在「诊断」里说清楚。
        </p>
      </Card>
    );
  }

  const withPatch = entries.filter((e) => e.patch !== '').length;
  const kept = entries.filter((e) => e.status === 'kept').length;

  return (
    <Card
      title="优化"
      subtitle="以候选为主体：一个候选可能走到决策就停了（未执行），也可能生成了补丁等待人工确认。"
      right={
        <span className="muted small">
          {entries.length} 个候选 · {withPatch} 份补丁 · {kept} 个已保留
        </span>
      }
    >
      <ol className="timeline">
        {entries.map((entry) => (
          <li key={entry.candidateId} className={`tl-item tl-${entry.status}`}>
            <div className="tl-head">
              <Badge tone={entry.class === 'A' ? 'good' : entry.class === 'B' ? 'warn' : 'neutral'}>
                {entry.class} 类
              </Badge>
              <Badge tone={STATUS_TONE[entry.status] ?? 'neutral'}>{STATUS_LABEL[entry.status]}</Badge>
              <strong className="tl-title">{entry.title}</strong>
            </div>
            <p className="tl-desc muted small">{entry.description}</p>
            <div className="tl-note">{entry.note}</div>
            {entry.executionSummary === null ? null : (
              <p className="tl-exec muted small">执行：{entry.executionSummary}</p>
            )}

            <div className="tl-meta">
              {entry.route === null ? null : <span className="muted small">路由 {entry.route}</span>}
              {entry.score === null ? null : (
                <span className="muted small">utility {entry.score.toFixed(1)}</span>
              )}
              <span className="muted small">
                置信度 {(entry.confidence * 100).toFixed(0)}% · 风险 {entry.risk} · 投入 {entry.effort}
              </span>
              {Object.keys(entry.expectedGain).length === 0 ? null : (
                <span className="muted small">预期收益 {describeGains(entry.expectedGain)}</span>
              )}
              {Object.keys(entry.gain).length === 0 ? null : (
                <span className="delta-good small">实际收益 {describeGains(entry.gain)}</span>
              )}
            </div>

            {entry.failedRules.length === 0 ? null : (
              <ul className="tl-failures">
                {entry.failedRules.map((rule) => (
                  <li key={rule}>{rule}</li>
                ))}
              </ul>
            )}

            <details className="tl-detail">
              <summary>决策理由与改动细节</summary>

              {entry.reasons.length === 0 ? null : (
                <>
                  <h4>为什么这么判</h4>
                  <ul className="tight">
                    {entry.reasons.map((reason) => (
                      <li key={reason}>{reason}</li>
                    ))}
                  </ul>
                </>
              )}

              <h4>要改什么</h4>
              <ul className="tight mono small">
                {entry.changes.map((change, index) => (
                  <li key={index}>{describeChange(change)}</li>
                ))}
              </ul>

              {entry.patch === '' ? (
                <p className="muted small">这一轮没有产出补丁。</p>
              ) : (
                <>
                  <h4>补丁（{entry.files.join('、') || '未标注文件'}）</h4>
                  <pre className="patch">{entry.patch}</pre>
                </>
              )}

              {entry.checks.length === 0 ? null : (
                <>
                  <h4>验证跑过的检查</h4>
                  <table className="table small">
                    <thead>
                      <tr>
                        <th>检查</th>
                        <th>结果</th>
                        <th className="num">耗时</th>
                        <th>输出</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entry.checks.map((check) => (
                        <tr key={check.kind}>
                          <td className="mono">{check.kind}</td>
                          <td>
                            <Badge tone={check.skipped ? 'neutral' : check.passed ? 'good' : 'bad'}>
                              {check.skipped ? '跳过' : check.passed ? '通过' : '未通过'}
                            </Badge>
                          </td>
                          <td className="num">{formatDuration(check.durationMs)}</td>
                          <td className="muted small">
                            {check.output === null ? '—' : check.output.split('\n')[0]}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </details>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function describeGains(gains: Record<string, number>): string {
  return Object.entries(gains)
    .map(([name, value]) => `${name} ${formatMetricValue(name as MetricName, Math.abs(value))}`)
    .join('、');
}

const STATUS_TONE: Record<string, Tone> = {
  kept: 'good',
  rolled_back: 'bad',
  failed: 'bad',
  pending: 'warn',
  suggested: 'neutral',
  rejected: 'neutral',
};

/** 把一条 PlannedChange 描述成「要改哪个文件的什么」 */
function describeChange(change: {
  type: string;
  file?: string | undefined;
  key?: string | undefined;
  node?: string | undefined;
}): string {
  switch (change.type) {
    case 'config':
      return `改配置 ${change.file ?? '?'} → ${change.key ?? '?'}`;
    case 'ast':
      return `改写代码 ${change.file ?? '?'}（${change.node ?? '?'}）`;
    case 'asset':
      return `处理资源 ${change.file ?? '?'}`;
    case 'dependency':
      return '调整依赖（package.json）';
    default:
      return change.type;
  }
}

// ─────────────────────────────────────────────────────────────────────
// 趋势
// ─────────────────────────────────────────────────────────────────────

export function TrendsView({
  trends,
  error,
}: {
  trends: readonly TrendView[];
  error: string | null;
}): JSX.Element {
  if (error !== null) {
    return (
      <Card title="跨 run 趋势">
        <p className="muted">历史数据加载失败：{error}</p>
        <p className="muted small">趋势是锦上添花的一块，拿不到也不影响上面几块的结论。</p>
      </Card>
    );
  }

  if (trends.length === 0) {
    return (
      <Card title="跨 run 趋势">
        <p className="muted">还没有足够的历史。多跑几轮之后，这里会显示每个指标随时间的变化。</p>
      </Card>
    );
  }

  return (
    <Card
      title="跨 run 趋势"
      subtitle="左旧右新。同一指标的测量来源变化时不计算变化量 —— 换了尺子就不该比长度。"
    >
      <div className="trends">
        {trends.map((trend) => (
          <div key={trend.name} className="trend">
            <div className="trend-head">
              <span className="trend-name">{trend.name}</span>
              {trend.latest === null ? null : (
                <span className="trend-value mono">{formatMetric(trend.latest, trend.unit)}</span>
              )}
              {trend.change === null ? (
                <span className="muted small">
                  {trend.sourceChanged ? '来源变化，不可比' : '只有一个数据点'}
                </span>
              ) : (
                <span className={trend.improved === true ? 'delta-good small' : 'delta-bad small'}>
                  {trend.change > 0 ? '+' : '−'}
                  {formatMetric(Math.abs(trend.change), trend.unit)}
                  {trend.changePercent === null ? '' : `（${formatNumber(trend.changePercent)}%）`}
                  {trend.improved === null ? '' : trend.improved ? ' 改善' : ' 劣化'}
                </span>
              )}
            </div>
            {trend.hint === null ? null : <p className="muted small trend-hint">{trend.hint}</p>}
            <Sparkline view={trend} />
            <div className="trend-scale muted small">
              <span>最低 {formatMetric(trend.min, trend.unit)}</span>
              <span>{trend.points.length} 个数据点</span>
              <span>最高 {formatMetric(trend.max, trend.unit)}</span>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
