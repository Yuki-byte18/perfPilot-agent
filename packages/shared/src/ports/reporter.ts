import type { ReportFormat } from '../types/config.js';
import type { RunRecord } from '../types/run.js';
import type { Diagnosis } from '../schema/diagnosis.js';
import type { Candidate } from '../schema/candidate.js';
import type { Decision } from '../types/decision.js';
import type { Verification } from '../schema/verification.js';
import type { ExecutionResult } from './executor.js';

/**
 * 报告渲染的输入。
 *
 * 把 run 与 diagnosis 一起传，而不是只传 run：报告要对读者回答两个不同的问题
 * ——「测到了什么」（run）与「哪里有问题」（diagnosis）。两者分开存储
 * （同一个 run 可以用更新版本的规则重跑诊断），但展示时必须合在一起。
 *
 * `diagnosis` 允许为 null：M1 阶段没有诊断，以及诊断阶段失败时，
 * 报告仍应产出指标部分，而不是什么都不给。
 *
 * `executions` 与 `verifications` 是 M5 的两段留痕：
 * 前者是「产出了什么补丁」，后者是「这些补丁最后保留了还是回滚了」。
 * 分开传是因为一个候选可能产出了补丁却根本没被执行（B 类待人工确认）。
 */
export interface ReportInput {
  run: RunRecord;
  diagnosis: Diagnosis | null;
  candidates?: readonly Candidate[];
  decisions?: readonly Decision[];
  /** 执行结果：产出的 patch（`patch === '' && files.length > 0` 表示二进制改动已写盘） */
  executions?: readonly ExecutionResult[];
  verifications?: readonly Verification[];
}

export interface ReportOutput {
  format: ReportFormat;
  /** 相对于 run 目录的文件名，如 `report.md` */
  filename: string;
  content: string;
}

/**
 * 报告渲染端口。
 *
 * 刻意做成 **纯函数**：输入 RunRecord + Diagnosis，输出字符串。
 * 没有 IO、没有模板引擎运行时。于是 HTML / JSON 报告可以随时加，
 * 且每个格式都能被快照测试钉死。
 */
export interface ReporterPort {
  readonly format: ReportFormat;
  render(input: ReportInput): ReportOutput;
}
