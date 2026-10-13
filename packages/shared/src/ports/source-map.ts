/**
 * Source Map 解析端口。
 *
 * 这不属于 `CollectorPort`：采集器是「跑工具、产出产物」，而 source map 是
 * 诊断阶段按需查询的**服务** —— 只有需要把压缩代码位置还原到源码时才会被调用，
 * 且调用次数取决于命中了多少条规则。硬把它塞进采集阶段会白读一堆没用到的 map。
 *
 * 具体实现放 `@yuki-byte18/adapters/source-map`（读 .map 文件是外部 IO），
 * 由组合根注入给 core。测试里注入纯内存实现即可。
 */

export interface GeneratedLocation {
  /** 构建产物文件路径，相对项目根 */
  file: string;
  /** 1-based 行号 */
  line: number;
  /** 0-based 列号（source map 规范如此） */
  column: number;
}

export interface OriginalLocation {
  /** 源码文件，相对项目根 */
  source: string;
  /** 1-based 行号 */
  line: number;
  /** 0-based 列号 */
  column: number;
  /** 原始标识符名（函数名 / 变量名），无则为 null */
  name: string | null;
  /** 该文件是否属于 node_modules（用于区分「自己的代码」与「第三方」） */
  fromDependency: boolean;
}

export interface SourceMapPort {
  /**
   * 把构建产物里的位置还原到源码位置。
   *
   * 找不到映射（无 map 文件、位置越界、map 损坏）时返回 null —— 
   * 调用侧据此降级为「只能归因到产物文件」，而不是整条诊断失败。
   */
  resolve(generated: GeneratedLocation): Promise<OriginalLocation | null>;
  /** 预载映射文件，避免大批量解析时反复读盘 */
  warmup(files: readonly string[]): Promise<void>;
}

/**
 * 纯内存实现。
 *
 * 放在 shared 而不是某个包的测试目录里：它是 `SourceMapPort` 这个**端口**的替身，
 * 而 core 的规则测试需要它 —— 但 core 不允许 import adapters（硬约束 4）。
 * 端口定义在哪，它的内存替身就该在哪。
 *
 * 键的格式是 `${file}:${line}:${column}`。
 */
export function createInMemorySourceMap(
  entries: Readonly<Record<string, OriginalLocation>>,
): SourceMapPort {
  return {
    async resolve(generated) {
      return entries[`${generated.file}:${generated.line}:${generated.column}`] ?? null;
    },
    async warmup() {
      // 内存实现无需预热
    },
  };
}
