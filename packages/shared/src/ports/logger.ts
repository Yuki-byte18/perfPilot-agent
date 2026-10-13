/**
 * 日志端口。实现由 core/logger（pino）提供。
 *
 * 采用 `(msg, fields)` 顺序而非 pino 的 `(obj, msg)`：调用侧不会因为忘记传 msg
 * 而把一个对象当成消息打印出去。
 */
export const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogFields = Record<string, unknown>;

export interface LoggerPort {
  trace(msg: string, fields?: LogFields): void;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  fatal(msg: string, fields?: LogFields): void;
  /** 绑定固定字段（如 adapter / route），返回新的 logger */
  child(bindings: LogFields): LoggerPort;
}
