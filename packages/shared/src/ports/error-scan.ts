/**
 * 错误扫描端口（sentry 等）。验证阶段用来判断「改完有没有引入新错误」。
 */
export interface ScannedError {
  type: string;
  message: string;
  count: number;
}

export interface ErrorScanPort {
  scan(input: { project: string; sinceIso: string }): Promise<ScannedError[]>;
}

export function createNullErrorScan(): ErrorScanPort {
  return {
    async scan() {
      return [];
    },
  };
}
