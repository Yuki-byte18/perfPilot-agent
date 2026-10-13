import { describe, expect, it } from 'vitest';
import {
  AttributionSchema,
  BOTTLENECK_KINDS,
  EFFORTS,
  EVIDENCE_KINDS,
  LlmCandidateSchema,
  LlmFindingSchema,
  METRIC_NAMES,
  OPTIMIZATION_CLASSES,
  RISK_LEVELS,
} from '@yuki-byte18/shared';
import { LLM_PROMPT_CONTRACT } from './index.js';

/**
 * prompt 里承诺给模型的契约，必须与 schema 一致。
 *
 * ## 为什么要有这一组
 *
 * 第一次真调 LLM（花了真钱）时，模型给出的 11 条结论/候选**全部**被 schema 拒掉：
 *
 * - 它编了个 `kind: "IMAGE_SIZE"` —— 因为 prompt 只说"必须是给定枚举值之一"，
 *   却**从没给出枚举名单**；
 * - 它把 evidence 输出成字符串数组 —— 因为 prompt 的**输入**里就是字符串数组；
 * - 它漏了 `impact`、attribution 里的字段名用错 —— prompt 里没写全。
 *
 * 这类错误的共同点是：**schema 是对的，prompt 说的是另一回事**。
 * 单测只测解析器时看不出来（喂进去的假输出是照 schema 写的），
 * 所以这里换一个角度：直接检查"我们发给模型的那段文字"够不够它做对。
 */

/** discriminated union 的 options 在类型上是元组，取 shape 需要这层转写 */
const attributionOptions = AttributionSchema.options as unknown as Array<{
  shape: Record<string, { value?: unknown }>;
}>;

describe('prompt 契约 ↔ schema', () => {
  it('诊断示例能通过 LlmFindingSchema（含 attribution 的 .strict()）', () => {
    expect(() => LlmFindingSchema.parse(LLM_PROMPT_CONTRACT.diagnoseExample)).not.toThrow();
  });

  it('方案示例能通过 LlmCandidateSchema', () => {
    expect(() => LlmCandidateSchema.parse(LLM_PROMPT_CONTRACT.planExample)).not.toThrow();
  });

  it('示例真的被嵌进 prompt（模型看得到完整形状，而不是只看文字描述）', () => {
    expect(LLM_PROMPT_CONTRACT.diagnose()).toContain('"attribution"');
    expect(LLM_PROMPT_CONTRACT.diagnose()).toContain('"evidence"');
    expect(LLM_PROMPT_CONTRACT.plan()).toContain('"bottleneckIds"');
    expect(LLM_PROMPT_CONTRACT.plan()).toContain('"changes"');
  });

  it('诊断 prompt 逐字列出全部瓶颈种类（真实事故：模型编了个 IMAGE_SIZE）', () => {
    const prompt = LLM_PROMPT_CONTRACT.diagnose();
    expect(BOTTLENECK_KINDS.filter((kind) => !prompt.includes(kind))).toEqual([]);
  });

  it('诊断 prompt 列出证据种类与全部指标名', () => {
    const prompt = LLM_PROMPT_CONTRACT.diagnose();
    expect(EVIDENCE_KINDS.filter((kind) => !prompt.includes(kind))).toEqual([]);
    expect(METRIC_NAMES.filter((name) => !prompt.includes(name))).toEqual([]);
  });

  it('诊断 prompt 列出每个 attribution level 的**全部必填字段**', () => {
    const prompt = LLM_PROMPT_CONTRACT.diagnose();

    for (const option of attributionOptions) {
      const level = String(option.shape['level']?.value ?? '');
      expect(prompt).toContain(level);

      const fields = Object.keys(option.shape).filter((key) => key !== 'level');
      expect({ level, missing: fields.filter((field) => !prompt.includes(field)) }).toEqual({
        level,
        missing: [],
      });
    }
  });

  it('方案 prompt 列出 class / risk / effort 的取值与全部指标名', () => {
    const prompt = LLM_PROMPT_CONTRACT.plan();
    const values = [...OPTIMIZATION_CLASSES, ...RISK_LEVELS, ...EFFORTS, ...METRIC_NAMES];
    expect(values.filter((value) => !prompt.includes(value))).toEqual([]);
  });

  it('两个 prompt 都明确要求"只输出 JSON 数组"', () => {
    expect(LLM_PROMPT_CONTRACT.diagnose()).toContain('只输出 JSON 数组');
    expect(LLM_PROMPT_CONTRACT.plan()).toContain('只输出 JSON 数组');
  });
});
