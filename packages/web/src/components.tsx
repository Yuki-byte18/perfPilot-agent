import type { ReactNode } from 'react';
import type { Metric } from '@yuki-byte18/shared';
import {
  formatMetric,
  RATING_LABEL,
  type ChangeKind,
  type TrendView,
  type Tone,
} from './data.js';

/**
 * 展示原语。
 *
 * 这一层只做**看起来是什么样**，不做任何数据加工 —— 数字怎么算全在 `data.ts`。
 * 分开的理由是可测性：颜色、文案、排序逻辑都能用纯函数测，而 JSX 不能。
 */

export function Card(props: {
  title?: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <section className="card">
      {props.title === undefined ? null : (
        <header className="card-head">
          <h2>{props.title}</h2>
          {props.right === undefined ? null : <div className="card-right">{props.right}</div>}
        </header>
      )}
      {props.subtitle === undefined ? null : <p className="muted small card-sub">{props.subtitle}</p>}
      {props.children}
    </section>
  );
}

export function Badge(props: { children: ReactNode; tone?: Tone; title?: string }): JSX.Element {
  const tone = props.tone ?? 'neutral';
  return (
    <span
      className={`badge badge-${tone}`}
      {...(props.title === undefined ? {} : { title: props.title })}
    >
      {props.children}
    </span>
  );
}

/** 分数刻度：0-100。分数比原始值更能一眼看出"离标准多远" */
export function ScoreBar({ score }: { score: number | null }): JSX.Element {
  if (score === null) return <span className="muted">—</span>;

  const clamped = Math.max(0, Math.min(100, score));
  return (
    <span className="scorebar" title={`分数 ${clamped.toFixed(1)} / 100`}>
      <span className={`scorebar-fill score-${toneOfScore(clamped)}`} style={{ width: `${clamped}%` }} />
      <span className="scorebar-text">{clamped.toFixed(0)}</span>
    </span>
  );
}

export function toneOfScore(score: number): Tone {
  if (score >= 90) return 'good';
  if (score >= 50) return 'warn';
  return 'bad';
}

export function RatingBadge({ rating }: { rating: Metric['rating'] | null }): JSX.Element {
  if (rating === null) return <span className="muted">—</span>;
  const tone: Tone = rating === 'good' ? 'good' : rating === 'needs-improvement' ? 'warn' : 'bad';
  return <Badge tone={tone}>{RATING_LABEL[rating]}</Badge>;
}

const CHANGE_TONE: Record<ChangeKind, Tone> = {
  improved: 'good',
  regressed: 'bad',
  flat: 'neutral',
  unknown: 'neutral',
};

const CHANGE_GLYPH: Record<ChangeKind, string> = {
  improved: '▼',
  regressed: '▲',
  flat: '＝',
  unknown: '—',
};

const CHANGE_TEXT: Record<ChangeKind, string> = {
  improved: '改善',
  regressed: '劣化',
  flat: '持平',
  unknown: '不可比',
};

/**
 * 变化徽标。
 *
 * 箭头按**好坏**而不是按数值方向画：LCP 从 3.5s 降到 2.0s 是"改善"，
 * 屏幕上却是一个下降的数字。按数值方向画箭头，读者每次都要在脑子里换算一遍。
 */
export function ChangeBadge(props: {
  change: ChangeKind;
  delta: number | null;
  unit: Metric['unit'] | null;
  deltaPercent?: number | null;
}): JSX.Element {
  const percent =
    props.deltaPercent === undefined || props.deltaPercent === null
      ? ''
      : `（${props.deltaPercent > 0 ? '+' : ''}${props.deltaPercent.toFixed(1)}%）`;

  return (
    <Badge tone={CHANGE_TONE[props.change]}>
      {CHANGE_GLYPH[props.change]} {CHANGE_TEXT[props.change]}
      {props.change === 'unknown' ? '' : ` ${formatMetric(props.delta === null ? null : Math.abs(props.delta), props.unit)}${percent}`}
    </Badge>
  );
}

/**
 * 折线图。
 *
 * 手写 SVG 而不是引一个图表库：图表库是这一页里最大的一块依赖（通常几百 KB），
 * 而报告页自己有性能预算（M8 验收 3）。为几条线装一座图表库不划算。
 *
 * 刻度取**所有点里的最小/最大值**而不是从 0 起：性能指标的绝对值很大
 * （LCP 几千毫秒），从 0 起会把所有变化压成一条平线，看不出任何趋势。
 * 这是这一页最容易被做错的地方。
 */
export function Sparkline({ view }: { view: TrendView }): JSX.Element {
  const width = 320;
  const height = 72;
  const padX = 6;
  const padY = 10;

  const values = view.points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;

  const at = (index: number, value: number): { x: number; y: number } => ({
    x:
      view.points.length === 1
        ? width / 2
        : padX + (index / (view.points.length - 1)) * (width - padX * 2),
    y: span === 0 ? height / 2 : padY + ((value - min) / span) * (height - padY * 2),
  });

  const coords = view.points.map((point, index) => ({ ...at(index, point.value), point }));
  const line = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ');
  const first = coords[0];
  const last = coords[coords.length - 1];
  const area =
    first === undefined || last === undefined
      ? ''
      : `${line} L${last.x.toFixed(1)},${height - padY / 2} L${first.x.toFixed(1)},${height - padY / 2} Z`;

  return (
    <svg
      className="sparkline"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${view.name} 趋势：${view.points.length} 个数据点`}
      preserveAspectRatio="none"
    >
      {span === 0 ? null : <path d={area} className="spark-area" />}
      <path d={line} className="spark-line" />
      {coords.map((c, index) => (
        <circle
          key={`${c.point.runId}-${index}`}
          cx={c.x.toFixed(1)}
          cy={c.y.toFixed(1)}
          r={index === coords.length - 1 ? 3.5 : 2}
          className={index === coords.length - 1 ? 'spark-dot-last' : 'spark-dot'}
        />
      ))}
    </svg>
  );
}

export function Stat(props: { label: string; value: ReactNode; tone?: Tone; hint?: string }): JSX.Element {
  const tone = props.tone ?? 'neutral';
  return (
    <div className={`stat stat-${tone}`} {...(props.hint === undefined ? {} : { title: props.hint })}>
      <span className="stat-value">{props.value}</span>
      <span className="stat-label">{props.label}</span>
    </div>
  );
}
