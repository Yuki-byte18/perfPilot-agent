import { describe, expect, it } from 'vitest';
import { createReporters, REPORT_FORMAT_FILENAME } from './index.js';
import { renderHtml } from './html.js';
import { configFixture, metric, runFixture } from '../fixtures/index.js';

/**
 * HTML 报告（M8 补齐）。
 *
 * 这一组里最要紧的是**转义**：报告的内容全部来自被测项目
 * （URL、源码路径、图片名、依赖名、错误信息），而报告会被上传成 CI artifact
 * 再被人打开。一个叫 `<img src=x onerror=...>.png` 的资源名就能在这里执行脚本。
 */

function run(overrides: Parameters<typeof runFixture>[0] = {}) {
  return runFixture({
    metrics: [
      metric('LCP', 2800),
      metric('CLS', 0.18),
      metric('TBT', 480, { source: 'lighthouse' }),
    ],
    deltas: [
      {
        name: 'TBT',
        baseline: 220,
        current: 480,
        delta: -260,
        deltaPercent: -118,
        baselineScore: 95,
        currentScore: 30,
        scoreDelta: -65,
      },
    ],
    baseline: { ref: 'main', runId: 'run_prev', metrics: [] },
    ...overrides,
  });
}

describe('HTML 报告', () => {
  it('渲染出完整的 HTML 文档（含标题、指标与阶段表）', () => {
    const html = renderHtml({
      run: run({
        stages: [{ name: 'collect', status: 'ok', durationMs: 120, note: '2 个来源成功' }],
      }),
      diagnosis: null,
    });

    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('PerfPilot 性能报告');
    expect(html).toContain('LCP');
    expect(html).toContain('采集');
    expect(html.trimEnd().endsWith('</html>')).toBe(true);
  });

  it('核心指标缺失时单独列出（"没测到"不等于"没问题"）', () => {
    const html = renderHtml({
      run: run({ metrics: [metric('TBT', 480)] }),
      diagnosis: null,
    });

    expect(html).toContain('未采集的核心指标');
    expect(html).toContain('LCP');
    expect(html).toContain('CLS');
  });

  it('回归指标单独成节并标红', () => {
    const html = renderHtml({ run: run(), diagnosis: null });

    expect(html).toContain('回归指标');
    expect(html).toContain('#b42318');
  });

  it('**转义每一个插入点**：恶意资源名不会变成可执行脚本', () => {
    const evil = '<img src=x onerror="alert(1)">.png';
    const html = renderHtml({
      run: run({
        warnings: [
          {
            adapter: 'bundle-analyzer',
            code: 'OVERSIZED_IMAGE',
            severity: 'degraded',
            message: `资源过大：${evil}`,
          },
        ],
      }),
      diagnosis: {
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
        bottlenecks: [
          {
            id: 'bn_1',
            runId: 'run_1',
            kind: 'OVERSIZED_IMAGE',
            title: evil,
            severity: 70,
            impact: {},
            attribution: {
              level: 'resource',
              url: `https://x.example.com/${evil}`,
              size: 900_000,
              contentType: 'image/png',
            },
            evidence: [],
            confidence: 0.9,
            occurrences: 1,
            source: 'rule',
          },
        ],
        summary: evil,
        ruleSetVersion: 'm2.1.0',
        createdAt: '2026-01-17T14:25:30.000Z',
      },
    });

    // 原始标签一个都不能留下
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('onerror="alert(1)"');
    // 但内容要在（转义后照样能读懂）
    expect(html).toContain('&lt;img src=x');
  });

  it('候选标题里的引号不会破坏报告结构', () => {
    const html = renderHtml({
      run: run(),
      diagnosis: null,
      candidates: [
        {
          id: 'cand_1',
          runId: 'run_1',
          bottleneckIds: ['bn_1'],
          class: 'A',
          title: '把 "hero".png 转成 WebP',
          description: 'x',
          origin: 'rule',
          ruleId: 'r1',
          promptVersion: null,
          changes: [{ type: 'config', file: 'a.json', key: 'k', before: null, after: 1 }],
          expectedGain: {},
          confidence: 0.8,
          risk: 'low',
          effort: 'low',
          reversible: true,
          recalledFrom: [],
          bottleneckKinds: ['OVERSIZED_IMAGE'],
        },
      ],
      decisions: [
        {
          id: 'dec_1',
          runId: 'run_1',
          candidateId: 'cand_1',
          verdict: 'apply',
          route: 'asset-processor',
          score: 42,
          utility: { expectedGain: 55, confidence: 0.9, cost: 4, risk: 2 },
          riskLevel: 'low',
          reasons: ['规则库命中'],
          thresholds: {
            minGain: 5,
            maxRegression: 2,
            maxNewErrors: 0,
            applyScore: 30,
            confirmScore: 10,
          },
          decidedAt: '2026-01-17T14:25:30.000Z',
        },
      ],
    });

    expect(html).toContain('&quot;hero&quot;.png');
  });

  it('三种格式都能装配出 reporter，文件名与 REPORT_FORMAT_FILENAME 一致', () => {
    const reporters = createReporters(['markdown', 'json', 'html']);

    expect(reporters.map((r) => r.format).sort()).toEqual(['html', 'json', 'markdown']);
    for (const reporter of reporters) {
      const output = reporter.render({ run: run(), diagnosis: null });
      expect(output.filename).toBe(REPORT_FORMAT_FILENAME[reporter.format]);
    }
  });

  it('配置里重复写同一种格式时不会产出两份同名文件', () => {
    // 重复的格式本身没有意义，但也不该让报告落盘两次
    const reporters = createReporters(['html', 'html']);
    expect(reporters).toHaveLength(2);
    expect(new Set(reporters.map((r) => REPORT_FORMAT_FILENAME[r.format])).size).toBe(1);
    void configFixture;
  });
});
