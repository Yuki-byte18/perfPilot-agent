import type { Candidate, PlannedChange, ToolRoute } from '@yuki-byte18/shared';

/**
 * 工具路由（README §9.2）。
 *
 * 决策层在回答「改不改」之外，还要回答「交给谁做」。
 * 路由由**改动的类型**唯一决定，不是拍脑袋：`PlannedChange` 的四类
 * 一一对应四个执行器，`manual` 是明确的「没有执行器能接」。
 */
const CHANGE_TYPE_ROUTE: Record<PlannedChange['type'], ToolRoute> = {
  ast: 'ast-rewriter',
  asset: 'asset-processor',
  config: 'config-editor',
  dependency: 'dependency-editor',
};

export interface RouteDecision {
  route: ToolRoute;
  reason: string;
}

/**
 * 决定候选交给哪个执行器。
 *
 * 三条规则，按优先级：
 *
 * 1. **C 类或不可逆 → `manual`**。C 类本来就只出建议；不可逆的改动
 *    没有自动回滚的兜底，交给自动执行器不负责任。
 * 2. **改动跨多种类型 → `manual`**。一个执行器只认一类 `PlannedChange`
 *    （见 `ExecutorPort.canHandle`），跨类型意味着没有一个执行器能完整做完。
 *    硬塞给其中一个会产出一份**只改了一半**的 patch —— 那种补丁比不改更危险。
 * 3. **单一类型 → 对应执行器**。
 */
export function routeFor(candidate: Candidate): RouteDecision {
  if (candidate.class === 'C') {
    return { route: 'manual', reason: 'C 类仅建议，不产出 patch' };
  }

  if (!candidate.reversible) {
    return { route: 'manual', reason: '改动不可逆，无法自动回滚，只出建议' };
  }

  const types = [...new Set(candidate.changes.map((c) => c.type))].sort();

  if (types.length === 0) {
    return { route: 'manual', reason: '候选没有任何改动项，无从执行' };
  }

  if (types.length > 1) {
    return {
      route: 'manual',
      reason: `改动跨 ${types.length} 类执行器（${types.join(' / ')}），没有单一执行器能完整处理`,
    };
  }

  const [only] = types as [PlannedChange['type']];
  const route = CHANGE_TYPE_ROUTE[only];

  return { route, reason: `改动类型 ${only} 对应执行器 ${route}` };
}

/** 供测试与文档使用的路由表快照 */
export const ROUTE_TABLE: ReadonlyArray<{ type: PlannedChange['type']; route: ToolRoute }> =
  (Object.keys(CHANGE_TYPE_ROUTE) as PlannedChange['type'][]).map((type) => ({
    type,
    route: CHANGE_TYPE_ROUTE[type],
  }));
