import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import {
  HarPayloadSchema,
  parseExternal,
  parseJsonText,
  type CollectorPort,
  type HarPayload,
  type MetricSample,
  type RawArtifact,
  type RawRunner,
} from '@yuki-byte18/shared';
import { artifactsOf, defineCollector } from '../define-collector.js';
import { samples } from '../internal/samples.js';
import { HarSchema } from './schema.js';
import { normalizeHarEntries } from './normalize.js';

export const HAR_KIND = 'har';

/** 每次采集最多保留多少条 entry，防止异常大的 HAR 撑爆 run 目录 */
const DEFAULT_MAX_ENTRIES = 2_000;

export interface HarRunnerOptions {
  /** HAR 文件路径，相对路径按 root 解析 */
  file?: string;
  root?: string;
  maxEntries?: number;
}

export function resolveHarPath(options: HarRunnerOptions = {}): string {
  const file = options.file ?? process.env.PERFPILOT_HAR_FILE ?? '.perfpilot/network.har';
  if (isAbsolute(file)) return file;
  return resolve(options.root ?? process.cwd(), file);
}

export async function probeHar(options: HarRunnerOptions = {}): Promise<boolean> {
  try {
    const parsed = parseExternal(HarSchema, parseJsonText(await readFile(resolveHarPath(options), 'utf8')), {
      what: 'HAR 文件',
    });
    return parsed.log.entries.length > 0;
  } catch {
    return false;
  }
}

/**
 * 读取 HAR 并规范化。
 *
 * **为什么 runner 里就裁剪**：HAR 的 `response.content.text` 会内嵌整个响应体
 * （base64），一个真实页面的 HAR 动辄几十 MB。原样落盘会让 `.perfpilot/runs/`
 * 迅速膨胀到不可用，而这些字节对性能诊断零价值。裁剪规则写在 normalize 里，
 * 保证诊断需要的信息（体积、时序、头部、发起者）一个不少。
 */
export function createHarRunner(options: HarRunnerOptions = {}): RawRunner {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;

  return async (ctx): Promise<RawArtifact[]> => {
    const path = resolveHarPath(options);
    const parsed = parseExternal(HarSchema, parseJsonText(await readFile(path, 'utf8')), {
      what: 'HAR 文件',
      code: 'ADAPTER_OUTPUT_INVALID',
      stage: 'collect',
    });

    const { pageUrl, entries } = normalizeHarEntries(parsed.log.entries);

    const payload: HarPayload = {
      source: 'har',
      pageUrl,
      entryCount: parsed.log.entries.length,
      // 按耗时降序保留最值得看的部分，而不是简单截断前 N 条
      entries: [...entries].sort((a, b) => b.timeMs - a.timeMs).slice(0, maxEntries),
    };

    return [
      {
        adapter: 'har',
        kind: HAR_KIND,
        payload,
        collectedAt: new Date().toISOString(),
        route: ctx.route,
        device: ctx.device,
        file: null,
      },
    ];
  };
}

export function harPayloads(artifacts: readonly RawArtifact[]): HarPayload[] {
  const out: HarPayload[] = [];
  for (const artifact of artifactsOf(artifacts, 'har', HAR_KIND)) {
    const parsed = HarPayloadSchema.safeParse(artifact.payload);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/**
 * HAR → 指标样本。
 *
 * 只产出网络层面的指标。JS/CSS/图片体积**不从这里出**：
 * HAR 量的是「这次网络传输了多少」，而 bundle-analyzer 量的是「产物有多大」，
 * 两者口径不同。让 HAR 去抢 `JS_SIZE` 会让基线对比在「换了测量工具」时失真。
 */
export function parseHar(artifacts: readonly RawArtifact[]): MetricSample[] {
  const payloads = harPayloads(artifacts);
  if (payloads.length === 0) return [];

  const entries = payloads.flatMap((p) => p.entries);
  if (entries.length === 0) return [];

  const transfer = entries.reduce((sum, e) => sum + (e.transferSize ?? 0), 0);
  const transferKnown = entries.some((e) => e.transferSize !== null);

  return samples([
    ['REQUEST_COUNT', entries.length],
    ['TRANSFER_SIZE', transferKnown ? transfer : null],
  ]);
}

export interface HarAdapterOptions extends HarRunnerOptions {
  runner?: RawRunner;
  probe?: () => Promise<boolean>;
}

export function createHarCollector(options: HarAdapterOptions = {}): CollectorPort {
  return defineCollector({
    id: 'har',
    probe: options.probe ?? (() => probeHar(options)),
    runner: options.runner ?? createHarRunner(options),
    parse: parseHar,
  });
}
