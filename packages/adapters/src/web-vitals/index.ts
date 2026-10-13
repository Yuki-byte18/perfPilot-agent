import type { CollectorPort, RawRunner } from '@yuki-byte18/shared';
import { defineCollector } from '../define-collector.js';
import { parseWebVitals } from './parse.js';
import { createWebVitalsRunner, probeWebVitals, type WebVitalsRunnerOptions } from './runner.js';

export interface WebVitalsAdapterOptions extends WebVitalsRunnerOptions {
  runner?: RawRunner;
  probe?: () => Promise<boolean>;
}

export function createWebVitalsCollector(
  options: WebVitalsAdapterOptions = {},
): CollectorPort {
  const runner = options.runner ?? createWebVitalsRunner(options);
  const probe = options.probe ?? (() => probeWebVitals(options));

  return defineCollector({
    id: 'web-vitals',
    probe,
    runner,
    parse: parseWebVitals,
  });
}

export { parseWebVitals, samplesFromReport, unexpectedMetricNames } from './parse.js';
export { createWebVitalsRunner, probeWebVitals, resolveVitalsPath } from './runner.js';
export { WebVitalsReportSchema } from './schema.js';
export type { WebVitalsReport } from './schema.js';
