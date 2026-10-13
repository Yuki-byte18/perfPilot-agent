import type { CheckKind } from '../types/verification.js';

/**
 * 检查运行端口。
 *
 * 单测 / type-check / lint / E2E 必须经过 adapter（硬约束 5：core 不得 child_process）。
 * verifier 只依赖这个接口，测试注入永远成功/失败的假实现即可。
 */
export interface CheckRunResult {
  kind: CheckKind;
  passed: boolean;
  durationMs: number;
  output: string;
  /**
   * 这项检查**没有真的跑**（项目里没定义对应的 npm script / 没有 E2E 环境）。
   *
   * 必须与 `passed: true` 区分开：报告里「检查通过」和「没有这项检查」是两件事，
   * 混为一谈会让一个没有 E2E 的项目看起来像 E2E 也过了。
   * 跳过不算失败（不该因此回滚），但会被如实记进验证记录。
   */
  skipped?: boolean;
}

export interface CheckRunnerPort {
  run(kind: Exclude<CheckKind, 'recollect' | 'error-scan' | 'bundle-size'>, cwd: string): Promise<CheckRunResult>;
}

/** 测试用：全部检查按给定结果返回，默认全部通过 */
export function createFakeCheckRunner(passed = true): CheckRunnerPort {
  return {
    async run(kind) {
      return { kind, passed, durationMs: 1, output: passed ? 'ok' : 'failed' };
    },
  };
}
