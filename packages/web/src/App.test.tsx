import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Metric } from '@yuki-byte18/shared';
import { App } from './App.js';
import { AsyncView, type LoadState } from './useRunData.js';
import { ApiError, createReportApi, type RunDetail } from './api.js';

/**
 * 三态渲染（M8 验收 5）。
 *
 * 用 `react-dom/server` 的 `renderToStaticMarkup` 而不是 jsdom +
 * testing-library：这一组要验的是「三种状态下渲染出来的东西不一样」，
 * 而那用字符串断言就够。少两个依赖（jsdom 的依赖树有几十个包），
 * 换来的差别只是不能测交互 —— 而这个页面几乎没有交互。
 *
 * 加载中那一态没法用同步渲染测（它由 effect 驱动），
 * 因此直接测 `AsyncView` 这个纯组件：状态是它的入参。
 */

const metric = (name: Metric['name'], value: number): Metric => ({
  name,
  value,
  unit: 'ms',
  rating: 'good',
  score: 100,
  route: '/',
  device: 'mobile',
  source: 'lighthouse',
  collectedAt: '2026-01-17T14:25:30.000Z',
});

function detail(): RunDetail {
  return {
    run: {
      schemaVersion: 1,
      id: 'run_20260117T142530_aaaaaa',
      project: 'demo-shop',
      route: '/',
      device: 'mobile',
      url: 'https://staging.example.com',
      status: 'success',
      startedAt: '2026-01-17T14:25:30.000Z',
      finishedAt: '2026-01-17T14:25:31.000Z',
      durationMs: 1000,
      perfpilotVersion: '0.1.0',
      stages: [],
      metrics: [metric('LCP', 2800)],
      baseline: null,
      deltas: [],
      warnings: [],
      artifacts: [],
      llmCostUsd: 0,
    },
    diagnosis: null,
    candidates: [],
    decisions: [],
    executions: [],
    verifications: [],
  };
}

/** 只回放一份预设结果的假 API */
const fakeApi = (behaviour: 'ok' | 'empty' | 'notFound' | 'boom') =>
  createReportApi({
    fetchImpl: (async (url: string) => {
      const path = String(url);

      if (behaviour === 'boom') throw new Error('网络不可达');

      if (path.includes('/api/metrics')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            series: [
              {
                name: 'LCP',
                points: [
                  {
                    runId: 'run_20260117T142530_aaaaaa',
                    startedAt: '2026-01-17T14:25:30.000Z',
                    value: 2800,
                    score: 90,
                    rating: 'needs-improvement',
                    source: 'lighthouse',
                  },
                ],
                change: null,
                changePercent: null,
                sourceChanged: false,
                enoughData: false,
              },
            ],
          }),
        };
      }

      if (path.endsWith('/api/runs')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            runs:
              behaviour === 'empty'
                ? []
                : [
                    {
                      id: 'run_20260117T142530_aaaaaa',
                      project: 'demo-shop',
                      route: '/',
                      device: 'mobile',
                      status: 'success',
                      startedAt: '2026-01-17T14:25:30.000Z',
                      metricCount: 1,
                    },
                  ],
          }),
        };
      }

      if (behaviour === 'notFound') {
        return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' };
      }

      return { ok: true, status: 200, json: async () => detail() };
    }) as unknown as typeof fetch,
  });

describe('M8 验收 5 — 三态处理', () => {
  it('加载中：显示骨架与说明，不显示"没有数据"', () => {
    const html = renderToStaticMarkup(
      <AsyncView state={{ status: 'loading' } satisfies LoadState<RunDetail>}>
        {() => <p>不该出现的内容</p>}
      </AsyncView>,
    );

    expect(html).toContain('skeleton');
    expect(html).toContain('正在加载');
    // 关键：加载中**不能**显示成"没有数据"——那会让人把"还没好"读成"没问题"
    expect(html).not.toContain('没有数据');
    expect(html).not.toContain('不该出现的内容');
  });

  it('空数据：说明"还没有运行记录"，并给出下一步', () => {
    const html = renderToStaticMarkup(
      <AsyncView
        state={{ status: 'empty', message: '还没有任何运行记录。' }}
        emptyHint="先跑一次 perfpilot run。"
      >
        {() => <p>不该出现的内容</p>}
      </AsyncView>,
    );

    expect(html).toContain('没有数据');
    expect(html).toContain('还没有任何运行记录');
    expect(html).toContain('先跑一次');
  });

  it('错误：显示失败与重试按钮，且不混进空数据文案', () => {
    const html = renderToStaticMarkup(
      <AsyncView
        state={{ status: 'error', message: '网络不可达', notFound: false }}
        onRetry={() => undefined}
      >
        {() => <p>不该出现的内容</p>}
      </AsyncView>,
    );

    expect(html).toContain('加载失败');
    expect(html).toContain('网络不可达');
    expect(html).toContain('重试');
    // 错误态不能说成"没有数据"：前者该重试，后者该去跑一次
    expect(html).not.toContain('没有数据');
  });

  it('404 与"服务挂了"文案不同（该重试 vs 该换一个 run）', () => {
    const html = renderToStaticMarkup(
      <AsyncView state={{ status: 'error', message: '请求失败（HTTP 404）', notFound: true }}>
        {() => null}
      </AsyncView>,
    );

    expect(html).toContain('找不到这条运行记录');
    expect(html).not.toContain('perfpilot serve');
  });

  it('就绪：渲染真正的报告内容', () => {
    const html = renderToStaticMarkup(
      <AsyncView state={{ status: 'ready', data: detail() }}>
        {(data) => <p>项目 {data.run.project}</p>}
      </AsyncView>,
    );

    expect(html).toContain('demo-shop');
    expect(html).not.toContain('正在加载');
  });
});

describe('M8 — App 组合与 API 客户端', () => {
  it('App 能渲染出来（首页骨架不依赖数据）', () => {
    const html = renderToStaticMarkup(<App api={fakeApi('ok')} />);

    expect(html).toContain('PerfPilot 报告');
    // 初始渲染必然是加载态：数据由 effect 拉，服务端渲染拿不到
    expect(html).toContain('正在加载');
  });

  it('API 客户端把 404 标成 notFound，其它状态码不是', async () => {
    const api = fakeApi('notFound');
    await expect(api.loadRun('run_x')).rejects.toBeInstanceOf(ApiError);
    await expect(api.loadRun('run_x')).rejects.toMatchObject({ notFound: true, status: 404 });
  });

  it('API 客户端把 runId 编码进路径（外部输入不能直接拼 URL）', () => {
    const api = createReportApi({ baseUrl: 'https://reports.example.com/' });
    expect(api.reportUrl('run_a/b')).toBe('https://reports.example.com/api/runs/run_a%2Fb/report');
  });

  it('loadSeries 走 /api/metrics 并带上 limit', async () => {
    const seen: string[] = [];
    const api = createReportApi({
      fetchImpl: (async (url: string) => {
        seen.push(String(url));
        return { ok: true, status: 200, json: async () => ({ series: [] }) };
      }) as unknown as typeof fetch,
    });

    await api.loadSeries({ limit: 5 });

    expect(seen[0]).toBe('/api/metrics?limit=5');
  });

  it('loadSeries 不传 limit 时不带查询串（用服务端默认值）', async () => {
    const seen: string[] = [];
    const api = createReportApi({
      fetchImpl: (async (url: string) => {
        seen.push(String(url));
        return { ok: true, status: 200, json: async () => ({ series: [] }) };
      }) as unknown as typeof fetch,
    });

    await api.loadSeries();

    expect(seen[0]).toBe('/api/metrics');
  });

  it('趋势数据能被消费（跨 run 的历史，不是本次一个点）', async () => {
    const series = await fakeApi('ok').loadSeries({ limit: 30 });

    expect(series).toHaveLength(1);
    expect(series[0]?.name).toBe('LCP');
    // 只有一个数据点时必须显式标记，页面据此说"只有一个数据点"而不是画假的持平线
    expect(series[0]?.enoughData).toBe(false);
  });
});
