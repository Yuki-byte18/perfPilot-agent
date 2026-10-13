import { z } from 'zod';

/**
 * Source Map v3 的**容错** schema。
 *
 * 只声明我们读取的字段：`mappings` 是必须的，其余可选（`sourcesContent` 在生产
 * 构建里常被裁掉）。`sections` 用于 index map（多 chunk 合并的 map），
 * 由 `@jridgewell/trace-mapping` 处理，这里只要放行。
 */
export const SourceMapSchema = z
  .object({
    version: z.number(),
    file: z.string().optional(),
    sourceRoot: z.string().optional(),
    sources: z.array(z.string()).optional(),
    sourcesContent: z.array(z.string().nullable()).optional(),
    names: z.array(z.string()).optional(),
    mappings: z.string().optional(),
    /** index map：多段拼接，此时没有顶层 mappings */
    sections: z.array(z.unknown()).optional(),
  })
  .passthrough();

export type SourceMapFile = z.infer<typeof SourceMapSchema>;

/** 构建产物扫描里可选的 package.json 快照，供「配置类」规则归因 */
export const PackageJsonSnapshotSchema = z
  .object({
    name: z.string().optional(),
    sideEffects: z.unknown().optional(),
    dependencies: z.record(z.string(), z.string()).optional(),
    devDependencies: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();
