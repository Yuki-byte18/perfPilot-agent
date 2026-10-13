import {
  parseExternal,
  type MetricSample,
  type RawArtifact,
} from '@yuki-byte18/shared';
import { artifactsOf } from '../define-collector.js';
import { computeBundleSizes, findDuplicatePackages } from '../internal/bundle.js';
import { sample } from '../internal/samples.js';
import { BundleScanPayloadSchema } from './schema.js';
import type { BundleScanPayload } from './schema.js';

export const BUNDLE_SCAN_KIND = 'bundle-scan';

/**
 * 构建产物扫描结果 → 未打分样本。
 *
 * 两个刻意的设计：
 * 1. **不产出 PROJECT 自身源码的体积**，只统计构建产物文件；源码行数不是性能指标。
 * 2. **重复依赖只在 `source === 'stats'` 时计算**。仅有目录扫描时拿不到模块图，
 *    此时报 `DUPLICATE_DEPS: 0` 是危险的 —— 它会让「依赖重复」这个瓶颈
 *    永远无法被发现，报告却显示一切正常。宁可不产出这个指标。
 */
export function samplesFromScan(scan: BundleScanPayload): MetricSample[] {
  const out = computeBundleSizes(scan.files);

  if (scan.source === 'stats') {
    const duplicates = findDuplicatePackages(scan.modules);
    const built = sample('DUPLICATE_DEPS', duplicates.count);
    if (built) out.push(built);
  }

  return out;
}

export function parseBundleScan(artifacts: readonly RawArtifact[]): MetricSample[] {
  const out: MetricSample[] = [];

  for (const artifact of artifactsOf(artifacts, 'bundle-analyzer', BUNDLE_SCAN_KIND)) {
    const scan: BundleScanPayload = parseExternal(BundleScanPayloadSchema, artifact.payload, {
      what: '构建产物扫描结果',
      code: 'ADAPTER_OUTPUT_INVALID',
      stage: 'collect',
    });
    out.push(...samplesFromScan(scan));
  }

  return out;
}

/** 重复依赖明细，供 M2 诊断出具体是哪些包 */
export function duplicateDetailsOf(
  artifacts: readonly RawArtifact[],
): ReturnType<typeof findDuplicatePackages>['details'] {
  const out: ReturnType<typeof findDuplicatePackages>['details'] = [];

  for (const artifact of artifactsOf(artifacts, 'bundle-analyzer', BUNDLE_SCAN_KIND)) {
    const scan = BundleScanPayloadSchema.safeParse(artifact.payload);
    if (!scan.success) continue;
    out.push(...findDuplicatePackages(scan.data.modules).details);
  }

  return out;
}
