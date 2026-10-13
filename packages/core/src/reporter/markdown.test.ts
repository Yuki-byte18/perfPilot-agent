import { describe, expect, it } from 'vitest';
import { computeDeltas, type RunRecord } from '@yuki-byte18/shared';
import { renderMarkdown } from './markdown.js';
import { metric, runFixture } from '../fixtures/index.js';

function withDeltas(run: RunRecord, baselineMetrics: RunRecord['metrics']): RunRecord {
  return {
    ...run,
    baseline: { ref: 'main', runId: 'run_base', metrics: baselineMetrics },
    deltas: computeDeltas(run.metrics, baselineMetrics),
  };
}

describe('renderMarkdown — 结构与元信息', () => {
  it('包含项目、路由、设备、状态、run id 与目标地址', () => {
    const md = renderMarkdown(runFixture({ route: '/dashboard', project: 'shop' }));

    expect(md).toContain('# PerfPilot 性能报告 — shop');
    expect(md).toContain('`/dashboard`');
    expect(md).toContain('`mobile`');
    expect(md).toContain('`success`');
    expect(md).toContain('run_20260117T142530_aaaaaa');
    expect(md).toContain('https://staging.example.com');
  });

  it('无基线时明确说明「不判定改善或回归」', () => {
    const md = renderMarkdown(runFixture());
    expect(md).toContain('无基线可比');
  });
});

describe('renderMarkdown — 指标表', () => {
  it('每个指标一行，含评级图标、分数、基线与来源', () => {
    const run = withDeltas(
      { ...runFixture({ metrics: [metric('LCP', 5000)] }) },
      [metric('LCP', 2000)],
    );
    const md = renderMarkdown(run);

    expect(md).toContain('🔴 LCP');
    expect(md).toContain('| 指标 | 当前 | 评级 | 分数 | 基线 | Δ | Δ% | 分数变化 | 来源 |');
    expect(md).toContain('`lighthouse`');
    expect(md).toContain('2000 ms');
  });

  it('回归指标单独成节并置顶（CI 里只扫一眼也要看到）', () => {
    const run = withDeltas(
      { ...runFixture({ metrics: [metric('LCP', 5000), metric('CLS', 0.05)] }) },
      [metric('LCP', 2000), metric('CLS', 0.2)],
    );
    const md = renderMarkdown(run);

    const regressionIndex = md.indexOf('## ⚠️ 回归指标');
    const tableIndex = md.indexOf('## 指标');
    expect(regressionIndex).toBeGreaterThan(-1);
    expect(regressionIndex).toBeLessThan(tableIndex);
    expect(md).toContain('| **LCP** |');
    expect(md).not.toContain('| **CLS** |');
  });

  it('无回归时不渲染回归节', () => {
    const run = withDeltas(
      { ...runFixture({ metrics: [metric('LCP', 1500)] }) },
      [metric('LCP', 3000)],
    );
    expect(renderMarkdown(run)).not.toContain('## ⚠️ 回归指标');
  });

  it('改善与回归的数量统计写进结论行', () => {
    const run = withDeltas(
      { ...runFixture({ metrics: [metric('LCP', 5000), metric('CLS', 0.05)] }) },
      [metric('LCP', 2000), metric('CLS', 0.2)],
    );
    const md = renderMarkdown(run);

    expect(md).toContain('2 项指标与基线可比');
    expect(md).toContain('**1 项改善**');
    expect(md).toContain('**1 项回归**');
  });

  it('指标按名称排序，report diff 稳定', () => {
    const run = runFixture({ metrics: [metric('TBT', 300), metric('CLS', 0.1), metric('LCP', 2000)] });
    const md = renderMarkdown(run);
    const order = ['CLS', 'LCP', 'TBT'].map((n) => md.indexOf(`${n}`));
    expect(order[0]).toBeLessThan(order[1] as number);
    expect(order[1]).toBeLessThan(order[2] as number);
  });

  it('零指标时给出明确说明而不是空表', () => {
    const md = renderMarkdown(runFixture({ metrics: [] }));
    expect(md).toContain('本次运行未采集到任何指标');
  });
});

describe('renderMarkdown — 诚实性', () => {
  it('缺失的核心指标单独成节，并明说「不代表正常」', () => {
    const md = renderMarkdown(
      runFixture({ metrics: [metric('LCP', 2000), metric('CLS', 0.1)] }),
    );

    expect(md).toContain('## ❓ 未采集的核心指标');
    expect(md).toContain('**INP**');
    expect(md).toContain('不代表「正常」');
  });

  it('核心指标齐全时不渲染缺失节', () => {
    const md = renderMarkdown(
      runFixture({ metrics: [metric('LCP', 2000), metric('CLS', 0.1), metric('INP', 150)] }),
    );
    expect(md).not.toContain('未采集的核心指标');
  });
});

describe('renderMarkdown — 告警与阶段', () => {
  it('告警表包含级别、适配器、代码与说明', () => {
    const run = runFixture();
    const md = renderMarkdown({
      ...run,
      warnings: [
        {
          adapter: 'web-vitals',
          code: 'ADAPTER_UNAVAILABLE',
          severity: 'degraded',
          message: '上报文件不存在',
        },
      ],
    });

    expect(md).toContain('## ⚡ 采集告警');
    expect(md).toContain('`ADAPTER_UNAVAILABLE`');
    expect(md).toContain('上报文件不存在');
    expect(md).toContain('⚠️ degraded');
  });

  it('info 级告警与 degraded 级在报告里可区分（前者不代表数据缺失）', () => {
    const run = runFixture();
    const md = renderMarkdown({
      ...run,
      warnings: [
        {
          adapter: 'lighthouse',
          code: 'METRIC_SOURCE_FALLBACK',
          severity: 'info',
          message: 'IMAGE_SIZE 本次来源为 lighthouse',
        },
      ],
    });

    expect(md).toContain('ℹ️ info');
    expect(md).not.toContain('⚠️ degraded');
  });

  it('无告警时不渲染告警节', () => {
    expect(renderMarkdown(runFixture())).not.toContain('## ⚡ 采集告警');
  });

  it('阶段表反映真实进度：已实现的 ok，未实现的 skipped 并写明里程碑', () => {
    const run = runFixture();
    const md = renderMarkdown({
      ...run,
      stages: [
        { name: 'collect', status: 'ok', durationMs: 1200, note: '3 个来源成功' },
        { name: 'compare', status: 'ok', durationMs: 4, note: null },
        { name: 'diagnose', status: 'skipped', durationMs: 0, note: '本次运行未启用该阶段' },
      ],
    });

    expect(md).toContain('| collect | ✅ ok |');
    expect(md).toContain('| diagnose | ⏭️ skipped |');
    expect(md).toContain('本次运行未启用该阶段');
  });

  it('备注里的竖线被转义，不会截断表格', () => {
    const run = runFixture();
    const md = renderMarkdown({
      ...run,
      stages: [{ name: 'collect', status: 'ok', durationMs: 1, note: 'a | b' }],
    });

    expect(md).toContain('a \\| b');
  });

  it('页脚给出 run 与原始数据位置', () => {
    const md = renderMarkdown(runFixture());
    expect(md).toContain('.perfpilot/runs/run_20260117T142530_aaaaaa/run.json');
  });
});
