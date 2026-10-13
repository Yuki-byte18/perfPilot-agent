import type { Attribution, Candidate, MetricName, PlannedChange } from '@yuki-byte18/shared';
import { buildRuleCandidate, type PlannerRule } from '../types.js';

/**
 * 图片类规划规则。
 *
 * ## 两类改动的可验证性完全不同（这里踩过一次坑）
 *
 * - **原地优化**（`compress` / `resize`）：产物**同一个文件名**，
 *   页面照旧引用它 → 重新采集能测到真实收益 → 可以自动执行并验证。
 * - **换格式**（`convert-webp`）：产物是**新文件**（`hero.png` → `hero.webp`），
 *   而引用它的 HTML / CSS / JS 仍然指向 `hero.png`。
 *   也就是说：**不改引用就没有任何收益**，重新采集测出来是 0，
 *   门禁必然回滚。把它标成 A 类（全自动）等于承诺一件做不到的事。
 *
 * 因此 `convert-webp` 是 **B 类**：产出新文件 + 明确的改动说明，由人决定
 * 要不要同步更新引用。这不是"能力不足"，而是**这一步无法可靠自动化** ——
 * 引用可能在 HTML 属性里、CSS `url()` 里、JS import 里，甚至是运行时拼出来的。
 */

function resourceFile(attribution: Attribution): string | null {
  if (attribution.level !== 'resource') return null;
  // 把 URL 转成相对项目根的路径（去掉协议/主机/查询串）
  try {
    const url = new URL(attribution.url);
    return url.pathname.replace(/^\/+/, '');
  } catch {
    return attribution.url.replace(/^\/+/, '');
  }
}

export const compressOversizedImageRule: PlannerRule = {
  id: 'compress-oversized-image',
  kind: 'OVERSIZED_IMAGE',
  description: '压缩体积超标的图片',

  plan(bottleneck, ctx): Candidate[] {
    const file = resourceFile(bottleneck.attribution);
    if (file === null) return [];

    const change: PlannedChange = {
      type: 'asset',
      file,
      operation: 'compress',
      // 画质按 **0-100** 传（sharp 的刻度）。小数会被归一化，但这里就该写对
      params: { quality: 80 },
    };

    const expectedGain: Partial<Record<MetricName, number>> = {
      // 保守估计压缩 40%
      IMAGE_SIZE: Math.round((bottleneck.impact.IMAGE_SIZE ?? 0) * 0.4),
    };

    return [
      buildRuleCandidate({
        id: `cand_${bottleneck.id}_compress`,
        runId: ctx.runId,
        bottleneck,
        ruleId: 'compress-oversized-image',
        class: 'A',
        title: `压缩图片 ${file}`,
        description: `该图片体积超标，压缩到 80 画质可减少约 ${Math.round((bottleneck.impact.IMAGE_SIZE ?? 0) * 0.4 / 1024)}KB（文件名不变，引用无需改动）`,
        changes: [change],
        expectedGain,
        risk: 'low',
        effort: 'low',
        reversible: true,
      }),
    ];
  },
};

export const convertToWebpRule: PlannerRule = {
  id: 'convert-to-webp',
  kind: 'UNCOMPRESSED_IMAGE',
  description: '将未压缩的位图转为 WebP 格式',

  plan(bottleneck, ctx): Candidate[] {
    const file = resourceFile(bottleneck.attribution);
    if (file === null) return [];

    const webpFile = file.replace(/\.[^.]+$/, '.webp');

    const change: PlannedChange = {
      type: 'asset',
      file,
      operation: 'convert-webp',
      params: { quality: 82 },
    };

    const expectedGain: Partial<Record<MetricName, number>> = {
      IMAGE_SIZE: Math.round((bottleneck.impact.IMAGE_SIZE ?? 0) * 0.3),
      ...(bottleneck.impact.TRANSFER_SIZE
        ? { TRANSFER_SIZE: Math.round(bottleneck.impact.TRANSFER_SIZE * 0.3) }
        : {}),
    };

    return [
      buildRuleCandidate({
        id: `cand_${bottleneck.id}_webp`,
        runId: ctx.runId,
        bottleneck,
        ruleId: 'convert-to-webp',
        // B 类：新文件不会自动生效，必须由人同步更新引用
        class: 'B',
        title: `将 ${file} 转为 WebP（需同步更新引用）`,
        description:
          `WebP 通常比 PNG/JPEG 小 25%-50%。产物是 ${webpFile}，` +
          `**引用它的 HTML / CSS / JS 仍需指向新文件** —— 这一步无法可靠自动化，` +
          `因此只产出新文件与改动说明，由人工确认后一起提交`,
        changes: [change],
        expectedGain,
        risk: 'low',
        effort: 'medium',
        reversible: true,
      }),
    ];
  },
};

export const addImageDimensionsRule: PlannerRule = {
  id: 'add-image-dimensions',
  kind: 'MISSING_DIMENSIONS',
  description: '为图片补充 width/height 防止 CLS',

  plan(bottleneck, ctx): Candidate[] {
    // MISSING_DIMENSIONS 的归因通常是 component（选择器）或 source
    let target = '';
    if (bottleneck.attribution.level === 'component') {
      target = bottleneck.attribution.name;
    } else if (bottleneck.attribution.level === 'source') {
      target = `${bottleneck.attribution.file}:${bottleneck.attribution.line}`;
    } else if (bottleneck.attribution.level === 'resource') {
      target = resourceFile(bottleneck.attribution) ?? bottleneck.attribution.url;
    } else {
      return [];
    }

    const change: PlannedChange = {
      type: 'ast',
      file: bottleneck.attribution.level === 'source' ? bottleneck.attribution.file : target,
      node: 'img-element',
      description: `为 <img> 添加 width/height 属性`,
    };

    return [
      buildRuleCandidate({
        id: `cand_${bottleneck.id}_dims`,
        runId: ctx.runId,
        bottleneck,
        ruleId: 'add-image-dimensions',
        class: 'A',
        title: `为图片补充宽高尺寸`,
        description: `缺少 width/height 会导致布局偏移（CLS）。目标：${target}`,
        changes: [change],
        expectedGain: { CLS: 0.05 },
        risk: 'low',
        effort: 'low',
        reversible: true,
      }),
    ];
  },
};
