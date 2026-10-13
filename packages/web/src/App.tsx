import { useEffect, useMemo, useState } from 'react';
import type { RunSummary } from '@yuki-byte18/shared';
import { createReportApi, type ReportApi, type RunDetail } from './api.js';
import { Badge } from './components.js';
import {
  RUN_STATUS_LABEL,
  buildOverview,
  describeRun,
  groupRuns,
  toTrendViews,
  type Tone,
  type TrendView,
} from './data.js';
import { AsyncView, useRunData, type LoadState } from './useRunData.js';
import { DiagnosisView, MetricsView, OptimizationView, OverviewView, TrendsView } from './views.js';

/**
 * 报告页。
 *
 * ## 它要回答的四个问题
 *
 * 1. 这一轮跑成什么样了，比上一次好还是差
 * 2. 具体是哪些数字，差在哪儿
 * 3. 为什么（诊断与归因）
 * 4. 工具做了什么 / 建议我做什么（候选 → 决策 → 执行 → 验证）
 *
 * 页面结构就是这四个问题的顺序：顶部一句话结论，下面按标签页展开证据。
 *
 * ## 状态管理
 *
 * 没有路由库、没有全局 store：一个 `runId` + 一个 `tab`，其余全是纯函数算出来的。
 * 两个数据源（run 详情、跨 run 趋势）各自独立加载、各自有三态 ——
 * 趋势挂了不该让整页变成错误态（它是锦上添花的那一块）。
 *
 * 标签页用 `location.hash` 记录，因此**链接可以分享**：把 URL 发给同事，
 * 对方打开的就是同一轮 run 的同一块内容。读 hash 只在 effect 里做，
 * 服务端渲染时不会碰到 `window`。
 */

const TABS = [
  { id: 'overview', label: '总览' },
  { id: 'metrics', label: '指标' },
  { id: 'diagnosis', label: '诊断' },
  { id: 'optimization', label: '优化' },
  { id: 'trends', label: '趋势' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export function App(props: { api?: ReportApi; runId?: string | null }): JSX.Element {
  const api = useMemo(() => props.api ?? createReportApi(), [props.api]);

  const [runId, setRunId] = useState<string | null>(props.runId ?? null);
  const [tab, setTab] = useState<TabId>('overview');

  const { state, reload } = useRunData({
    api,
    ...(runId === null ? {} : { runId }),
  });
  const runs = useRunList(api);
  const series = useSeries(api, state);

  useHashTab(setTab);

  return (
    <main className="page">
      <header className="page-head">
        <div className="brand">
          <h1>PerfPilot 报告</h1>
          <AsyncView state={state} onRetry={reload}>
            {(detail) => <RunIdentifier detail={detail} />}
          </AsyncView>
        </div>

        <AsyncView state={state} onRetry={reload}>
          {(detail) => <RunPicker runs={runs} current={detail.run.id} onPick={setRunId} />}
        </AsyncView>
      </header>

      <AsyncView
        state={state}
        onRetry={reload}
        emptyHint="报告页只读取已经落盘的运行记录，它自己不会触发采集。先跑一次 `perfpilot run`。"
      >
        {(detail) => (
          <>
            <nav className="tabs" aria-label="报告区块">
              {TABS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`tab ${tab === item.id ? 'tab-active' : ''}`}
                  aria-current={tab === item.id ? 'page' : undefined}
                  onClick={() => {
                    setTab(item.id);
                    // 让链接可分享：刷新或发给别人时停在同一个区块
                    if (typeof window !== 'undefined') window.location.hash = item.id;
                  }}
                >
                  {item.label}
                  {tabBadge(item.id, detail) === null ? null : (
                    <span className="tab-count">{tabBadge(item.id, detail)}</span>
                  )}
                </button>
              ))}
            </nav>

            <div className="content">
              {tab === 'overview' ? <OverviewView detail={detail} /> : null}
              {tab === 'metrics' ? <MetricsView detail={detail} /> : null}
              {tab === 'diagnosis' ? <DiagnosisView detail={detail} /> : null}
              {tab === 'optimization' ? <OptimizationView detail={detail} /> : null}
              {tab === 'trends' ? (
                <TrendsView trends={readyTrends(series)} error={series.status === 'error' ? series.message : null} />
              ) : null}
            </div>

            <Footer detail={detail} api={api} />
          </>
        )}
      </AsyncView>
    </main>
  );
}

/** 标签页上的计数：让用户不必点进去就知道有没有东西看 */
function tabBadge(tab: TabId, detail: RunDetail): number | null {
  switch (tab) {
    case 'metrics':
      return detail.run.metrics.length === 0 ? null : detail.run.metrics.length;
    case 'diagnosis':
      return detail.diagnosis === null || detail.diagnosis.bottlenecks.length === 0
        ? null
        : detail.diagnosis.bottlenecks.length;
    case 'optimization':
      return detail.candidates.length === 0 ? null : detail.candidates.length;
    default:
      return null;
  }
}

function RunIdentifier({ detail }: { detail: RunDetail }): JSX.Element {
  const { run } = detail;
  const overview = buildOverview(detail);

  return (
    <p className="muted small run-id">
      项目 <strong>{run.project}</strong> · 路由 <code>{run.route}</code> · 设备{' '}
      <code>{run.device}</code> ·{' '}
      <Badge tone={STATUS_TONE[run.status]}>{RUN_STATUS_LABEL[run.status]}</Badge>{' '}
      {new Date(run.startedAt).toLocaleString('zh-CN')} · 耗时 {(run.durationMs / 1000).toFixed(1)}s ·{' '}
      {overview.metricCount} 项指标
      {/* 花了钱就得看得见；未接 LLM 时（0）不显示 */}
      {run.llmCostUsd > 0 ? ` · LLM $${run.llmCostUsd.toFixed(4)}` : ''}
    </p>
  );
}

const STATUS_TONE: Record<RunDetail['run']['status'], Tone> = {
  success: 'good',
  partial: 'warn',
  failed: 'bad',
};

/**
 * 运行记录选择器。
 *
 * 按「路由 + 设备」分组，因为**"最近一次运行"本身就有歧义**：
 * 三个路由就有三个"最近一次"。不分组的话，用户只能看到一串时间戳，
 * 分不清自己点的是哪个页面。
 */
function RunPicker({
  runs,
  current,
  onPick,
}: {
  runs: LoadState<RunSummary[]>;
  current: string;
  onPick: (runId: string) => void;
}): JSX.Element | null {
  if (runs.status !== 'ready' || runs.data.length === 0) return null;

  const groups = groupRuns(runs.data);

  return (
    <label className="picker">
      <span className="muted small">切换运行记录</span>
      <select value={current} onChange={(event) => onPick(event.target.value)}>
        {groups.map((group) => (
          <optgroup key={group.key} label={`${group.route} · ${group.device}`}>
            {group.runs.map((run) => (
              <option key={run.id} value={run.id}>
                {describeRun(run)}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

function Footer({ detail, api }: { detail: RunDetail; api: ReportApi }): JSX.Element {
  return (
    <footer className="footer">
      <p className="muted small">
        这一页只读取已经落盘的记录，不会触发任何采集或改动。
      </p>
      <p className="muted small">
        run <code>{detail.run.id}</code> · PerfPilot v{detail.run.perfpilotVersion} ·{' '}
        <a href={api.reportUrl(detail.run.id)}>Markdown 报告</a> ·{' '}
        <a href={`/api/runs/${encodeURIComponent(detail.run.id)}`}>原始 JSON</a>
      </p>
    </footer>
  );
}

// ─────────────────────────────────────────────────────────────────────
// 数据加载：两个独立的三态
// ─────────────────────────────────────────────────────────────────────

/** run 列表。拿不到就只是没有选择器，不影响正文 */
function useRunList(api: ReportApi): LoadState<RunSummary[]> {
  const [state, setState] = useState<LoadState<RunSummary[]>>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const runs = await api.listRuns();
        if (!cancelled) setState({ status: 'ready', data: runs });
      } catch (err) {
        if (cancelled) return;
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
          notFound: false,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [api]);

  return state;
}

/**
 * 跨 run 趋势。
 *
 * 与 run 详情**分开加载**：趋势是锦上添花，拿不到也不该让整页变成错误态。
 * 它在 run 详情就绪之后才开始拉 —— 这样能带上 route/device 过滤，
 * 拿到的才是"同一个页面的历史"，而不是把三个路由的数据混在一张图里。
 */
function useSeries(api: ReportApi, detail: LoadState<RunDetail>): LoadState<TrendView[]> {
  const [state, setState] = useState<LoadState<TrendView[]>>({ status: 'loading' });
  const route = detail.status === 'ready' ? detail.data.run.route : null;
  const device = detail.status === 'ready' ? detail.data.run.device : null;

  useEffect(() => {
    if (route === null || device === null) return;
    let cancelled = false;

    void (async () => {
      try {
        const series = await api.loadSeries({ limit: 30, route, device });
        if (!cancelled) setState({ status: 'ready', data: toTrendViews(series) });
      } catch (err) {
        if (cancelled) return;
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
          notFound: false,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [api, route, device]);

  return state;
}

function readyTrends(state: LoadState<TrendView[]>): readonly TrendView[] {
  return state.status === 'ready' ? state.data : [];
}

/** 从 URL hash 读标签页（只在浏览器里跑，服务端渲染不会碰到 window） */
function useHashTab(setTab: (tab: TabId) => void): void {
  useEffect(() => {
    const apply = (): void => {
      const id = window.location.hash.replace(/^#/, '');
      if (TABS.some((tab) => tab.id === id)) setTab(id as TabId);
    };

    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, [setTab]);
}
