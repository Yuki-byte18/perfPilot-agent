import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { parseJsonText, type RawArtifact, type RawRunner } from '@yuki-byte18/shared';
import { WEB_VITALS_KIND } from './parse.js';

export const DEFAULT_VITALS_FILE = '.perfpilot/vitals.json';

export interface WebVitalsRunnerOptions {
  /**
   * 上报文件路径。相对路径按 `project.root` 解析。
   *
   * 之所以是「读文件」而不是「自己开浏览器采」：现场指标（尤其是 INP）
   * 只能由真实加载过程产生。项目自身的 `web-vitals` 上报或 CI 里的采集步骤
   * 把结果写成 JSON，这里是消费侧。浏览器内采集由 M2 的 playwright 适配器负责。
   */
  file?: string;
  /** 项目根目录，用于解析相对路径 */
  root?: string;
}

export function resolveVitalsPath(options: WebVitalsRunnerOptions = {}): string {
  const file = options.file ?? process.env.PERFPILOT_VITALS_FILE ?? DEFAULT_VITALS_FILE;
  if (isAbsolute(file)) return file;
  return resolve(options.root ?? process.cwd(), file);
}

/** 文件存在且可解析为 JSON 才认为该适配器可用 */
export async function probeWebVitals(options: WebVitalsRunnerOptions = {}): Promise<boolean> {
  try {
    parseJsonText(await readFile(resolveVitalsPath(options), 'utf8'));
    return true;
  } catch {
    return false;
  }
}

/**
 * 读取现场指标上报。
 *
 * 文件不存在时抛错而不是返回空数组：collector 会把它降级为 warning
 * 并在报告里显式写明「INP 未采集」，避免读者把「没有数据」误读成「数据正常」。
 */
export function createWebVitalsRunner(options: WebVitalsRunnerOptions = {}): RawRunner {
  return async (ctx): Promise<RawArtifact[]> => {
    const path = resolveVitalsPath(options);
    const payload = parseJsonText(await readFile(path, 'utf8'));

    return [
      {
        adapter: 'web-vitals',
        kind: WEB_VITALS_KIND,
        payload,
        collectedAt: new Date().toISOString(),
        route: ctx.route,
        device: ctx.device,
        file: null,
      },
    ];
  };
}

/** 供组合根使用：把配置里的相对路径解析到项目根 */
export function vitalsPathWithin(root: string, file?: string): string {
  if (file !== undefined) return resolveVitalsPath({ file, root });
  const fromEnv = process.env.PERFPILOT_VITALS_FILE;
  if (fromEnv !== undefined) return resolveVitalsPath({ root });
  return join(root, DEFAULT_VITALS_FILE);
}
