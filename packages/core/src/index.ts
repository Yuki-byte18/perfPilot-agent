/**
 * @yuki-byte18/core —— 核心引擎。
 *
 * 硬约束 3：只依赖 shared（+ 对 adapters 的 type-only 引用，硬约束 4）。
 * 硬约束 5/6/7：不得直接调用外部进程、网络或 LLM SDK。
 *
 * M1 落地：logger / collector / storage / reporter / pipeline。
 */

export * from './logger/index.js';
export * from './collector/index.js';
export * from './storage/file-run-store.js';
export * from './storage/memory-run-store.js';
export * from './reporter/index.js';
export * from './pipeline/index.js';

/** 版本号由发布流程注入；此处作为默认值，报告里会带上 */
export const CORE_VERSION = '0.1.0';
export * from './diagnoser/index.js';
export * from './planner/index.js';
export * from './llm/index.js';
export * from './decision/index.js';
export * from './executor/index.js';
export * from './verifier/index.js';
export * from './memory/index.js';
export * from './memory/recall.js';
export * from './memory/calibration.js';
export * from './gate/index.js';
export * from './ci/index.js';
export * from './trends/index.js';
