import { useEffect, useState, type ReactNode } from 'react';
import type { RunSummary } from '@yuki-byte18/shared';
import { createReportApi, ApiError, type ReportApi, type RunDetail } from './api.js';

/**
 * 数据加载与三态（M8 验收 5）。
 *
 * ## 三态不是为了"好看"，是为了不骗人
 *
 * 一个只处理成功分支的页面，在加载中会显示"没有数据"，在请求失败时也会显示
 * "没有数据" —— 于是用户把**网络问题读成"这个项目没问题"**。
 * 这个工具的全部价值就在于"别把不知道当成没问题"（这条原则从 M1 的采集层
 * 一路贯穿到这里），报告页当然不能例外。
 *
 * 因此 `status` 是显式的判别联合：`loading` / `error` / `empty` / `ready`
 * 四种状态各有各的渲染，不存在"默认显示空"这种兜底。
 */

export type LoadState<T> =
  | { status: 'loading' }
  | { status: 'error'; message: string; notFound: boolean }
  | { status: 'empty'; message: string }
  | { status: 'ready'; data: T };

export interface RunDataOptions {
  api?: ReportApi;
  /** 指定 runId；不传则取最近一次 */
  runId?: string | null;
}

export function useRunData(options: RunDataOptions = {}): {
  state: LoadState<RunDetail>;
  api: ReportApi;
  reload: () => void;
} {
  const api = options.api ?? defaultApi();
  const [state, setState] = useState<LoadState<RunDetail>>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;

    const load = async (): Promise<void> => {
      setState({ status: 'loading' });
      try {
        const runId = options.runId ?? (await pickLatestRun(api));
        if (runId === null) {
          if (!cancelled) {
            setState({ status: 'empty', message: '还没有任何运行记录。先跑一次 `perfpilot run`。' });
          }
          return;
        }

        const detail = await api.loadRun(runId);
        if (!cancelled) setState({ status: 'ready', data: detail });
      } catch (err) {
        if (cancelled) return;
        // 404 与"服务挂了"必须分开：前者是"没有这条记录"，后者是"稍后重试"
        const error = err instanceof ApiError ? err : null;
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
          notFound: error?.notFound ?? false,
        });
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
    // nonce 用于"重试"按钮：同一个 runId 也要能重新拉一次
  }, [api, options.runId, nonce]);

  return { state, api, reload: () => setNonce((n) => n + 1) };
}

async function pickLatestRun(api: ReportApi): Promise<string | null> {
  const runs: RunSummary[] = await api.listRuns();
  if (runs.length === 0) return null;
  // 服务端已按时间倒序返回，这里再兜一次底：依赖顺序不如自己排一遍可靠
  const sorted = [...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return sorted[0]?.id ?? null;
}

let cachedApi: ReportApi | null = null;
function defaultApi(): ReportApi {
  cachedApi ??= createReportApi();
  return cachedApi;
}

/** 三态的统一渲染：调用方只关心"数据好了之后画什么" */
export function AsyncView<T>(props: {
  state: LoadState<T>;
  onRetry?: () => void;
  emptyHint?: string;
  children: (data: T) => ReactNode;
}): ReactNode {
  const { state } = props;

  if (state.status === 'loading') {
    // 骨架而不是转圈：报告页的布局是固定的，骨架能让加载看起来不"跳"
    return (
      <div className="state" role="status" aria-live="polite">
        <div className="skeleton skeleton-title" />
        <div className="skeleton skeleton-row" />
        <div className="skeleton skeleton-row" />
        <p className="state-text">正在加载运行记录…</p>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="state state-error" role="alert">
        <p className="state-title">{state.notFound ? '找不到这条运行记录' : '加载失败'}</p>
        <p className="state-text">{state.message}</p>
        {state.notFound ? null : (
          <p className="state-text">
            报告服务可能没在运行。用 <code>perfpilot serve</code> 启动它。
          </p>
        )}
        {props.onRetry === undefined ? null : (
          <button type="button" className="button" onClick={props.onRetry}>
            重试
          </button>
        )}
      </div>
    );
  }

  if (state.status === 'empty') {
    return (
      <div className="state" role="status">
        <p className="state-title">没有数据</p>
        <p className="state-text">{state.message}</p>
        {props.emptyHint === undefined ? null : <p className="state-text">{props.emptyHint}</p>}
      </div>
    );
  }

  return props.children(state.data);
}
