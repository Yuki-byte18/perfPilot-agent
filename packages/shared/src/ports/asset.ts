/**
 * 二进制资产处理端口（sharp 等）。
 *
 * 实现放在 adapters，core/executor 只通过这个接口调用。
 */
export interface AssetProcessInput {
  file: string;
  buffer: Uint8Array;
  operation: 'convert-webp' | 'compress' | 'resize';
  params: Record<string, unknown>;
}

export interface AssetProcessResult {
  outputFile: string;
  buffer: Uint8Array;
  note: string;
}

export interface AssetProcessorPort {
  process(input: AssetProcessInput): Promise<AssetProcessResult | null>;
}

/** 未安装 sharp 时：不改字节，只声明「本应做什么」 */
export function createNullAssetProcessor(): AssetProcessorPort {
  return {
    async process(input) {
      const outputFile =
        input.operation === 'convert-webp' ? input.file.replace(/\.[^.]+$/, '.webp') : input.file;
      return {
        outputFile,
        buffer: input.buffer,
        note: `${input.operation}（未接入 sharp，仅生成描述性 patch）`,
      };
    },
  };
}
