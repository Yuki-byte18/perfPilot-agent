/**
 * 验证相关的**运行时枚举**。
 *
 * `VerificationCheck` / `GateResult` / `Verification` 这些对象类型由
 * `schema/verification.ts` 用 `z.infer` 反推 —— 原因见 `types/bottleneck.ts`。
 */

/**
 * 验证检查种类（README §2 核心能力「验证」）。
 *
 * 四项全过才保留：单测 + E2E + 重采集 + 收益对比。
 * 另外 build / type-check / lint / error-scan / bundle-size 作为辅助检查。
 *
 * `build` 必须在重采集**之前**跑，这不是顺序偏好而是正确性要求：
 * 采集读的是构建产物（`dist/`）与部署地址，改动落在源码或配置上 ——
 * 不重建就等于拿改动前的产物去评估改动后的代码，收益恒为 0。
 */
/** 由 verifier 真去跑、并且允许用户在配置里裁剪的那几项 */
export const VERIFIABLE_CHECK_KINDS = ['build', 'unit-test', 'type-check', 'lint', 'e2e'] as const;
export type VerifiableCheckKind = (typeof VERIFIABLE_CHECK_KINDS)[number];

export const CHECK_KINDS = [
  ...VERIFIABLE_CHECK_KINDS,
  'recollect',
  'error-scan',
  'bundle-size',
] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];
