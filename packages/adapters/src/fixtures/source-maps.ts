/**
 * 手写的 Source Map v3 fixture。
 *
 * 不依赖任何构建工具生成 —— fixture 一旦要靠 bundler 产出，
 * 测试就再也不能在「没有构建环境」的地方跑（比如 CI 的纯 Node 容器）。
 *
 * mapping 段是 Base64 VLQ 编码：
 *   "AAAA,QACA"
 *   ├ AAAA = [genCol+0, srcIdx+0, srcLine+0, srcCol+0] → 产物第 1 行第 0 列 起，映射到源码第 1 行
 *   └ QACA = [genCol+8, srcIdx+0, srcLine+1, srcCol+0] → 产物第 1 行第 8 列 起，映射到源码第 2 行
 * 所有字段都是相对上一段的**增量**，因此第二个段的 srcLine 写 1 表示「+1 行」。
 *
 * VLQ 编码规则：值 v → 符号位放最低位（0=正），再按 5 位一组、最高位作续位，
 * 每组查 base64 表。8 → 16 → 单字符 'Q'；1 → 2 → 'C'。
 */

export const GENERATED_BUNDLE = 'var a=1;var b=2;';

export const ORIGINAL_SOURCE = ['const a = 1;', 'const b = 2;'].join('\n');

export const SIMPLE_SOURCE_MAP = {
  version: 3,
  file: 'bundle.js',
  // 相对 map 文件所在目录（source map 规范）
  sources: ['./src/original.ts'],
  sourcesContent: [ORIGINAL_SOURCE],
  names: [],
  mappings: 'AAAA,QACA',
};

/** 一份指向 node_modules 的 map，用来验证第三方代码的识别 */
export const DEPENDENCY_SOURCE_MAP = {
  version: 3,
  file: 'vendor.js',
  sources: ['./node_modules/lodash/lodash.js'],
  names: [],
  mappings: 'AAAA',
};

/** 损坏的 map：mappings 不是合法 VLQ */
export const BROKEN_SOURCE_MAP = {
  version: 3,
  file: 'broken.js',
  sources: ['a.ts'],
  mappings: '!!!!not-valid!!!!',
};

/** 缺 mappings 且无 sections，属于不可用 map */
export const EMPTY_SOURCE_MAP = {
  version: 3,
  file: 'empty.js',
  sources: ['a.ts'],
  names: [],
};

/**
 * index map：sections 分段，多 chunk 拼接时构建工具会产出这种形态。
 *
 * 注意 `sources` 必须存在（哪怕是空数组）：`TraceMap` 在分段分支里会读它，
 * 缺了会报 "Cannot read properties of undefined"。这也是为什么适配器内部
 * 对分段 map 要走 `FlattenMap` 而不是 `TraceMap`。
 */
export const INDEX_SOURCE_MAP = {
  version: 3,
  file: 'index-map.js',
  sources: [],
  names: [],
  sections: [
    {
      offset: { line: 0, column: 0 },
      map: {
        version: 3,
        sources: ['./src/first.ts'],
        names: [],
        mappings: 'AAAA',
      },
    },
    {
      offset: { line: 1, column: 0 },
      map: {
        version: 3,
        sources: ['./src/second.ts'],
        names: [],
        mappings: 'AAAA',
      },
    },
  ],
};
