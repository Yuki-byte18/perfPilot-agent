import type { z } from 'zod';
import { ValidationError } from '../errors/index.js';
import type { ErrorCode } from '../errors/index.js';
import type { StageName } from '../types/run.js';

export interface ParseOptions {
  /** 出现在错误信息里的数据来源描述，如 `lighthouse 采集结果` */
  what: string;
  code?: ErrorCode;
  stage?: StageName;
}

/**
 * 所有外部数据的唯一入口（硬约束 11）。
 *
 * 失败时抛 ValidationError，并把 zod 的 issue 压成一行可读文本 ——
 * 配置文件写错时，用户需要看到的是 `decision.thresholds.min_gain: Expected number`，
 * 而不是一个嵌套对象。
 */
export function parseExternal<T>(
  // 第三参数必须显式写成 unknown：zod 的 `.default()` / `.transform()` 会让
  // 输入类型与输出类型不同，若写成 `z.ZodType<T>`（Input 默认等于 T），
  // TS 会把 T 推断成**输入**类型，于是带 `.default()` 的 schema 解析结果
  // 会缺字段、报 "is not assignable"。声明成 unknown 才会取到输出类型。
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  input: unknown,
  options: ParseOptions,
): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  throw new ValidationError(`${options.what} 校验失败: ${formatIssues(result.error)}`, {
    code: options.code ?? 'ADAPTER_OUTPUT_INVALID',
    ...(options.stage !== undefined ? { stage: options.stage } : {}),
    details: { issues: result.error.issues },
  });
}

/** 只判断不抛出，用于「可用则用、不可用则降级」的分支 */
export function tryParseExternal<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  input: unknown,
): T | null {
  const result = schema.safeParse(input);
  return result.success ? result.data : null;
}

export function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '<root>';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}
