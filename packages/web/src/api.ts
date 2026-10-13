import type {
  Candidate,
  Decision,
  Diagnosis,
  ExecutionResult,
  MetricSeries,
  RunRecord,
  RunSummary,
  Verification,
} from '@yuki-byte18/shared';

/**
 * 报告 API 客户端。
 *
 * `web` 对 `@yuki-byte18/shared` 只有 **type-only** 依赖（硬约束 3、M8 验收 2）：
 * 一个值导入（哪怕只是一个常量）都会让报告页的构建产物体积跟着后端类型走，
 * 而且会让"前端能不能独立部署"这个问题重新出现。ESLint 的
 * `no-restricted-imports` + `allowTypeImports` 会在构建期拦住它。
 */

/** `GET /api/runs/:id` 的响应形状 */
export interface RunDetail {
  run: RunRecord;
  diagnosis: Diagnosis | null;
  candidates: Candidate[];
  decisions: Decision[];
  executions: ExecutionResult[];
  verifications: Verification[];
}

export interface ApiOptions {
  /** API 根地址；默认同源（由 `perfpilot serve` 托管时就是这样） */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * 请求失败的统一形状。
 *
 * 区分 `notFound` 与其它错误：**"这一轮 run 不存在"和"服务挂了"是两件不同的事**，
 * 前者该显示"没有这条记录"，后者该显示"重试"。合并成一个"出错了"，
 * 用户就没法判断该不该刷新。
 */
export class ApiError extends Error {
  readonly status: number;
  readonly notFound: boolean;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.notFound = status === 404;
  }
}

export interface ReportApi {
  listRuns: () => Promise<RunSummary[]>;
  loadRun: (runId: string) => Promise<RunDetail>;
  /**
   * 跨 run 的指标序列。
   *
   * 由服务端算好（`core/trends`）—— 前端只能 type-only 引用 shared，
   * 拿不到那套实现；而「来源变了就不给变化量」属于测量正确性，
   * 不该在这里再实现一遍。
   *
   * `route` / `device` 用来把历史限定在**同一个页面**上：一个 run 记录是
   * 「一个路由在一个设备上」的一次运行，不过滤就会把三个路由的数据
   * 混进同一张折线图里，那条线反映的是路由差异而不是时间变化。
   */
  loadSeries: (options?: { limit?: number; route?: string; device?: string }) => Promise<
    MetricSeries[]
  >;
  reportUrl: (runId: string) => string;
}

export function createReportApi(options: ApiOptions = {}): ReportApi {
  const base = (options.baseUrl ?? '').replace(/\/+$/, '');
  const doFetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  const get = async <T>(path: string): Promise<T> => {
    const response = await doFetch(`${base}${path}`, {
      headers: { accept: 'application/json' },
    });

    if (!response.ok) {
      throw new ApiError(`请求 ${path} 失败（HTTP ${response.status}）`, response.status);
    }

    return (await response.json()) as T;
  };

  return {
    listRuns: async () => {
      const body = await get<{ runs: RunSummary[] }>('/api/runs');
      return body.runs;
    },
    loadRun: (runId) => get<RunDetail>(`/api/runs/${encodeURIComponent(runId)}`),
    loadSeries: async (opts = {}) => {
      // 参数顺序固定，不依赖对象键的插入顺序 —— 测试会断言整个查询串
      const query = new URLSearchParams();
      if (opts.limit !== undefined) query.set('limit', String(opts.limit));
      if (opts.route !== undefined) query.set('route', opts.route);
      if (opts.device !== undefined) query.set('device', opts.device);

      const suffix = query.toString();
      const body = await get<{ series: MetricSeries[] }>(
        `/api/metrics${suffix === '' ? '' : `?${suffix}`}`,
      );
      return body.series;
    },
    reportUrl: (runId) => `${base}/api/runs/${encodeURIComponent(runId)}/report`,
  };
}
