import type { AssetProcessorPort, Executor, ExecutorRegistry } from '@yuki-byte18/shared';
import { createAstRewriterExecutor } from './ast-rewriter.js';
import { createAssetProcessorExecutor } from './asset-processor.js';
import { createConfigEditorExecutor } from './config-editor.js';
import { createDependencyEditorExecutor } from './dependency-editor.js';

export interface ExecutorRegistryOptions {
  /** 资产处理器（sharp）。不传时用「只声明不处理」的空实现 */
  assetProcessor: AssetProcessorPort;
  /** 资产改动是否真的写盘。默认 false —— 不见真章之前不动用户的工作区 */
  writeAssets?: boolean;
}

/**
 * 执行器注册表。
 *
 * 这是 `core` 与具体执行器之间的唯一接缝：core 只认识 `ExecutorRegistry` 接口
 * （定义在 shared），四个执行器的构造函数只在这里被调用一次。
 * 单测注入自己的一组执行器即可，不必碰 ts-morph 与 sharp。
 */
export function createExecutorRegistry(options: ExecutorRegistryOptions): ExecutorRegistry {
  const executors: Executor[] = [
    createAstRewriterExecutor(),
    createAssetProcessorExecutor({
      processor: options.assetProcessor,
      writeOutput: options.writeAssets ?? false,
    }),
    createConfigEditorExecutor(),
    createDependencyEditorExecutor(),
  ];

  return {
    all: () => [...executors],
    forCandidate: (candidate) => {
      // 一个执行器只认一类 PlannedChange；候选的改动类型由决策层的路由保证一致，
      // 这里再兜一次底：所有改动都必须能被同一个执行器处理。
      return (
        executors.find((executor) => candidate.changes.every((change) => executor.canHandle(change))) ??
        null
      );
    },
  };
}

export { createAstRewriterExecutor } from './ast-rewriter.js';
export { createAssetProcessorExecutor } from './asset-processor.js';
export { createConfigEditorExecutor } from './config-editor.js';
export { createDependencyEditorExecutor } from './dependency-editor.js';
export * from './common.js';
