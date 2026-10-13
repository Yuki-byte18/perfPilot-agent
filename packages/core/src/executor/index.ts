import {
  toPerfPilotError,
  type Candidate,
  type Decision,
  type ExecutionContext,
  type ExecutionResult,
  type ExecutorRegistry,
  type LoggerPort,
  type RunStorePort,
} from '@yuki-byte18/shared';
export interface ExecuteInput {
  runId: string;
  candidates: readonly Candidate[];
  decisions: readonly Decision[];
  /**
   * 是否允许写入工作区，默认 true。
   *
   * 由流水线传入「改动守卫」的结论：没注入 git、没注入验证器、
   * **或者工作区不干净**时为 false。此时执行器只能评估、不能落盘。
   *
   * 为什么必须由调用方传进来：执行编排**没有能力**判断工作区是否干净
   * （那是 git 的知识），但它必须知道自己有没有被允许写。
   *
   * 这个字段是一次真实事故的产物：守卫判断出"工作区不干净，拒绝自动应用改动"，
   * 而 execute 阶段照样把压缩后的图片写进了工作区，verify 阶段随后跳过 ——
   * 结果是**工具在明确决定"不能动"之后动了代码，而且没有任何回滚**。
   * 报告里那句"拒绝自动应用改动"因此是假的。
   */
  allowWrite?: boolean;
}

export interface ExecutorOptions {
  registry: ExecutorRegistry;
  store: RunStorePort;
  logger: LoggerPort;
  /** 注入文件读写：单测用内存实现，生产用真实 fs */
  createContext: (runId: string) => ExecutionContext;
}

export interface ExecuteOutcome {
  results: ExecutionResult[];
  /** 未产出任何改动的候选及原因，进报告说明"为什么这条没动" */
  skipped: Array<{ candidateId: string; reason: string }>;
}

/**
 * 执行编排（README §5 core/executor）。
 *
 * 职责边界刻意收得很窄：**它只决定"哪些候选该执行"，不决定"怎么执行"**。
 * 具体的改写由注册表里的执行器完成，core 不认识 ts-morph 与 sharp。
 *
 * 只执行 `apply` 与 `confirm` 两种裁决：
 * - `apply`：自动执行，产出 patch 后交给 verifier
 * - `confirm`：**也产出 patch**，但标记为待人工确认 —— B 类的价值就在"有补丁可看"
 * - `suggest` / `reject`：不执行。C 类只出建议，reject 本就该什么都不做
 */
export class ExecutorOrchestrator {
  private readonly options: ExecutorOptions;

  constructor(options: ExecutorOptions) {
    this.options = options;
  }

  async execute(input: ExecuteInput): Promise<ExecuteOutcome> {
    const { registry, store, logger } = this.options;

    const byId = new Map(input.candidates.map((c) => [c.id, c]));
    const executable = input.decisions.filter(
      (d) => d.verdict === 'apply' || d.verdict === 'confirm',
    );

    const results: ExecutionResult[] = [];
    const skipped: ExecuteOutcome['skipped'] = [];

    for (const decision of executable) {
      const candidate = byId.get(decision.candidateId);
      if (candidate === undefined) {
        skipped.push({ candidateId: decision.candidateId, reason: '找不到对应的候选' });
        continue;
      }

      const executor = registry.forCandidate(candidate);
      if (executor === null) {
        skipped.push({
          candidateId: candidate.id,
          reason: `没有执行器能处理改动类型 ${[...new Set(candidate.changes.map((c) => c.type))].join('/')}`,
        });
        continue;
      }

      try {
        /**
         * **只有「允许写入 且 裁决为 apply」的候选可以碰工作区。**
         *
         * 二进制资产（图片转码）没有文本补丁，执行器直接写盘 —— 而写盘之后
         * 只有验证阶段会回滚它。两种情况下它写下的文件既没人验、也没人回滚：
         *
         * 1. B 类（`confirm`）：补丁等人工确认，不进验证
         * 2. 守卫不通过（工作区不干净 / 没有 git）：验证阶段整个跳过
         *
         * 实现方式是把 `writeFile` 从上下文里去掉，而不是给执行器传一个
         * "你该不该写"的标志位：执行器**没有能力**判断这两件事，
         * 拿掉写文件的能力，它自然就只能产出评估结果。
         */
        const mayWrite = decision.verdict === 'apply' && input.allowWrite !== false;

        const context = mayWrite
          ? this.options.createContext(input.runId)
          : withoutWriteAccess(this.options.createContext(input.runId));

        const result = await executor.execute(candidate, context);

        // 既没有补丁也没有文件改动 = 什么都没做，不该记成一次执行
        if (result.patch === '' && result.files.length === 0) {
          skipped.push({ candidateId: candidate.id, reason: result.summary });
          logger.debug('候选未产出改动', { candidateId: candidate.id, summary: result.summary });
          continue;
        }

        await store.saveJson(input.runId, `executions/${candidate.id}.json`, result);
        if (result.patch !== '') await store.savePatch(input.runId, candidate.id, result.patch);

        results.push(result);
        logger.debug('执行完成', {
          candidateId: candidate.id,
          route: executor.route,
          files: result.files.length,
        });
      } catch (err) {
        const error = toPerfPilotError(err);
        // 单个候选执行失败不影响其余候选
        skipped.push({ candidateId: candidate.id, reason: `${error.code}: ${error.message}` });
        logger.error('候选执行失败', { candidateId: candidate.id, error: error.message });
      }
    }

    return { results, skipped };
  }
}

/** 去掉 `writeFile` 的执行上下文：执行器只能读，不能写 */
function withoutWriteAccess(context: ExecutionContext): ExecutionContext {
  const { writeFile: _dropped, ...readOnly } = context;
  void _dropped;
  return readOnly;
}
