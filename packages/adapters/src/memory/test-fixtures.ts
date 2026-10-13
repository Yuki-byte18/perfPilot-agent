import { CandidateSchema, type Candidate } from '@yuki-byte18/shared';

/**
 * 记忆层测试用的候选 fixture。
 *
 * 过一遍 `CandidateSchema`，理由与 core 的 fixture 相同：
 * 手写的对象字面量会随 schema 演进悄悄失效，而失败现场是一句
 * "cannot read property of undefined"，跟真正的原因差着十万八千里。
 */
export function createCandidateFixture(overrides: Partial<Candidate> = {}): Candidate {
  return CandidateSchema.parse({
    id: 'cand_1',
    runId: 'run_1',
    bottleneckIds: ['bn_1'],
    class: 'A',
    title: '将 hero.png 转为 WebP',
    description: '把首屏大图转成 WebP，减少传输体积',
    origin: 'rule',
    ruleId: 'convert-webp',
    promptVersion: null,
    changes: [
      { type: 'asset', file: 'assets/hero.png', operation: 'convert-webp', params: { quality: 80 } },
    ],
    expectedGain: { IMAGE_SIZE: 80_000 },
    confidence: 0.8,
    risk: 'low',
    effort: 'low',
    reversible: true,
    recalledFrom: [],
    bottleneckKinds: ['OVERSIZED_IMAGE'],
    ...overrides,
  });
}
