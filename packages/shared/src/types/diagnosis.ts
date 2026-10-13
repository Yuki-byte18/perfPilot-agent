/**
 * 诊断结论的类型由 `schema/diagnosis.ts` 用 `z.infer` 反推。
 *
 * 保留本文件是为了让 `types/` 目录的结构与 README §4.1 一致，
 * 同时集中说明「为什么 Diagnosis 与 RunRecord 分开」：
 *
 * `RunRecord` 回答「测到了什么」，`Diagnosis` 回答「哪里有问题、为什么」。
 * 同一个 run 可以用更新版本的规则集重跑诊断（诊断只读指标与产物，不重新采集），
 * 因此 `diagnosisId` 与 `runId` 不是一对一 —— 这也是两者分开落盘的原因。
 */
export {};
