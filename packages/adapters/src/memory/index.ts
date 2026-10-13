import { resolve } from 'node:path';
import type { MemoryConfig, MemoryPort } from '@yuki-byte18/shared';
import { createInMemoryMemory } from '@yuki-byte18/shared';
import { createPostgresMemory, type PgClientSurface } from './postgres.js';
import { createSqliteMemory, type SqliteMemory } from './sqlite.js';

export * from './sqlite.js';
export * from './postgres.js';
export * from './mapping.js';

export interface MemoryFactoryOptions {
  config: MemoryConfig;
  /** 项目根，用于把相对的 `memory.url` 解析成绝对路径 */
  root: string;
  /**
   * Postgres 客户端。没有它时**不降级成静默的内存实现**：
   * 见下面对 `createMemory` 的说明。
   */
  pgClient?: PgClientSurface;
  /** 强制使用内存实现（测试、或明确不想留下任何持久化痕迹的场景） */
  inMemory?: boolean;
}

/**
 * 按配置创建记忆层。
 *
 * 两个刻意的行为：
 *
 * 1. **Postgres 配置了却没有 client → 抛错。**
 *    悄悄退回内存实现会让"记忆"看起来在工作，实际上每轮运行都从零开始 ——
 *    而用户看到的是"这个工具从来不吸取教训"。宁可启动就报错。
 * 2. **SQLite 不可用时才退回内存实现**（例如 Node 版本太老没有 `node:sqlite`），
 *    并且由调用方看到这条降级 —— 这里把选择权交出去，不做隐式降级。
 */
export function createMemory(options: MemoryFactoryOptions): MemoryPort {
  if (options.inMemory === true) return createInMemoryMemory();

  if (options.config.driver === 'postgres') {
    if (options.pgClient === undefined) {
      throw new Error(
        'memory.driver 配置为 postgres，但没有提供数据库连接。' +
          '服务端模式需要注入 client；本地与 CI 请用 sqlite。',
      );
    }
    return createPostgresMemory({ client: options.pgClient });
  }

  // `:memory:` 是 SQLite 的临时库标记，不能被 resolve 成文件路径
  const url =
    options.config.url === ':memory:' ? ':memory:' : resolve(options.root, options.config.url);

  return createSqliteMemory({ url });
}

/** 测试与 CLI 关闭连接用：能关就关，关不了就算了（内存实现没有连接） */
export function closeMemory(memory: MemoryPort): void {
  const closeable = memory as Partial<SqliteMemory>;
  if (typeof closeable.close === 'function') closeable.close();
}
