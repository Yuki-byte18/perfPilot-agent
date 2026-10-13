import type { Attribution } from '../schema/bottleneck.js';

/**
 * 归因的两个纯函数。
 *
 * 放在 utils 而不是 `types/bottleneck.ts`：它们需要 `Attribution` 类型，
 * 而该类型由 schema 反推。留在 types 里会形成
 * `types → schema → types` 的循环。
 */

/** 归因的可读单行描述，报告与 MR 评论都用它 */
export function describeAttribution(attribution: Attribution): string {
  switch (attribution.level) {
    case 'resource':
      return `resource ${attribution.url}`;
    case 'dependency':
      return `dependency ${attribution.name}${attribution.version ? `@${attribution.version}` : ''}`;
    case 'source':
      return `source ${attribution.file}:${attribution.line}${attribution.column === null ? '' : `:${attribution.column}`}`;
    case 'component':
      // 来自 Web Vitals 的 DOM 归因只有选择器，没有源码位置 ——
      // 这时只显示选择器，而不是打印一个 `null:null`
      return attribution.file === null || attribution.line === null
        ? `component ${attribution.name}`
        : `component ${attribution.name} (${attribution.file}:${attribution.line})`;
    case 'config':
      return `config ${attribution.file} → ${attribution.key}`;
    default:
      return 'unknown';
  }
}

/**
 * 合并键：决定两个「检测」算不算同一个根因。
 *
 * 关键在于**按可操作主体合并，而不是按资源逐条列**：
 * 12 张超标图片应该合成一条 `occurrences: 12` 的瓶颈（一次改完），
 * 而不是 12 条各占一行的噪音 —— 后者会让报告失去可读性，
 * 也会让决策层把同一件事算 12 遍。
 */
export function attributionMergeKey(attribution: Attribution): string {
  switch (attribution.level) {
    case 'resource': {
      // 同一目录下的同类资源视为一组（如 /assets/*.png）
      const url = attribution.url.split(/[?#]/)[0] ?? attribution.url;
      const slash = url.lastIndexOf('/');
      return `${attribution.contentType}|${slash > 0 ? url.slice(0, slash) : url}`;
    }
    case 'dependency':
      return attribution.name;
    case 'source':
      return `${attribution.file}:${attribution.line}`;
    case 'component':
      return attribution.name;
    case 'config':
      return `${attribution.file}#${attribution.key}`;
    default:
      return 'unknown';
  }
}
