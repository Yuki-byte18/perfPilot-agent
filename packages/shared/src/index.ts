/**
 * @yuki-byte18/shared —— 类型、schema、错误、纯函数工具。
 *
 * 硬约束 10：所有跨包类型必须来自这里。
 * 本包不依赖任何其它 @yuki-byte18 包（由 eslint.config.js 强制）。
 */

// ── 类型 ───────────────────────────────────────────────────────────
export * from './types/common.js';
export * from './types/metric.js';
export * from './types/bottleneck.js';
export * from './types/diagnosis.js';
export * from './types/artifacts.js';
export * from './types/run.js';
export * from './types/config.js';
export * from './types/candidate.js';
export * from './types/decision.js';
export * from './types/verification.js';
export * from './types/trend.js';

// ── schema（硬约束 11：所有外部输入的校验入口）─────────────────────
export * from './schema/parse.js';
export * from './schema/metric.js';
export * from './schema/bottleneck.js';
export * from './schema/diagnosis.js';
export * from './schema/artifacts.js';
export * from './schema/run.js';
export * from './schema/config.js';
export * from './schema/candidate.js';
export * from './schema/decision.js';
export * from './schema/verification.js';
export * from './schema/trend.js';

// ── 端口（依赖倒置的接口侧，硬约束 4）─────────────────────────────
export * from './ports/logger.js';
export * from './ports/collector.js';
export * from './ports/source-map.js';
export * from './ports/reporter.js';
export * from './ports/run-store.js';
export * from './ports/llm.js';
export * from './ports/memory.js';
export * from './ports/executor.js';
export * from './ports/scm.js';
export * from './ports/check-runner.js';
export * from './ports/asset.js';
export * from './ports/error-scan.js';

// ── 错误与退出码 ───────────────────────────────────────────────────
export * from './errors/index.js';

// ── 纯函数工具 ─────────────────────────────────────────────────────
export * from './utils/metric.js';
export * from './utils/bottleneck.js';
export * from './utils/format.js';
export * from './utils/id.js';
export * from './utils/text.js';
export * from './utils/candidate.js';
export * from './utils/diff.js';
