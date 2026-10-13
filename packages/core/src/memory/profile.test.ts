import { describe, expect, it } from 'vitest';
import type { RawArtifact } from '@yuki-byte18/shared';
import { describeDrift, detectBaselineDrift, inferProjectProfile } from './profile.js';
import { metric } from '../fixtures/index.js';

/**
 * 项目画像推断（M6）。
 *
 * 这个模块存在的理由很具体：**在 M6 之前 `techStack` 恒为 `'unknown'`**，
 * 于是三条召回路径里的「按技术栈召回」永远召不回任何东西 ——
 * 一条写了、测了、但实际是死的路径。
 */

function scanArtifact(packageJson: unknown): RawArtifact {
  return {
    adapter: 'bundle-analyzer',
    kind: 'bundle-scan',
    payload: { distDir: 'dist', source: 'scan', files: [], modules: [], packageJson },
    collectedAt: '2026-01-17T14:25:30.000Z',
    route: '/',
    device: 'mobile',
    file: null,
  };
}

const infer = (packageJson: unknown, techStack?: string) =>
  inferProjectProfile({
    project: 'demo',
    artifacts: packageJson === null ? [] : [scanArtifact(packageJson)],
    metrics: [metric('LCP', 2800)],
    ...(techStack !== undefined ? { techStack } : {}),
    now: () => new Date('2026-01-17T14:25:30.000Z'),
  });

describe('M6 — 项目画像推断', () => {
  it('从 package.json 推断出框架 + 构建工具作为技术栈', () => {
    const profile = infer({
      name: 'demo',
      dependencies: { react: '^18.0.0' },
      devDependencies: { vite: '^5.0.0' },
    });

    expect(profile?.techStack).toBe('vite+react');
    expect(profile?.framework).toBe('react');
    expect(profile?.buildTool).toBe('vite');
    // 本次指标一并写进画像，作为后续运行的参考
    expect(profile?.baselineMetrics).toEqual({ LCP: 2800 });
  });

  it('next 内含 react，必须先判 next（否则技术栈永远是 react）', () => {
    const profile = infer({
      name: 'demo',
      dependencies: { next: '^14.0.0', react: '^18.0.0' },
      devDependencies: {},
    });

    expect(profile?.framework).toBe('next');
    expect(profile?.techStack).toBe('next+next');
  });

  it('拿不到 package.json 时返回 null，不编造画像', () => {
    // 编一个 'unknown' 的画像存进库，会让"按技术栈召回"在错误的维度上匹配
    expect(infer(null)).toBeNull();
  });

  it('显式指定技术栈时优先用它', () => {
    const profile = infer({ name: 'demo', dependencies: {}, devDependencies: {} }, 'custom-stack');
    expect(profile?.techStack).toBe('custom-stack');
  });

  it('识别不出框架时技术栈为 unknown，而不是空串', () => {
    const profile = infer({ name: 'demo', dependencies: { lodash: '^4' }, devDependencies: {} });

    expect(profile?.framework).toBe('');
    expect(profile?.techStack).toBe('unknown');
  });

  it('package.json 快照结构不对时整条产物被拒，不崩也不猜', () => {
    // `dependencies: 'oops'` 过不了 BundleScanPayloadSchema，
    // 于是这份产物不可信 → 推断不出画像（null），而不是拿半份数据去猜
    expect(infer({ name: 'demo', dependencies: 'oops', devDependencies: null })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
// 基线漂移
// ─────────────────────────────────────────────────────────────────────

/**
 * 门禁判的是**本次改动相对上次**的差值。项目整体缓慢劣化时，
 * 每次都在阈值内 —— 门禁一路绿灯，而三个月后 LCP 翻倍。
 * 这一组验的是"基线自己漂了"这件事会被说出来。
 */
describe('M6 — 基线漂移检测', () => {
  const previous = (metrics: Record<string, number>) => ({
    project: 'demo',
    techStack: 'vite+react',
    buildTool: 'vite',
    framework: 'react',
    baselineMetrics: metrics,
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  it('超过阈值（10%）的变化被检出，并算出方向', () => {
    const drifts = detectBaselineDrift(previous({ LCP: 2000 }), [metric('LCP', 2600)]);

    expect(drifts).toHaveLength(1);
    expect(drifts[0]).toMatchObject({ name: 'LCP', previous: 2000, current: 2600 });
    // +30%：劣化
    expect(drifts[0]?.changePercent).toBeCloseTo(30, 1);
  });

  it('抖动幅度内（< 10%）不报 —— 报出来只会稀释真正重要的告警', () => {
    // 同一份代码两次跑差 3%-5% 很常见
    expect(detectBaselineDrift(previous({ LCP: 2000 }), [metric('LCP', 2060)])).toEqual([]);
  });

  it('改善同样算漂移（基线变好了也是变化）', () => {
    const drifts = detectBaselineDrift(previous({ LCP: 3000 }), [metric('LCP', 2000)]);

    expect(drifts[0]?.changePercent).toBeLessThan(0);
  });

  it('第一次运行没有画像 → 不报漂移', () => {
    expect(detectBaselineDrift(null, [metric('LCP', 3000)])).toEqual([]);
  });

  it('画像里没有的指标不参与比较（新指标没有"漂移"可言）', () => {
    expect(detectBaselineDrift(previous({ LCP: 2000 }), [metric('INP', 500)])).toEqual([]);
  });

  it('基数为 0 时跳过（除零会得到 Infinity%）', () => {
    expect(detectBaselineDrift(previous({ DUPLICATE_DEPS: 0 }), [metric('DUPLICATE_DEPS', 5)])).toEqual(
      [],
    );
  });

  it('多条漂移按幅度降序（报告只显示前几条时先看到最严重的）', () => {
    const drifts = detectBaselineDrift(previous({ LCP: 2000, CLS: 0.1 }), [
      metric('LCP', 2200), // +10%
      metric('CLS', 0.5), // +400%
    ]);

    expect(drifts.map((d) => d.name)).toEqual(['CLS', 'LCP']);
  });

  it('告警文案能独立看懂（含"这与本次改动无关"的说明）', () => {
    const text = describeDrift(detectBaselineDrift(previous({ LCP: 2000 }), [metric('LCP', 3000)]));

    expect(text).toContain('基线漂移');
    expect(text).toContain('LCP 2000 → 3000');
    expect(text).toContain('+50%');
    // 这句话很关键：否则读者会把它当成"这次改动造成的"
    expect(text).toContain('与本次改动的收益无关');
  });
});
