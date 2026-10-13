import { describe, expect, it } from 'vitest';
import type { Bottleneck, LlmFinding, TracePayload } from '@yuki-byte18/shared';
import { MAX_NEW_FINDINGS, buildEvidence, mergeFindings } from './agent.js';

/**
 * 诊断 agent 的合并策略与证据摘要。
 *
 * 只测**会改变结论对错**的几条：复核是否落到同一条上、重复是否被丢掉、
 * 是否限量、摘要里有没有带得动归因的东西。
 */

function rule(): Bottleneck {
  return {
    id: 'bn_rule1',
    runId: 'run_1',
    kind: 'LARGE_JS_BUNDLE',
    title: 'index.js 达 676KB',
    severity: 47,
    impact: { JS_SIZE: 436_506 },
    attribution: {
      level: 'resource',
      url: 'assets/index.js',
      size: 692_506,
      contentType: 'application/javascript',
    },
    evidence: [{ kind: 'bundle-chunk', payload: {}, description: '构建产物 692506 字节' }],
    confidence: 0.9,
    occurrences: 1,
    source: 'rule',
  };
}

function llm(overrides: Partial<Bottleneck> = {}, refines: string | null = null): LlmFinding {
  return {
    bottleneck: {
      id: 'bn_llm_run_1_0',
      runId: 'run_1',
      kind: 'LONG_MAIN_THREAD_TASK',
      title: '第三方 SDK 加载期间出现 320ms 长任务',
      severity: 62,
      impact: { TBT: 270 },
      attribution: {
        level: 'resource',
        url: 'https://cdn.example.com/sdk.js',
        size: 240_000,
        contentType: 'application/javascript',
      },
      evidence: [{ kind: 'trace-event', payload: {}, description: 'trace 里最长任务 320ms' }],
      confidence: 0.7,
      occurrences: 1,
      source: 'llm',
      ...overrides,
    },
    refines,
  };
}

const at = (url: string): Bottleneck['attribution'] => ({
  level: 'resource',
  url,
  size: 1000,
  contentType: 'application/javascript',
});

describe('mergeFindings', () => {
  it('复核命中规则结论 → 覆盖归因与严重度，但保留它的身份与证据', () => {
    const target = rule();
    const outcome = mergeFindings(
      [target],
      [
        llm(
          {
            kind: 'LARGE_JS_BUNDLE',
            severity: 71,
            attribution: { level: 'source', file: 'src/charts/index.ts', line: 12, column: null, component: null },
          },
          target.id,
        ),
      ],
    );

    // 同一件事不能变成两条
    expect(outcome.bottlenecks).toHaveLength(1);
    const merged = outcome.bottlenecks[0];
    expect(merged?.id).toBe(target.id);
    expect(merged?.severity).toBe(71);
    expect(merged?.attribution.level).toBe('source');
    expect(merged?.source).toBe('llm');
    // 证据合并而非替换
    expect(merged?.evidence).toHaveLength(2);
  });

  it('同种类 + 同归因视为重复丢弃；不同种类不算重复', () => {
    const target = rule();
    const dup = mergeFindings([target], [llm({ kind: target.kind, attribution: target.attribution })]);
    expect(dup.bottlenecks).toHaveLength(1);
    expect(dup.dropped[0]?.reason).toContain('重复');

    const notDup = mergeFindings([target], [llm({ kind: 'NO_COMPRESSION', attribution: target.attribution })]);
    expect(notDup.bottlenecks).toHaveLength(2);
  });

  it('新增结论限量，按 severity 取前几条', () => {
    const many = Array.from({ length: MAX_NEW_FINDINGS + 2 }, (_, i) =>
      llm({ severity: 30 + i, attribution: at(`https://cdn.example.com/sdk-${i}.js`) }),
    );

    const outcome = mergeFindings([], many);
    expect(outcome.bottlenecks).toHaveLength(MAX_NEW_FINDINGS);
    expect(outcome.bottlenecks[0]?.severity).toBe(30 + MAX_NEW_FINDINGS + 1);
  });
});

describe('buildEvidence', () => {
  it('长任务带上 topFrame，并限量（prompt 体积要可控）', () => {
    const payload: TracePayload = {
      source: 'trace',
      totalMs: 5000,
      eventCount: 900,
      longTasks: Array.from({ length: 20 }, (_, i) => ({
        startMs: i * 100,
        durationMs: 100 + i * 10,
        topFrame: { functionName: `fn${i}`, url: 'https://cdn.example.com/sdk.js', line: 12, column: 3 },
        scriptingMs: 90,
        layoutMs: 5,
        styleMs: 2,
      })),
      totals: { scriptingMs: 1000, layoutMs: 100, styleMs: 50 },
    };

    const evidence = buildEvidence({
      metrics: [],
      deltas: [],
      artifacts: [
        {
          adapter: 'trace',
          kind: 'trace',
          payload,
          collectedAt: '2026-01-17T14:25:30.000Z',
          file: null,
          route: '/',
          device: 'mobile',
        },
      ],
    });

    const trace = evidence.sources['trace'] as {
      longTasks: Array<{ topFrame: { url: string | null } | null }>;
    };
    expect(trace.longTasks).toHaveLength(10);
    // 最长的那条排最前，且带得出"是哪个脚本"
    expect(trace.longTasks[0]?.topFrame?.url).toBe('https://cdn.example.com/sdk.js');
    // 让 LLM 知道哪些数据根本不存在
    expect(evidence.sources['collected']).toEqual([{ adapter: 'trace', kind: 'trace' }]);
  });
});
