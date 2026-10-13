import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Bottleneck, Candidate, Decision, Metric, Verification } from '@yuki-byte18/shared';
import type { RunDetail } from './api.js';
import { DiagnosisView, MetricsView, OptimizationView, OverviewView, TrendsView } from './views.js';
import { toTrendViews } from './data.js';

/**
 * 区块渲染测试（服务端渲染成字符串）。
 *
 * 这一组防的是**真实数据下的崩溃与沉默**：
 * 报告页拿到的 JSON 是"别人写下来的"，字段可能缺失（早期版本落盘的记录、
 * 手改过的文件），一个 `undefined.toFixed()` 会让整页白屏 ——
 * 而白屏比"少显示一行"糟糕得多。
 *
 * 用 `renderToStaticMarkup` 而不是 jsdom + testing-library：这里要验的是
 * "给定这份数据能不能渲染出该有的东西"，字符串断言就够，
 * 少两个依赖（jsdom 的依赖树有几十个包）。
 */

const metric = (name: Metric['name'], value: number, unit: Metric['unit'] = 'ms'): Metric => ({
  name,
  value,
  unit,
  rating: value > 4000 ? 'poor' : value > 2500 ? 'needs-improvement' : 'good',
  score: value > 4000 ? 30 : value > 2500 ? 70 : 100,
  route: '/',
  device: 'mobile',
  source: 'lighthouse',
  collectedAt: '2026-01-17T14:25:30.000Z',
});

const bottleneck: Bottleneck = {
  id: 'bn_1',
  runId: 'run_1',
  kind: 'LARGE_JS_BUNDLE',
  title: 'index-abc.js 达 676KB',
  severity: 47,
  impact: { JS_SIZE: 436_506, TBT: 22 },
  attribution: {
    level: 'resource',
    url: 'https://staging.example.com/assets/index-abc.js',
    size: 692_506,
    contentType: 'application/javascript',
  },
  evidence: [
    { kind: 'bundle-chunk', payload: { path: 'assets/index-abc.js' }, description: '构建产物体积' },
  ],
  confidence: 0.9,
  occurrences: 1,
  source: 'rule',
};

const applied: Candidate = {
  id: 'cand_a',
  runId: 'run_1',
  bottleneckIds: ['bn_1'],
  class: 'A',
  title: '压缩首屏图片',
  description: '原图 1.2MB，压缩后约 180KB',
  origin: 'rule',
  ruleId: 'compress-image',
  promptVersion: null,
  changes: [{ type: 'asset', file: 'public/hero.jpg', operation: 'compress', params: { quality: 80 } }],
  expectedGain: { IMAGE_SIZE: 1_000_000 },
  confidence: 0.9,
  risk: 'low',
  effort: 'low',
  reversible: true,
  recalledFrom: [],
  bottleneckKinds: ['OVERSIZED_IMAGE'],
};

const decision: Decision = {
  id: 'dec_a',
  runId: 'run_1',
  candidateId: 'cand_a',
  verdict: 'apply',
  route: 'asset-processor',
  score: 72.5,
  utility: { expectedGain: 88, confidence: 0.9, cost: 3, risk: 2 },
  riskLevel: 'low',
  reasons: ['utility=72.5（apply ≥ 30，confirm ≥ 10）', 'A 类且分数达标，全自动执行'],
  thresholds: { minGain: 5, maxRegression: 2, maxNewErrors: 0, applyScore: 30, confirmScore: 10 },
  decidedAt: '2026-01-17T14:25:30.000Z',
};

const verification: Verification = {
  id: 'ver_a',
  runId: 'run_1',
  candidateId: 'cand_a',
  status: 'kept',
  route: 'asset-processor',
  checks: [
    { kind: 'build', passed: true, skipped: false, durationMs: 12_000, output: null },
    { kind: 'unit-test', passed: false, skipped: true, durationMs: 0, output: '项目没有 test 脚本' },
  ],
  deltas: [],
  gain: { IMAGE_SIZE: -1_010_000 },
  regressions: [],
  newErrors: [],
  gate: { passed: true, gainOk: true, regressionOk: true, errorsOk: true, failedRules: [] },
  patchRef: 'patches/cand_a.patch',
  git: { baseRef: 'abc12345deadbeef', resultRef: 'fedcba9876543210', reverted: false },
  decidedBy: 'auto',
  verifiedAt: '2026-01-17T14:25:45.000Z',
};

/** 一份"什么都有"的运行记录：诊断 / 候选 / 决策 / 执行 / 验证全齐 */
function richDetail(): RunDetail {
  return {
    run: {
      schemaVersion: 1,
      id: 'run_1',
      project: 'demo-shop',
      route: '/',
      device: 'mobile',
      url: 'https://staging.example.com',
      status: 'partial',
      startedAt: '2026-01-17T14:25:30.000Z',
      finishedAt: '2026-01-17T14:26:40.000Z',
      durationMs: 70_000,
      perfpilotVersion: '0.1.0',
      stages: [
        { name: 'collect', status: 'ok', durationMs: 69_000, note: '2 个来源成功 / 0 个失败' },
        { name: 'verify', status: 'skipped', durationMs: 0, note: '工作区不干净，拒绝自动应用改动' },
      ],
      metrics: [metric('LCP', 3477), metric('CLS', 0.05, 'score'), metric('JS_SIZE', 693_872, 'byte')],
      baseline: { ref: 'last-run', runId: 'run_prev', metrics: [metric('LCP', 3000)] },
      deltas: [
        {
          name: 'LCP',
          baseline: 3000,
          current: 3477,
          delta: 477,
          deltaPercent: 15.9,
          baselineScore: 90,
          currentScore: 70,
          scoreDelta: -20,
        },
      ],
      warnings: [
        {
          adapter: 'lighthouse',
          code: 'ADAPTER_UNAVAILABLE',
          severity: 'degraded',
          message: 'lighthouse 不可用',
        },
      ],
      artifacts: [{ adapter: 'bundle-analyzer', kind: 'bundle-scan', file: 'artifacts/bundle.json' }],
      llmCostUsd: 0.0234,
    },
    diagnosis: {
      id: 'diag_1',
      runId: 'run_1',
      project: 'demo-shop',
      route: '/',
      device: 'mobile',
      baselineRef: 'last-run',
      metrics: [],
      baselineMetrics: [],
      deltas: [],
      regressions: [],
      bottlenecks: [bottleneck],
      summary: '发现 1 个瓶颈；首要问题：LARGE_JS_BUNDLE。',
      ruleSetVersion: 'm2.1.0',
      createdAt: '2026-01-17T14:25:30.000Z',
    },
    candidates: [applied],
    decisions: [decision],
    executions: [
      {
        candidateId: 'cand_a',
        route: 'asset-processor',
        patch: '--- a/public/hero.jpg\n+++ b/public/hero.jpg\n（二进制改动，见产物）\n',
        applied: true,
        files: ['public/hero.jpg'],
        summary: '压缩后节省 1.0 MB',
      },
    ],
    verifications: [verification],
  };
}

const emptyDetail = (): RunDetail => ({
  ...richDetail(),
  run: {
    ...richDetail().run,
    status: 'failed',
    metrics: [],
    deltas: [],
    baseline: null,
    warnings: [],
    artifacts: [],
    stages: [],
  },
  diagnosis: null,
  candidates: [],
  decisions: [],
  executions: [],
  verifications: [],
});

const render = (node: JSX.Element): string => renderToStaticMarkup(node);

describe('总览区块', () => {
  it('把结论、统计、阶段、来源、告警都渲染出来', () => {
    const html = render(<OverviewView detail={richDetail()} />);

    // 结论句 + 分组统计（标签是人话版，不再出现"回归 / 采集指标 / 待人工确认"这些术语）
    expect(html).toContain('headline');
    expect(html).toContain('测到的指标');
    expect(html).toContain('比上次变差的');
    expect(html).toContain('等你点头');
    // 运行模式横幅：看懂报告的第一步
    expect(html).toContain('runmode');
    // 阶段备注原样带出（verify skipped 的原因必须可见）
    expect(html).toContain('工作区不干净，拒绝自动应用改动');
    // 来源清单
    expect(html).toContain('lighthouse');
    expect(html).toContain('已采集');
    // 告警
    expect(html).toContain('ADAPTER_UNAVAILABLE');
  });

  it('零指标的运行不会崩，也不会说成"没问题"', () => {
    const html = render(<OverviewView detail={emptyDetail()} />);

    // 语气必须落在"没测到"上，而不是"一切正常"
    expect(html).toContain('headline-bad');
    expect(html).toContain('没采到');
    expect(html).toContain('不代表页面没问题');
    // 而且必须把"数据是谁给的"摆出来 —— 零指标时这是最该看的一块
    expect(html).toContain('数据来源');
  });
});

describe('指标区块', () => {
  it('当前值、基线、变化、分数、评级、来源都在表里', () => {
    const html = render(<MetricsView detail={richDetail()} />);

    expect(html).toContain('LCP');
    expect(html).toContain('3.48 s'); // 当前值按单位格式化
    expect(html).toContain('3.00 s'); // 基线
    expect(html).toContain('劣化');
    expect(html).toContain('scorebar');
    expect(html).toContain('677.6 KB'); // JS_SIZE 按 byte 单位
    expect(html).toContain('lighthouse');
  });

  it('一条指标都没有时给出"没测到"的说明，而不是空表', () => {
    const html = render(<MetricsView detail={emptyDetail()} />);

    expect(html).toContain('一条指标都没采到');
  });
});

describe('诊断区块', () => {
  it('瓶颈的标题、归因、影响量、证据与关联候选都渲染出来', () => {
    const html = render(<DiagnosisView detail={richDetail()} />);

    expect(html).toContain('index-abc.js 达 676KB');
    expect(html).toContain('LARGE_JS_BUNDLE');
    expect(html).toContain('assets/index-abc.js'); // 归因
    expect(html).toContain('426.3 KB'); // 影响量按指标单位格式化
    expect(html).toContain('bundle-chunk'); // 证据
    expect(html).toContain('压缩首屏图片'); // 关联候选
  });

  it('没有诊断记录时说清楚原因', () => {
    const html = render(<DiagnosisView detail={emptyDetail()} />);

    expect(html).toContain('没有诊断记录');
  });
});

describe('优化区块', () => {
  it('候选 → 决策 → 执行 → 验证的全链路都能看到（含补丁正文）', () => {
    const html = render(<OptimizationView detail={richDetail()} />);

    expect(html).toContain('压缩首屏图片');
    expect(html).toContain('已保留');
    expect(html).toContain('A 类且分数达标，全自动执行'); // 决策理由
    expect(html).toContain('public/hero.jpg'); // 要改什么
    expect(html).toContain('asset'); // 改动类型
    expect(html).toContain('压缩后节省 1.0 MB'); // 执行器的自述
    expect(html).toContain('build'); // 验证跑过的检查
    expect(html).toContain('跳过'); // unit-test 被跳过（而不是"通过"）
  });

  it('没有候选时说明可能是"没有已知修法"', () => {
    const html = render(<OptimizationView detail={emptyDetail()} />);

    expect(html).toContain('没有产出候选方案');
  });
});

describe('趋势区块', () => {
  it('有历史时画出折线并给出最低/最高', () => {
    const trends = toTrendViews([
      {
        name: 'LCP',
        points: [
          { runId: 'a', startedAt: '2026-01-17T10:00:00.000Z', value: 3500, score: 67, rating: 'needs-improvement', source: 'lighthouse' },
          { runId: 'b', startedAt: '2026-01-18T10:00:00.000Z', value: 2000, score: 100, rating: 'good', source: 'lighthouse' },
        ],
        change: -1500,
        changePercent: -42.86,
        sourceChanged: false,
        enoughData: true,
      },
    ]);

    const html = render(<TrendsView trends={trends} error={null} />);

    expect(html).toContain('sparkline');
    expect(html).toContain('2.00 s'); // 最新值
    expect(html).toContain('改善');
    expect(html).toContain('最低');
    expect(html).toContain('2 个数据点');
  });

  it('拿不到历史时说"加载失败"，而不是画一条假的持平线', () => {
    const html = render(<TrendsView trends={[]} error="网络不可达" />);

    expect(html).toContain('网络不可达');
    expect(html).not.toContain('sparkline');
  });
});
