import { describe, expect, it } from 'vitest';
import { PerfPilotConfigSchema } from '../schema/config.js';
import { parseExternal, tryParseExternal } from '../schema/parse.js';
import { RunRecordSchema } from '../schema/run.js';
import { ConfigError, PerfPilotError, ValidationError, exitCodeForError, toPerfPilotError } from '../errors/index.js';
import { EXIT_CODES } from '../errors/index.js';

const minimalConfig = {
  project: { name: 'demo' },
  target: { url: 'https://staging.example.com' },
};

describe('PerfPilotConfigSchema', () => {
  it('最小配置即可解析，其余字段走默认值', () => {
    const config = parseExternal(PerfPilotConfigSchema, minimalConfig, { what: '配置' });
    expect(config.project.root).toBe('.');
    expect(config.target.routes).toEqual(['/']);
    expect(config.target.branch).toBe('main');
    expect(config.baseline.ref).toBe('last-run');
    expect(config.decision.jev).toBe(true);
    expect(config.decision.thresholds.min_gain).toBe(5);
    expect(config.report.format).toEqual(['markdown', 'json']);
    expect(config.collect.timeoutMs).toBe(120_000);
    expect(config.llm).toBeNull();
    expect(config.memory.driver).toBe('sqlite');
  });

  it('checks 段：默认自动识别包管理器，默认检查清单含 build', () => {
    const config = parseExternal(PerfPilotConfigSchema, minimalConfig, { what: '配置' });

    // auto = 按 lockfile 判断；写死 pnpm 会在 npm 项目上把检查跑挂
    expect(config.checks.package_manager).toBe('auto');
    // build 必须默认在列：重采集读的是构建产物，不重建就测不到改动的效果
    expect(config.checks.kinds).toContain('build');
    expect(config.checks.scripts).toEqual({});
  });

  it('checks.scripts 的 null 是有意义的值（这个项目不做这项检查）', () => {
    const config = parseExternal(
      PerfPilotConfigSchema,
      { ...minimalConfig, checks: { scripts: { e2e: null, 'type-check': 'type-check' } } },
      { what: '配置' },
    );

    expect(config.checks.scripts.e2e).toBeNull();
    expect(config.checks.scripts['type-check']).toBe('type-check');
  });

  it('checks 段同样严格：未知检查项与写错的包管理器都拒绝', () => {
    const unknownKind = PerfPilotConfigSchema.safeParse({
      ...minimalConfig,
      checks: { kinds: ['unit-test', 'integration'] },
    });
    expect(unknownKind.success).toBe(false);

    const wrongPm = PerfPilotConfigSchema.safeParse({
      ...minimalConfig,
      checks: { package_manager: 'cnpm' },
    });
    expect(wrongPm.success).toBe(false);
  });

  it('拒绝拼错的键，而不是静默忽略', () => {
    const result = PerfPilotConfigSchema.safeParse({
      ...minimalConfig,
      decision: { jev: true, thresholds: { minGain: 5 } },
    });
    expect(result.success).toBe(false);
  });

  it('拒绝顶层未知键', () => {
    const result = PerfPilotConfigSchema.safeParse({ ...minimalConfig, targt: {} });
    expect(result.success).toBe(false);
  });

  it('缺少 project / target 时报错并指出路径', () => {
    const result = PerfPilotConfigSchema.safeParse({});
    expect(result.success).toBe(false);
    if (result.success) return;
    const paths = result.error.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('project');
    expect(paths).toContain('target');
  });

  it('target.url 必须是合法 URL', () => {
    const result = PerfPilotConfigSchema.safeParse({
      project: { name: 'demo' },
      target: { url: 'not-a-url' },
    });
    expect(result.success).toBe(false);
  });

  it('指标阈值必须满足 warning ≤ error', () => {
    const result = PerfPilotConfigSchema.safeParse({
      ...minimalConfig,
      baseline: { ref: 'last-run', metrics: { LCP: { warning: 5000, error: 1000 } } },
    });
    expect(result.success).toBe(false);
  });

  it('指标名拼错会被拒绝（阈值表由 METRIC_NAMES 构造）', () => {
    const result = PerfPilotConfigSchema.safeParse({
      ...minimalConfig,
      baseline: { metrics: { LPC: { warning: 1, error: 2 } } },
    });
    expect(result.success).toBe(false);
  });

  it('裁决阈值必须满足 confirm_score ≤ apply_score', () => {
    const result = PerfPilotConfigSchema.safeParse({
      ...minimalConfig,
      decision: { thresholds: { apply_score: 10, confirm_score: 50 } },
    });
    expect(result.success).toBe(false);
  });
});

describe('RunRecordSchema', () => {
  it('拒绝 score 越界的指标', () => {
    const result = RunRecordSchema.safeParse({
      schemaVersion: 1,
      id: 'run_1',
      project: 'demo',
      route: '/',
      device: 'mobile',
      url: 'https://example.com',
      status: 'success',
      startedAt: '2026-01-17T14:25:30.000Z',
      finishedAt: '2026-01-17T14:25:31.000Z',
      durationMs: 1000,
      perfpilotVersion: '0.1.0',
      stages: [],
      metrics: [
        {
          name: 'LCP',
          value: 1000,
          unit: 'ms',
          rating: 'good',
          score: 120,
          route: '/',
          device: 'mobile',
          source: 'lighthouse',
          collectedAt: '2026-01-17T14:25:30.000Z',
        },
      ],
      baseline: null,
      deltas: [],
      warnings: [],
      artifacts: [],
    });
    expect(result.success).toBe(false);
  });
});

describe('parseExternal / tryParseExternal', () => {
  it('校验失败抛 ValidationError，错误信息含字段路径', () => {
    try {
      parseExternal(PerfPilotConfigSchema, { project: {} }, { what: '配置文件' });
      throw new Error('应当抛出');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const e = err as ValidationError;
      expect(e.message).toContain('配置文件 校验失败');
      expect(e.message).toContain('project.name');
      expect(e.details?.issues).toBeDefined();
    }
  });

  it('tryParseExternal 失败时返回 null，不抛异常', () => {
    expect(tryParseExternal(PerfPilotConfigSchema, { project: {} })).toBeNull();
    expect(tryParseExternal(PerfPilotConfigSchema, minimalConfig)).not.toBeNull();
  });
});

describe('错误体系', () => {
  it('PerfPilotError 保留 code / stage / 可重试语义', () => {
    const err = new PerfPilotError('boom', {
      code: 'ADAPTER_FAILED',
      stage: 'collect',
      retryable: true,
    });
    expect(err.code).toBe('ADAPTER_FAILED');
    expect(err.stage).toBe('collect');
    expect(err.retryable).toBe(true);
    expect(err.toJSON()).toMatchObject({ code: 'ADAPTER_FAILED', stage: 'collect' });
  });

  it('ConfigError 默认不可重试', () => {
    expect(new ConfigError('bad config', {}).retryable).toBe(false);
    expect(new ConfigError('bad config', {}).code).toBe('CONFIG_INVALID');
  });

  it('toPerfPilotError 收敛任意抛出物', () => {
    expect(toPerfPilotError(new Error('x'))).toBeInstanceOf(PerfPilotError);
    expect(toPerfPilotError('plain string').message).toBe('plain string');
    const original = new ConfigError('keep me', {});
    expect(toPerfPilotError(original)).toBe(original);
  });

  it('错误码映射到 README §12 约定的退出码', () => {
    expect(exitCodeForError(new ConfigError('x', {}))).toBe(EXIT_CODES.CONFIG_ERROR);
    expect(exitCodeForError(new ValidationError('x', {}))).toBe(EXIT_CODES.COLLECT_FAILED);
    expect(exitCodeForError(new PerfPilotError('x', { code: 'INTERNAL' }))).toBe(EXIT_CODES.INTERNAL);
  });
});
