import type { CollectorPort, RawRunner } from '@yuki-byte18/shared';
import { defineCollector } from '../define-collector.js';
import { parseLighthouse } from './parse.js';
import { createLighthouseRunner, probeLighthouse, type LighthouseRunnerOptions } from './runner.js';

export interface LighthouseAdapterOptions extends LighthouseRunnerOptions {
  /** 注入替身：测试用 fixture runner 替换真实进程调用 */
  runner?: RawRunner;
  /** 注入替身：跳过 `lighthouse --version` 探活 */
  probe?: () => Promise<boolean>;
}

/**
 * Lighthouse 适配器。
 *
 * `runner` 可注入，于是「采集 → 解析 → 打分 → 报告」的整条链路可以在
 * 零网络、零 Chrome 的条件下被完整测试 —— 这是 M1 验收标准第 5 条的前提。
 */
export function createLighthouseCollector(
  options: LighthouseAdapterOptions = {},
): CollectorPort {
  const runner = options.runner ?? createLighthouseRunner(options);
  const probe = options.probe ?? (() => probeLighthouse(options.bin));

  return defineCollector({
    id: 'lighthouse',
    probe,
    runner,
    parse: parseLighthouse,
  });
}

export { parseLighthouse, samplesFromResult, lighthouseVersionOf } from './parse.js';
export { createLighthouseRunner, probeLighthouse } from './runner.js';
export { LighthouseResultSchema } from './schema.js';
export type { LighthouseResult } from './schema.js';
