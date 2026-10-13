import type {
  AssetProcessorPort,
  Candidate,
  ExecutionContext,
  ExecutionResult,
  Executor,
  PlannedChange,
} from '@yuki-byte18/shared';

/**
 * 二进制资产执行器（图片转码 / 压缩 / 缩放）。
 *
 * ## 为什么它不产出文本补丁
 *
 * 四类执行器里只有它**不是纯计算**：`sharp` 要拿原始字节，产出的也是字节。
 * 而文本 diff 表达不了二进制改动 —— 这是 ADR 006 里明确记录的已知代价。
 *
 * 硬造一个"说明性补丁"是错的：那种补丁 `git apply` 上去什么都不会变，
 * 却会让上层以为"改动已经通过 patch 落地了"，回滚时 `git apply -R` 更无从谈起。
 *
 * 因此这里的约定是：
 *
 * - **`patch === ''` 且 `files.length > 0`** 表示「二进制改动已写入工作区」
 * - 回滚不走 `git apply -R`，走 `git checkout -- <files>`（见 verifier 的回滚分支）
 * - `summary` 必须写清改了什么、省了多少字节 —— 这是人工确认的唯一依据
 *
 * 换句话说：资产的「可审计性」由文件列表 + 体积变化承担，而不是由 diff 承担。
 */

export interface AssetProcessorOptions {
  processor: AssetProcessorPort;
  /**
   * 是否真的把产物写入工作区。
   *
   * 默认 **false**：在没有 git 仓库、或只想先看看能省多少的场景下，
   * 不应该动用户的工作区。CI 里做真实验证时才打开。
   */
  writeOutput?: boolean;
}

export function isProcessableImage(file: string): boolean {
  return /\.(png|jpe?g|gif|webp|avif|tiff?)$/i.test(file);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function createAssetProcessorExecutor(options: AssetProcessorOptions): Executor {
  const { processor } = options;

  const accepts = (change: PlannedChange): boolean => change.type === 'asset';

  return {
    route: 'asset-processor',
    canHandle: accepts,

    async execute(candidate: Candidate, ctx: ExecutionContext): Promise<ExecutionResult> {
      const files: string[] = [];
      const notes: string[] = [];
      const skipped: string[] = [];
      let savedBytes = 0;

      /**
       * 能不能写盘，**在循环之前就定下来**。
       *
       * 之前是在每个文件里现算的，于是 `summary` 用的还是"配置说可以写"，
       * 而 `applied` 用的是"实际写了没有" —— 两者会不一致：
       * 上下文没给 `writeFile` 时（B 类候选），摘要会写"已写入工作区"，
       * 而实际一个字节都没写。摘要是给人看的（报告、PR、人工确认），
       * 它必须说真话。
       */
      const canWrite = options.writeOutput === true && ctx.writeFile !== undefined;

      for (const change of candidate.changes) {
        if (change.type !== 'asset') {
          skipped.push(`${change.type} 改动不在本执行器职责内`);
          continue;
        }

        if (!isProcessableImage(change.file)) {
          skipped.push(`${change.file} 不是可处理的图片格式`);
          continue;
        }

        if (ctx.readBinary === undefined) {
          skipped.push('执行上下文未提供 readBinary，无法读取二进制资产');
          continue;
        }

        const buffer = await ctx.readBinary(change.file);
        if (buffer === null) {
          skipped.push(`文件不存在：${change.file}`);
          continue;
        }

        const result = await processor.process({
          file: change.file,
          buffer,
          operation: change.operation,
          params: change.params,
        });

        if (result === null) {
          skipped.push(`${change.file}：${change.operation} 未产生收益（可能已是目标格式）`);
          continue;
        }

        /**
         * 字节一模一样 = 处理器其实没干活。
         *
         * 最典型的场景是没装可选依赖 `sharp`：`createNullAssetProcessor`
         * 会原样返回 buffer，而 sharp 没装上时 `process()` 直接返回 `null`。
         * 不单独分辨的话，这件事在报告里会变成下面那句"反而大 0 B，放弃" ——
         * 用户读到的是"这个优化没收益"，真相却是"这台机器上根本没有处理器"，
         * 而后者要做的动作（装一个包）完全不同。
         */
        const untouched =
          result.buffer.byteLength === buffer.byteLength &&
          Buffer.from(result.buffer).equals(Buffer.from(buffer));
        if (untouched) {
          skipped.push(`${change.file}：处理器未改动字节（本机可能未安装可选依赖 sharp）`);
          continue;
        }

        const saved = buffer.byteLength - result.buffer.byteLength;
        if (saved <= 0) {
          // 变大就不是优化，宁可不动 —— 这是"验证"里最便宜的一道防线
          skipped.push(`${change.file}：转换后反而大 ${formatBytes(-saved)}，放弃`);
          continue;
        }

        if (canWrite && ctx.writeFile !== undefined) {
          await ctx.writeFile(result.outputFile, Buffer.from(result.buffer));
        }

        savedBytes += saved;
        files.push(result.outputFile);
        notes.push(
          `${change.file} → ${result.outputFile}：${formatBytes(buffer.byteLength)} → ${formatBytes(result.buffer.byteLength)}（省 ${formatBytes(saved)}）`,
        );
      }

      const summaryParts: string[] = [];
      if (notes.length > 0) {
        summaryParts.push(
          `处理 ${notes.length} 个资产，共省 ${formatBytes(savedBytes)}${canWrite ? '（已写入工作区）' : '（未写入，仅评估）'}`,
          ...notes,
        );
      }
      if (skipped.length > 0) summaryParts.push(`跳过：${skipped.join('；')}`);

      return {
        candidateId: candidate.id,
        route: 'asset-processor',
        // 二进制改动没有文本补丁 —— 见文件头说明
        patch: '',
        // 只有真的写过盘才算"已改动工作区"；只评估时 files 表示"将会改动"
        applied: canWrite && files.length > 0,
        files,
        summary: summaryParts.length > 0 ? summaryParts.join('\n') : '没有可处理的资产',
      };
    },
  };
}
