import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatDuration,
  formatSignedPercent,
  formatSignedScore,
  formatSignedValue,
  formatValue,
} from './format.js';
import { compactTimestamp, createRunId, isSafeId } from './id.js';

describe('formatBytes', () => {
  it('按 1024 进制换算并保留合适精度', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(300_000)).toBe('293.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB');
    expect(formatBytes(-2048)).toBe('-2.0 KB');
  });

  it('非有限值不抛错', () => {
    expect(formatBytes(Number.NaN)).toBe('n/a');
  });
});

describe('formatValue', () => {
  it('按单位选择格式', () => {
    expect(formatValue(2500, 'ms')).toBe('2500 ms');
    expect(formatValue(307_200, 'byte')).toBe('300.0 KB');
    expect(formatValue(12.6, 'count')).toBe('13');
    expect(formatValue(0.1234, 'score', 3)).toBe('0.123');
  });
});

describe('带符号格式化', () => {
  it('改善显示 +，回归显示 -', () => {
    expect(formatSignedPercent(12.34)).toBe('+12.3%');
    expect(formatSignedPercent(-12.34)).toBe('-12.3%');
    expect(formatSignedScore(0)).toBe('0.0');
    expect(formatSignedScore(-16.67)).toBe('-16.7');
  });

  it('null 显示为占位符而不是 0', () => {
    expect(formatSignedPercent(null)).toBe('—');
    expect(formatSignedScore(null)).toBe('—');
    expect(formatSignedValue(null, 'ms')).toBe('—');
  });

  it('指标差值保留单位与方向', () => {
    expect(formatSignedValue(150_000, 'byte')).toBe('+146.5 KB');
    expect(formatSignedValue(-1000, 'ms')).toBe('-1000 ms');
    expect(formatSignedValue(0, 'ms')).toBe('0 ms');
  });
});

describe('formatDuration', () => {
  it('毫秒与秒之间切换', () => {
    expect(formatDuration(250)).toBe('250ms');
    expect(formatDuration(1500)).toBe('1.50s');
  });
});

describe('id 工具', () => {
  it('run id 带前缀、时间戳与随机后缀', () => {
    const id = createRunId(new Date('2026-01-17T14:25:30.000Z'));
    expect(id).toMatch(/^run_20260117T142530_[0-9a-f]{6}$/);
  });

  it('相同时间戳下 id 仍然唯一（并发 CI job 不撞号）', () => {
    const date = new Date('2026-01-17T14:25:30.000Z');
    const ids = new Set(Array.from({ length: 50 }, () => createRunId(date)));
    expect(ids.size).toBe(50);
  });

  it('compactTimestamp 不含分隔符', () => {
    expect(compactTimestamp(new Date('2026-01-17T14:25:30.000Z'))).toBe('20260117T142530');
  });

  it('isSafeId 拦截路径穿越', () => {
    expect(isSafeId('run_20260117T142530_a1b2c3')).toBe(true);
    expect(isSafeId('../../etc/passwd')).toBe(false);
    expect(isSafeId('a/b')).toBe(false);
  });
});
