import { randomBytes } from 'node:crypto';

/** 紧凑时间戳：20260117T142530 */
export function compactTimestamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z').replace('Z', '');
}

/**
 * run id 形如 `run_20260117T142530_a1b2c3`：前缀便于人眼识别，
 * 时间戳便于排序，随机后缀保证并发的 CI job 不会撞号。
 */
export function createRunId(date: Date, entropy: number = 3): string {
  return `run_${compactTimestamp(date)}_${randomBytes(entropy).toString('hex')}`;
}

/** 只保留 id 中安全字符，避免路径穿越 */
export function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id);
}
