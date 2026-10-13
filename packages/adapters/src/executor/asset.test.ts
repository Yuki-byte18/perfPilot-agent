import { describe, expect, it } from 'vitest';
import { createNullAssetProcessor } from '@yuki-byte18/shared';
import { createAssetProcessorExecutor } from './asset-processor.js';
import { createExecutorRegistry } from './index.js';
import { normalizeQuality } from '../asset/index.js';

/**
 * 资产路径的三个真实缺陷（都在一次通盘审计里发现）。
 *
 * 1. 画质刻度：规划器传 `0.8`，sharp 要 `0-100` → 被夹到 **1**，
 *    图片体积确实降了、门禁确实过了、**图确实糊了**，而报告里看不出来。
 * 2. `convert-webp` 产出的是**新文件而引用没变** → 重新采集测不到任何收益 →
 *    门禁永远回滚。把它标成 A 类（全自动）等于承诺一件做不到的事。
 * 3. B 类候选（待人工确认）不该动工作区：它不进验证，写下的文件没人回滚。
 */

const quality = (value: unknown, fallback = 75): number => normalizeQuality(value, fallback);

describe('画质刻度归一化', () => {
  it('小数按比例处理：0.8 → 80（而不是被 sharp 夹成 1）', () => {
    expect(quality(0.8)).toBe(80);
    expect(quality(0.82)).toBe(82);
    expect(quality(0.01)).toBe(1);
  });

  it('0-100 的整数原样使用', () => {
    expect(quality(80)).toBe(80);
    expect(quality(1)).toBe(100); // 1 是小数比例，不是"画质 1"
    expect(quality(2)).toBe(2);
  });

  it('越界值夹到合法区间，不交给 sharp 去猜', () => {
    expect(quality(0)).toBe(75); // 0 不是合法画质，退回默认
    expect(quality(-5)).toBe(75);
    expect(quality(500)).toBe(100);
  });

  it('非数字退回默认值', () => {
    expect(quality('80')).toBe(75);
    expect(quality(null)).toBe(75);
    expect(quality(undefined, 82)).toBe(82);
    expect(quality(Number.NaN)).toBe(75);
  });
});

// ─────────────────────────────────────────────────────────────────────

/** 记录 writeFile 调用的内存上下文 */
function context(): {
  projectRoot: string;
  files: Map<string, Buffer | string>;
  readFile: (path: string) => Promise<string | null>;
  readBinary: (path: string) => Promise<Uint8Array | null>;
  writeFile: (path: string, content: Buffer | string) => Promise<void>;
} {
  const files = new Map<string, Buffer | string>();
  return {
    projectRoot: '/repo',
    files,
    readFile: async () => null,
    readBinary: async (path) => (path === 'assets/hero.png' ? new Uint8Array([1, 2, 3, 4]) : null),
    writeFile: async (path, content) => {
      files.set(path, content);
    },
  };
}

const candidate = {
  id: 'cand_1',
  runId: 'run_1',
  bottleneckIds: ['bn_1'],
  class: 'A' as const,
  title: '压缩图片',
  description: 'x',
  origin: 'rule' as const,
  ruleId: 'compress-oversized-image',
  promptVersion: null,
  changes: [
    { type: 'asset' as const, file: 'assets/hero.png', operation: 'compress' as const, params: { quality: 80 } },
  ],
  expectedGain: {},
  confidence: 0.8,
  risk: 'low' as const,
  effort: 'low' as const,
  reversible: true,
  recalledFrom: [],
  bottleneckKinds: ['OVERSIZED_IMAGE' as const],
};

describe('资产执行器 — 写不写盘由上下文决定', () => {
  it('注入了 writeFile 且开启写入 → 真正写盘，applied 为 true', async () => {
    // 用一个"压缩后更小"的假处理器，避免依赖真实图片
    const shrinking = {
      async process() {
        return { outputFile: 'assets/hero.png', buffer: new Uint8Array([1, 2]), note: 'fake' };
      },
    };
    const executor = createAssetProcessorExecutor({ processor: shrinking, writeOutput: true });
    const ctx = context();

    const result = await executor.execute(candidate, ctx);

    expect(result.applied).toBe(true);
    expect(ctx.files.has('assets/hero.png')).toBe(true);
    expect(result.summary).toContain('已写入工作区');
  });

  it('**没有 writeFile 时只评估**：applied 为 false，一个字节都不写', async () => {
    const shrinking = {
      async process() {
        return { outputFile: 'assets/hero.png', buffer: new Uint8Array([1, 2]), note: 'fake' };
      },
    };
    const executor = createAssetProcessorExecutor({ processor: shrinking, writeOutput: true });
    const { writeFile: _dropped, ...readOnly } = context();
    void _dropped;

    const result = await executor.execute(candidate, readOnly);

    // 这就是 B 类候选被拿掉 writeFile 之后的样子：只能给评估结果
    expect(result.applied).toBe(false);
    expect(result.files).toEqual(['assets/hero.png']);
    expect(result.summary).toContain('未写入');
  });

  it('转换后反而变大就放弃（"优化"不该让文件更大）', async () => {
    const growing = {
      async process() {
        return { outputFile: 'assets/hero.png', buffer: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), note: 'fake' };
      },
    };
    const executor = createAssetProcessorExecutor({ processor: growing, writeOutput: true });

    const result = await executor.execute(candidate, context());

    expect(result.files).toEqual([]);
    expect(result.summary).toContain('反而大');
  });

  it('空处理器（未装 sharp）走默认路径也不崩', async () => {
    const executor = createAssetProcessorExecutor({
      processor: createNullAssetProcessor(),
      writeOutput: false,
    });

    // null 处理器会原样返回 buffer → 没有收益 → 跳过
    const result = await executor.execute(candidate, context());
    expect(result.files).toEqual([]);
  });
});

describe('执行器注册表', () => {
  it('四类执行器都在，asset 走 asset-processor', () => {
    const registry = createExecutorRegistry({ assetProcessor: createNullAssetProcessor() });

    expect(registry.all().map((e) => e.route).sort()).toEqual([
      'asset-processor',
      'ast-rewriter',
      'config-editor',
      'dependency-editor',
    ]);
    expect(registry.forCandidate(candidate)?.route).toBe('asset-processor');
  });
});
