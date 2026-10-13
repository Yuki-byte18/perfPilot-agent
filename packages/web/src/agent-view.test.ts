import { describe, expect, it } from 'vitest';
import type { Bottleneck, Candidate, Decision } from '@yuki-byte18/shared';
import { buildAgentView } from './data.js';
import type { RunDetail } from './api.js';

/**
 * 「诊断 agent 这一轮做了什么」的推导。
 *
 * 这一组盯着一个**约定**：LLM 新提出的瓶颈 id 一律是 `bn_llm_*`（由
 * `core/diagnoser/agent.ts` 生成），而被 agent 复核改写的规则结论会**保留原 id**。
 * 因此"`source` 是 llm、但 id 不是 `bn_llm_` 前缀"就等于"这条是复核"。
 *
 * 约定一旦被改（比如 core 换了 id 前缀），报告页会把**新发现**误报成**复核** ——
 * 数字看着都正常，只是含义反了。所以这里把它钉住。
 */

const bottleneck = (id: string, source: Bottleneck['source'], title = '瓶颈'): Bottleneck => ({
  id,
  runId: 'run_1',
  kind: 'LARGE_JS_BUNDLE',
  title,
  severity: 60,
  impact: { JS_SIZE: 120 },
  attribution: { level: 'dependency', name: 'lodash-es', version: null, size: 70000 },
  evidence: [{ kind: 'bundle-chunk', payload: {}, description: '某个 chunk 有 700KB' }],
  confidence: 0.6,
  occurrences: 1,
  source,
});

const candidate = (id: string, origin: Candidate['origin']): Candidate => ({
  id,
  runId: 'run_1',
  bottleneckIds: ['bn_1'],
  class: 'A',
  title: `方案 ${id}`,
  description: '说明',
  origin,
  ruleId: origin === 'rule' ? 'r1' : null,
  promptVersion: origin === 'llm' ? 'm3.1.0' : null,
  changes: [{ type: 'config', file: 'a.json', key: 'k', before: null, after: 1 }],
  expectedGain: {},
  confidence: 0.8,
  risk: 'low',
  effort: 'low',
  reversible: true,
  recalledFrom: [],
  bottleneckKinds: ['LARGE_JS_BUNDLE'],
});

const decision = (candidateId: string, verdict: Decision['verdict']): Decision => ({
  id: `dec_${candidateId}`,
  runId: 'run_1',
  candidateId,
  verdict,
  route: 'config-editor',
  score: 42,
  utility: { expectedGain: 55, confidence: 0.9, cost: 4, risk: 2 },
  riskLevel: 'low',
  reasons: ['规则库命中'],
  thresholds: { minGain: 5, maxRegression: 2, maxNewErrors: 0, applyScore: 30, confirmScore: 10 },
  decidedAt: '2026-01-17T14:25:30.000Z',
});

const detail = (parts: {
  bottlenecks?: Bottleneck[];
  candidates?: Candidate[];
  decisions?: Decision[];
  llmCostUsd?: number;
}): RunDetail => ({
  run: {
    schemaVersion: 1,
    id: 'run_1',
    project: 'demo',
    route: '/',
    device: 'mobile',
    url: 'https://staging.example.com',
    status: 'success',
    startedAt: '2026-01-17T14:25:30.000Z',
    finishedAt: '2026-01-17T14:25:31.000Z',
    durationMs: 1000,
    perfpilotVersion: '0.1.0',
    stages: [],
    metrics: [],
    baseline: null,
    deltas: [],
    warnings: [],
    artifacts: [],
    llmCostUsd: parts.llmCostUsd ?? 0,
  },
  diagnosis:
    parts.bottlenecks === undefined
      ? null
      : {
          id: 'diag_1',
          runId: 'run_1',
          project: 'demo',
          route: '/',
          device: 'mobile',
          baselineRef: null,
          metrics: [],
          baselineMetrics: [],
          deltas: [],
          regressions: [],
          bottlenecks: parts.bottlenecks,
          summary: '摘要',
          ruleSetVersion: 'r1',
          createdAt: '2026-01-17T14:25:30.000Z',
        },
  candidates: parts.candidates ?? [],
  decisions: parts.decisions ?? [],
  executions: [],
  verifications: [],
});

describe('buildAgentView', () => {
  it('没开 LLM 时不假装有产出：ran=false，一条结论都没有', () => {
    const view = buildAgentView(
      detail({ bottlenecks: [bottleneck('bn_1', 'rule')], candidates: [candidate('cand_1', 'rule')] }),
    );

    expect(view.ran).toBe(false);
    expect(view.findings).toEqual([]);
    expect(view.candidateFromLlm).toBe(0);
    expect(view.costUsd).toBe(0);
  });

  it('区分「新发现」与「复核规则结论」—— 靠 bn_llm_ 前缀，不靠猜', () => {
    const view = buildAgentView(
      detail({
        bottlenecks: [
          bottleneck('bn_1', 'rule'),
          bottleneck('bn_llm_run_1_0', 'llm', 'agent 补出来的问题'),
          bottleneck('bn_1', 'llm', '规则提过、agent 把归因写具体了'),
        ],
        llmCostUsd: 0.0074,
      }),
    );

    expect(view.ran).toBe(true);
    expect(view.bottleneckTotal).toBe(3);
    expect(view.findings).toHaveLength(2);
    expect(view.newCount).toBe(1);
    expect(view.refinedCount).toBe(1);

    const refined = view.findings.find((f) => f.refined);
    expect(refined?.refinesId).toBe('bn_1');
    expect(refined?.title).toBe('规则提过、agent 把归因写具体了');

    // 新发现的那条不该被算成复核
    expect(view.findings.find((f) => f.title === 'agent 补出来的问题')?.refined).toBe(false);
  });

  it('统计 agent 候选的去向与花费（只算 LLM 来源的候选）', () => {
    const view = buildAgentView(
      detail({
        candidates: [candidate('cand_rule', 'rule'), candidate('cand_llm_1', 'llm'), candidate('cand_llm_2', 'llm')],
        decisions: [
          decision('cand_rule', 'apply'),
          decision('cand_llm_1', 'apply'),
          decision('cand_llm_2', 'reject'),
        ],
        llmCostUsd: 0.0074,
      }),
    );

    expect(view.candidateTotal).toBe(3);
    expect(view.candidateFromLlm).toBe(2);
    expect(view.verdicts).toEqual([
      { verdict: 'apply', count: 1 },
      { verdict: 'reject', count: 1 },
    ]);
    expect(view.costUsd).toBeCloseTo(0.0074);
  });

  it('候选没有裁决时不编造去向（规划之后就断了的情况）', () => {
    const view = buildAgentView(detail({ candidates: [candidate('cand_llm_1', 'llm')] }));

    expect(view.candidateFromLlm).toBe(1);
    expect(view.verdicts).toEqual([]);
  });

  it('prompt 版本去重后列出，null 不出现', () => {
    const withVersion = { ...candidate('cand_llm_1', 'llm'), promptVersion: 'm3.1.0' };
    const other = { ...candidate('cand_llm_2', 'llm'), promptVersion: 'm3.2.0' };
    const noVersion = { ...candidate('cand_llm_3', 'llm'), promptVersion: null };

    const view = buildAgentView(detail({ candidates: [withVersion, other, noVersion] }));

    expect(view.promptVersions).toEqual(['m3.1.0', 'm3.2.0']);
  });

  it('只花了钱、没产出结论时也算"用过 LLM"（否则会读成"没开"）', () => {
    const view = buildAgentView(detail({ llmCostUsd: 0.0031 }));

    expect(view.ran).toBe(true);
    expect(view.findings).toEqual([]);
    expect(view.costUsd).toBeCloseTo(0.0031);
  });
});
