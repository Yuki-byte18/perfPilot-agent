import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { timingSafeEqual } from 'node:crypto';
import { extname, join, resolve } from 'node:path';
import { createFileRunStore, buildMetricSeries, renderMarkdown, type FileRunStoreOptions } from '@yuki-byte18/core';
import { isSafeId, type Diagnosis, type RunSummary } from '@yuki-byte18/shared';

/** 查询参数是外部输入：夹到合理区间，避免一次请求把全部历史读进内存 */
function clampLimit(raw: string | null, fallback: number, max: number): number {
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

/**
 * 鉴权。
 *
 * 没配 token 就全放行（本地默认）。配了 token 则要求两种携带方式之一。
 *
 * 比较用 `timingSafeEqual` 而不是 `===`：字符串比较会在第一个不同的字符处
 * 提前返回，理论上可以按字节把 token 猜出来。对一个"可能暴露在网络上"的
 * 只读服务，这是顺手就能做对的事，没有理由不做。
 */
function authorized(req: IncomingMessage, url: URL, token: string | null): boolean {
  if (token === null || token === '') return true;

  const header = req.headers.authorization;
  const fromHeader = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
  const fromQuery = url.searchParams.get('token') ?? '';

  return constantTimeEquals(fromHeader, token) || constantTimeEquals(fromQuery, token);
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * 报告 API 服务（README §12、M7 验收 / M8 报告托管）。
 *
 * ## 为什么是 `node:http` 而不是 Fastify
 *
 * 这个服务是**只读的四个端点**：列 run、读 run、读报告、健康检查。
 * 一个 Web 框架能提供的路由树、插件、校验、序列化，在这里一个都用不上 ——
 * 而它的代价是真实的：多一棵依赖树、多一套升级节奏、多一种
 * "CI 里装不上"的失败模式（这个仓库的 npm 访问已经不稳过一次）。
 *
 * 端点少到可以用一个 switch 说清楚时，用框架是负收益。
 * 等出现"需要插件生态"的需求（鉴权、限流、OpenAPI）再换，换的也只是这个文件。
 *
 * ## 它刻意不做的事
 *
 * 不写任何东西、不触发任何采集、不执行任何改动。服务端的职责是**把已经落盘的
 * 事实读出来**；一旦它能触发运行，它就同时成了一个新的攻击面与一个新的
 * "为什么 CI 里跑了两遍"的来源。
 */

export interface ServerOptions extends FileRunStoreOptions {
  host?: string;
  port?: number;
  /**
   * 报告页构建产物目录（`packages/web/dist`）。
   *
   * 不传时只提供 API —— 静态托管是**可选**的：CI 里通常只要 API
   * （报告作为 artifact 上传），本地才需要页面。硬把两者绑在一起，
   * 会让"没构建前端"变成一个启动错误。
   */
  webDir?: string | null;
  /**
   * 访问令牌。设了之后所有请求都要带上它。
   *
   * 默认不设 —— 服务默认只监听 `127.0.0.1`，本地看报告不该再要一次密码。
   * 但一旦用 `--host 0.0.0.0` 暴露到网络上（团队共享、容器里跑），
   * 报告里含内部 URL、资源体积、源码位置，**没有鉴权就等于公开**。
   *
   * 接受两种携带方式：
   * - `Authorization: Bearer <token>`（脚本、CI 用）
   * - `?token=<token>`（浏览器直接用 —— 要打开页面就得有这条路，
   *   代价是 token 会进浏览器历史与代理日志，因此它是"暴露在网络上时"
   *   的权宜之计，不是推荐做法）
   */
  token?: string | null;
  logger?: { info: (msg: string, meta?: Record<string, unknown>) => void };
}

export interface ReportServer {
  /** 实际监听的端口（`port: 0` 时由系统分配，用于测试） */
  port: number;
  url: string;
  close: () => Promise<void>;
}

interface Route {
  method: 'GET';
  match: RegExp;
  /** `params` 是正则捕获组；`url` 供带查询参数的端点使用（如 `/api/metrics?limit=`） */
  handle: (params: string[], res: ServerResponse, url: URL) => Promise<void>;
}

export async function createReportServer(options: ServerOptions): Promise<ReportServer> {
  const store = createFileRunStore({ baseDir: options.baseDir });
  const host = options.host ?? '127.0.0.1';
  const webDir = options.webDir === undefined || options.webDir === null ? null : resolve(options.webDir);
  const token = options.token ?? null;

  const send = (res: ServerResponse, status: number, body: string, type: string): void => {
    res.writeHead(status, {
      'content-type': `${type}; charset=utf-8`,
      // 报告是给人看的，不是给 CDN 缓存的
      'cache-control': 'no-store',
    });
    res.end(body);
  };

  const json = (res: ServerResponse, status: number, payload: unknown): void => {
    send(res, status, `${JSON.stringify(payload, null, 2)}\n`, 'application/json');
  };

  const notFound = (res: ServerResponse, what: string): void => {
    json(res, 404, { error: 'not_found', message: `找不到 ${what}` });
  };

  /** 读 run 目录下的一个 JSON 文件；不存在返回 null（"没跑过那一段"是合法状态） */
  const readRunJson = async <T>(runId: string, filename: string): Promise<T | null> => {
    try {
      const text = await readFile(join(options.baseDir, 'runs', runId, filename), 'utf8');
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  };

  const routes: Route[] = [
    {
      method: 'GET',
      match: /^\/healthz$/,
      handle: async (_params, res) => {
        json(res, 200, { ok: true });
      },
    },
    {
      method: 'GET',
      match: /^\/api\/runs$/,
      handle: async (_params, res) => {
        const runs: RunSummary[] = await store.list();
        json(res, 200, { runs });
      },
    },
    {
      method: 'GET',
      match: /^\/api\/metrics$/,
      handle: async (_params, res, requestUrl) => {
        /**
         * 跨 run 的指标序列（报告页的"指标趋势"）。
         *
         * **在服务端算好再给**，而不是让前端拉 N 个 run 自己拼：
         * 前端只能 type-only 引用 shared，拿不到 core 的实现；
         * 而"来源变了就不给变化量"这条判断属于测量正确性，
         * 只能有一份实现（`core/trends`）。
         *
         * `limit` 是外部输入，必须夹到合理区间 —— 一个 `limit=100000`
         * 会让我们把所有历史 run 读进内存再排序。
         */
        const limit = clampLimit(requestUrl.searchParams.get('limit'), 30, 200);
        const route = requestUrl.searchParams.get('route');
        const device = requestUrl.searchParams.get('device');

        const summaries = await store.list();
        const selected = summaries
          .filter((s) => (route === null || s.route === route) && (device === null || s.device === device))
          .slice(0, limit);

        const runs = (
          await Promise.all(selected.map((summary) => store.load(summary.id)))
        ).filter((run): run is NonNullable<typeof run> => run !== null);

        json(res, 200, { series: buildMetricSeries(runs, { limit }) });
      },
    },
    {
      method: 'GET',
      match: /^\/api\/runs\/([^/]+)$/,
      handle: async (params, res) => {
        const runId = decodeURIComponent(params[0] ?? '');
        // 路径参数是**外部输入**：`..%2F..%2Fetc` 这类穿越必须先挡掉
        if (!isSafeId(runId)) {
          json(res, 400, { error: 'bad_request', message: 'runId 不合法' });
          return;
        }

        const run = await store.load(runId);
        if (run === null) {
          notFound(res, `run ${runId}`);
          return;
        }

        // 报告页要的是完整的一份数据，分四次请求拼起来只会更慢也更容易不一致
        const [diagnosis, candidates, decisions, executions, verifications] = await Promise.all([
          store.loadDiagnosis(runId),
          readRunJson<unknown[]>(runId, 'candidates.json'),
          readRunJson<unknown[]>(runId, 'decisions.json'),
          readRunJson<unknown[]>(runId, 'executions.json'),
          readRunJson<unknown[]>(runId, 'verifications.json'),
        ]);

        json(res, 200, {
          run,
          diagnosis,
          candidates: candidates ?? [],
          decisions: decisions ?? [],
          executions: executions ?? [],
          verifications: verifications ?? [],
        });
      },
    },
    {
      method: 'GET',
      match: /^\/api\/runs\/([^/]+)\/report$/,
      handle: async (params, res) => {
        const runId = decodeURIComponent(params[0] ?? '');
        if (!isSafeId(runId)) {
          json(res, 400, { error: 'bad_request', message: 'runId 不合法' });
          return;
        }

        const run = await store.load(runId);
        if (run === null) {
          notFound(res, `run ${runId}`);
          return;
        }

        const diagnosis: Diagnosis | null = await store.loadDiagnosis(runId);
        const [candidates, decisions, executions, verifications] = await Promise.all([
          readRunJson<Parameters<typeof renderMarkdown>[2]>(runId, 'candidates.json'),
          readRunJson<Parameters<typeof renderMarkdown>[3]>(runId, 'decisions.json'),
          readRunJson<Parameters<typeof renderMarkdown>[4]>(runId, 'executions.json'),
          readRunJson<Parameters<typeof renderMarkdown>[5]>(runId, 'verifications.json'),
        ]);

        send(
          res,
          200,
          renderMarkdown(
            run,
            diagnosis,
            candidates ?? [],
            decisions ?? [],
            executions ?? [],
            verifications ?? [],
          ),
          'text/markdown',
        );
      },
    },
  ];

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? host}`);
    const path = url.pathname;

    if (!authorized(req, url, token)) {
      // 401 + WWW-Authenticate：告诉调用方"这需要凭据"，而不是让它以为是 404
      res.writeHead(401, {
        'content-type': 'application/json; charset=utf-8',
        'www-authenticate': 'Bearer realm="perfpilot"',
      });
      res.end(`${JSON.stringify({ error: 'unauthorized', message: '需要访问令牌' })}\n`);
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      json(res, 405, { error: 'method_not_allowed', message: '本服务是只读的' });
      return;
    }

    for (const route of routes) {
      const matched = route.match.exec(path);
      if (matched === null) continue;
      try {
        await route.handle(matched.slice(1), res, url);
      } catch (err) {
        json(res, 500, {
          error: 'internal',
          message: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }

    // API 前缀下没匹配到就是 404，**不能**落到静态托管上 ——
    // 否则一个打错的 API 路径会拿到一份 HTML，调用方 JSON.parse 报的错
    // 跟真正的原因（路径写错了）毫无关系
    if (path.startsWith('/api/')) {
      notFound(res, path);
      return;
    }

    /**
     * 静态托管。
     *
     * 这一段的异常**必须自己兜住**。请求是通过 `void handler(req, res)` 发起的，
     * 一旦抛出去就变成一个未处理的 Promise 拒绝：Node 打一行日志，
     * 而**响应永远不会发出**，客户端一直等到超时。
     * 排查时看到的是"页面转圈"，跟真正的原因（服务端抛了个错）隔着十万八千里 ——
     * 这个 bug 在本文件里真实发生过一次（`res` 漏传导致 ReferenceError）。
     */
    try {
      if (await serveStatic(path, res)) return;
    } catch (err) {
      json(res, 500, {
        error: 'internal',
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // 没构建前端时给出可操作的提示，而不是一个裸 404（`/` 是页面入口）
    if (webDir === null && path === '/') {
      send(
        res,
        404,
        '报告页未构建。先执行：pnpm --filter @yuki-byte18/web build\n',
        'text/plain',
      );
      return;
    }

    notFound(res, path);
  };

  /**
   * 静态托管报告页。
   *
   * 三条规则，都是为了不出现"服务在跑但页面是白的"：
   *
   * 1. **未知路径回落到 `index.html`**：报告页会有 `?run=` 这类入口，
   *    刷新时路径可能带上一段不存在的部分。
   * 2. **路径必须解析在 webDir 之内**：`..%2f..%2fetc%2fpasswd` 这类穿越
   *    是静态托管最经典的漏洞。先 `resolve` 再比较前缀，而不是相信 `..` 已被规范化。
   * 3. **没构建前端时给出可操作的提示**，而不是一个裸 404 ——
   *    `pnpm --filter @yuki-byte18/web build` 这句话只有这里能告诉用户。
   */
  const serveStatic = async (path: string, res: ServerResponse): Promise<boolean> => {
    if (webDir === null) return false;

    const relative = path === '/' ? 'index.html' : decodeURIComponent(path).replace(/^\/+/, '');
    const target = resolve(webDir, relative);

    if (!target.startsWith(resolve(webDir))) return false;

    const file = await readFile(target).catch(() => null);
    if (file !== null) {
      send(res, 200, file.toString('utf8'), contentTypeOf(target));
      return true;
    }

    // 回落：找不到文件时给 index.html（客户端路由），仍然在 webDir 之内
    const index = await readFile(join(webDir, 'index.html')).catch(() => null);
    if (index === null) {
      send(res, 404, '报告页未构建。先执行：pnpm --filter @yuki-byte18/web build\n', 'text/plain');
      return true;
    }

    send(res, 200, index.toString('utf8'), 'text/html');
    return true;
  };

  const server: Server = createServer((req, res) => {
    void handler(req, res);
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 3080, host, () => {
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : (options.port ?? 3080));
    });
  });

  const url = `http://${host}:${port}`;
  options.logger?.info('报告服务已启动', { url, baseDir: options.baseDir });

  return {
    port,
    url,
    close: () =>
      new Promise<void>((resolve_, reject) => {
        server.close((err) => (err === null || err === undefined ? resolve_() : reject(err)));
      }),
  };
}

/**
 * 静态资源的 content-type。
 *
 * 手写一张表而不是引 `mime` 之类的包：托管的是**我们自己构建出来的**产物，
 * 只会有这几种扩展名。多一个依赖去猜一个已知集合，不划算。
 * 未知扩展名一律 `application/octet-stream` —— 猜成 `text/html` 会把
 * 一个二进制文件当页面渲染。
 */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function contentTypeOf(file: string): string {
  return CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
}
