import type { CollectorPort, RawRunner } from '@yuki-byte18/shared';
import { defineCollector } from '../define-collector.js';
import { parseBundleScan } from './parse.js';
import {
  createBundleAnalyzerRunner,
  probeBundleAnalyzer,
  type BundleAnalyzerRunnerOptions,
} from './runner.js';

export interface BundleAnalyzerAdapterOptions extends BundleAnalyzerRunnerOptions {
  runner?: RawRunner;
  probe?: () => Promise<boolean>;
}

export function createBundleAnalyzerCollector(
  options: BundleAnalyzerAdapterOptions = {},
): CollectorPort {
  const runner = options.runner ?? createBundleAnalyzerRunner(options);
  const probe = options.probe ?? (() => probeBundleAnalyzer(options));

  return defineCollector({
    id: 'bundle-analyzer',
    probe,
    runner,
    parse: parseBundleScan,
  });
}

export { parseBundleScan, samplesFromScan, duplicateDetailsOf } from './parse.js';
export {
  createBundleAnalyzerRunner,
  probeBundleAnalyzer,
  resolveDistDir,
} from './runner.js';
export { BundleScanPayloadSchema } from './schema.js';
export type { BundleScanPayload, BundleFile, BundleModule, PackageJsonSnapshot } from './schema.js';
