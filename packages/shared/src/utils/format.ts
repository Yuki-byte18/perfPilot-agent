import type { MetricUnit } from '../types/metric.js';

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB'] as const;

/** 字节数 → 人类可读，1024 进制 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return 'n/a';
  if (bytes === 0) return '0 B';

  const sign = bytes < 0 ? '-' : '';
  let value = Math.abs(bytes);
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const precision = unitIndex === 0 ? 0 : 1;
  return `${sign}${value.toFixed(precision)} ${BYTE_UNITS[unitIndex]}`;
}

/** 按指标单位格式化数值 */
export function formatValue(value: number, unit: MetricUnit, precision = 0): string {
  if (!Number.isFinite(value)) return 'n/a';
  switch (unit) {
    case 'byte':
      return formatBytes(value);
    case 'ms':
      return `${value.toFixed(precision)} ms`;
    case 'count':
      return `${Math.round(value)}`;
    case 'score':
      return value.toFixed(precision);
    default:
      return String(value);
  }
}

/** 带符号的百分比，用于报告中的 Δ% 列 */
export function formatSignedPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

/** 带符号的分数差 */
export function formatSignedScore(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}`;
}

/** 带符号的指标差值，单位随指标 */
export function formatSignedValue(
  value: number | null,
  unit: MetricUnit,
  precision = 0,
): string {
  if (value === null || !Number.isFinite(value)) return '—';
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  return `${sign}${formatValue(Math.abs(value), unit, precision)}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}
