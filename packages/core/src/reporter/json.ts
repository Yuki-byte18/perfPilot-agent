import type { ReporterPort } from '@yuki-byte18/shared';

/**
 * JSON 报告：`run.json` + `diagnosis.json` 的合并镜像。
 *
 * 存在的意义是给机器消费（Web 报告页、门禁脚本、下游看板），
 * 因此内容与源文件完全一致，不做任何裁剪 —— 报告页少一个字段就要回头改这里，
 * 不如一次给全。
 *
 * M5 起把 `executions` 与 `verifications` 一并纳入。这两个字段尤其不能省：
 * **回滚记录只存在于验证结果里**，Web 报告页要展示「这次改动被撤销了」，
 * 只能从这里拿。缺了它，一次回滚在 JSON 报告里会彻底隐形。
 */
export function createJsonReporter(): ReporterPort {
  return {
    format: 'json',
    render: ({ run, diagnosis, candidates, decisions, executions, verifications }) => ({
      format: 'json',
      filename: 'report.json',
      content: `${JSON.stringify(
        {
          ...run,
          diagnosis,
          candidates: candidates ?? [],
          decisions: decisions ?? [],
          executions: executions ?? [],
          verifications: verifications ?? [],
        },
        null,
        2,
      )}\n`,
    }),
  };
}
