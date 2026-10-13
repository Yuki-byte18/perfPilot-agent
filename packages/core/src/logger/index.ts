import { pino } from 'pino';
import type { LogFields, LogLevel, LoggerPort } from '@yuki-byte18/shared';

export interface LoggerOptions {
  level?: LogLevel;
  /** 日志一律写 stderr：stdout 留给报告，CI 里两者需要能被分别重定向 */
  destination?: NodeJS.WritableStream;
  /** 附加到每条日志的固定字段 */
  bindings?: LogFields;
}

/**
 * 统一日志出口（硬约束 12）。
 *
 * 语义分工是刻意的：
 *   - **stderr 写 pino 结构化日志** —— 给机器看，进 CI 日志、可被采集
 *   - **stdout 写报告** —— 给人看，由 reporter 渲染
 * 混在一起会导致 `perfpilot run > report.md` 里掺进 JSON 日志行。
 *
 * 直接用 `process.stderr` 而不是 `pino.destination({ dest: 2 })`：
 * 后者在 pino 9 的 ESM 类型里不在具名导出上，为了一个 fd 编号去绕类型不值得，
 * 而 `process.stderr` 本身就满足 pino 的 DestinationStream 契约。
 */
export function createPinoLogger(options: LoggerOptions = {}): LoggerPort {
  const instance = pino(
    {
      level: options.level ?? 'info',
      base: { pid: process.pid, ...(options.bindings ?? {}) },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    options.destination ?? process.stderr,
  );

  return {
    trace: (msg, fields) => write(instance, 'trace', msg, fields),
    debug: (msg, fields) => write(instance, 'debug', msg, fields),
    info: (msg, fields) => write(instance, 'info', msg, fields),
    warn: (msg, fields) => write(instance, 'warn', msg, fields),
    error: (msg, fields) => write(instance, 'error', msg, fields),
    fatal: (msg, fields) => write(instance, 'fatal', msg, fields),
    child: (bindings) => wrap(instance.child(bindings)),
  };
}

type PinoLike = {
  trace: (o: LogFields, m: string) => void;
  debug: (o: LogFields, m: string) => void;
  info: (o: LogFields, m: string) => void;
  warn: (o: LogFields, m: string) => void;
  error: (o: LogFields, m: string) => void;
  fatal: (o: LogFields, m: string) => void;
  child: (b: LogFields) => PinoLike;
};

function write(
  logger: PinoLike,
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal',
  msg: string,
  fields?: LogFields,
): void {
  if (fields === undefined) {
    logger[level]({}, msg);
    return;
  }
  logger[level](fields, msg);
}

function wrap(instance: PinoLike): LoggerPort {
  return {
    trace: (msg, fields) => write(instance, 'trace', msg, fields),
    debug: (msg, fields) => write(instance, 'debug', msg, fields),
    info: (msg, fields) => write(instance, 'info', msg, fields),
    warn: (msg, fields) => write(instance, 'warn', msg, fields),
    error: (msg, fields) => write(instance, 'error', msg, fields),
    fatal: (msg, fields) => write(instance, 'fatal', msg, fields),
    child: (bindings) => wrap(instance.child(bindings)),
  };
}

/** 测试用：把日志收集到数组，便于断言「单 adapter 失败时确实记了 warning」 */
export function createMemoryLogger(
  sink: Array<{ level: string; msg: string; fields?: LogFields }> = [],
): LoggerPort & { entries: typeof sink } {
  const push = (level: string) => (msg: string, fields?: LogFields) => {
    sink.push(fields === undefined ? { level, msg } : { level, msg, fields });
  };

  const logger: LoggerPort & { entries: typeof sink } = {
    entries: sink,
    trace: push('trace'),
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    fatal: push('fatal'),
    child: () => logger,
  };

  return logger;
}

/** 测试用：完全静默，只为了避免测试输出里混进日志 */
export function createSilentLogger(): LoggerPort {
  const noop = (): void => undefined;
  const logger: LoggerPort = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => logger,
  };
  return logger;
}
