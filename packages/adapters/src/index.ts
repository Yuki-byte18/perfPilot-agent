/**
 * @yuki-byte18/adapters —— 外部工具适配器。
 *
 * 硬约束 2：只依赖 @yuki-byte18/shared（由 eslint.config.js 强制）。
 * 硬约束 5：所有外部工具调用都收敛在这里，core 不得直接调用外部进程。
 *
 * 每个 adapter 拆成两半：
 *   - `*.runner.ts`：与外部世界交互，产出未解释的原始产物（有 IO，不进覆盖率分母）
 *   - `parse.ts`    ：纯函数，原始产物 → 未打分样本（可重放、可快照）
 */

export * from './define-collector.js';
export * from './registry.js';

// 共享的内部工具：导出是为了让 M2 的适配器复用同一套 URL 合成与依赖识别逻辑
export * from './internal/url.js';
export * from './internal/samples.js';
export * from './internal/bundle.js';

export * from './lighthouse/index.js';
export * from './web-vitals/index.js';
export * from './bundle-analyzer/index.js';
export * from './har/index.js';
export * from './trace/index.js';
export * from './source-map/index.js';
export * from './fixtures/source-maps.js';
export * from './executor/index.js';
export * from './git/index.js';
export * from './asset/index.js';
export * from './check-runner/index.js';
export * from './memory/index.js';
export * from './scm/index.js';
