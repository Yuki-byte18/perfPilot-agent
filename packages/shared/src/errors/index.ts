import type { StageName } from '../types/run.js';

export const ERROR_CODES = [
  'CONFIG_NOT_FOUND',
  'CONFIG_INVALID',
  'ADAPTER_UNAVAILABLE',
  'ADAPTER_FAILED',
  'ADAPTER_OUTPUT_INVALID',
  'COLLECT_FAILED',
  'REPORT_FAILED',
  'STORE_FAILED',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface PerfPilotErrorOptions {
  code: ErrorCode;
  stage?: StageName;
  /** 该错误是否值得重试（网络抖动 vs 配置写错） */
  retryable?: boolean;
  details?: Record<string, unknown>;
  cause?: unknown;
}

/**
 * 全项目统一错误类型。
 *
 * 注意 `stage` / `details` / `cause` 用 `| null` 而非 `?`：
 * 在 `exactOptionalPropertyTypes` 下，显式 `undefined` 与「键不存在」是两回事，
 * 用可空字段可以避免调用侧到处写条件展开。
 */
export class PerfPilotError extends Error {
  override readonly name: string = 'PerfPilotError';
  readonly code: ErrorCode;
  readonly stage: StageName | null;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | null;
  override readonly cause: unknown;

  constructor(message: string, options: PerfPilotErrorOptions) {
    super(message);
    this.code = options.code;
    this.stage = options.stage ?? null;
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? null;
    this.cause = options.cause;
  }

  /** 结构化输出：进日志、进报告的 JSON 形态 */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      stage: this.stage,
      retryable: this.retryable,
      message: this.message,
      details: this.details,
    };
  }
}

export class ConfigError extends PerfPilotError {
  override readonly name = 'ConfigError';
  constructor(message: string, options: Omit<PerfPilotErrorOptions, 'code'> & { code?: ErrorCode }) {
    super(message, { retryable: false, ...options, code: options.code ?? 'CONFIG_INVALID' });
  }
}

export class AdapterError extends PerfPilotError {
  override readonly name = 'AdapterError';
  constructor(message: string, options: Omit<PerfPilotErrorOptions, 'code'> & { code?: ErrorCode }) {
    super(message, { retryable: true, ...options, code: options.code ?? 'ADAPTER_FAILED' });
  }
}

export class CollectError extends PerfPilotError {
  override readonly name = 'CollectError';
  constructor(message: string, options: Omit<PerfPilotErrorOptions, 'code'> & { code?: ErrorCode }) {
    super(message, { ...options, code: options.code ?? 'COLLECT_FAILED' });
  }
}

export class ValidationError extends PerfPilotError {
  override readonly name = 'ValidationError';
  constructor(message: string, options: Omit<PerfPilotErrorOptions, 'code'> & { code?: ErrorCode }) {
    super(message, { retryable: false, ...options, code: options.code ?? 'ADAPTER_OUTPUT_INVALID' });
  }
}

/** 把任意抛出物收敛成 PerfPilotError，保证上层只需处理一种错误类型 */
export function toPerfPilotError(err: unknown, fallback: ErrorCode = 'INTERNAL'): PerfPilotError {
  if (err instanceof PerfPilotError) return err;

  const message = err instanceof Error ? err.message : String(err);
  return new PerfPilotError(message, { code: fallback, cause: err });
}

/** 进程退出码约定，与 README §12 一致 */
export const EXIT_CODES = {
  OK: 0,
  GATE_FAILED: 1,
  CONFIG_ERROR: 2,
  COLLECT_FAILED: 3,
  INTERNAL: 4,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export function exitCodeForError(err: PerfPilotError): ExitCode {
  switch (err.code) {
    case 'CONFIG_INVALID':
    case 'CONFIG_NOT_FOUND':
      return EXIT_CODES.CONFIG_ERROR;
    case 'COLLECT_FAILED':
    case 'ADAPTER_FAILED':
    case 'ADAPTER_UNAVAILABLE':
    case 'ADAPTER_OUTPUT_INVALID':
      return EXIT_CODES.COLLECT_FAILED;
    default:
      return EXIT_CODES.INTERNAL;
  }
}
