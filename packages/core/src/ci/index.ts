import {
  toPerfPilotError,
  type Candidate,
  type Decision,
  type Diagnosis,
  type ExecutionResult,
  type GitPort,
  type LoggerPort,
  type PerfPilotConfig,
  type RunRecord,
  type RunStorePort,
  type ScmPort,
  type Verification,
} from '@yuki-byte18/shared';
import { MR_COMMENT_MARKER, renderMrComment } from '../reporter/mr-comment.js';
import type { CiGateResult } from '../gate/index.js';

/**
 * CI 发布（README §12、M7 验收 3/4）。
 *
 * 三件事，按"失败也无所谓"的程度排序：
 *
 * 1. **把评论写成文件**（`mr-comment.md`）—— 永远做。CI 里 artifact 上传
 *    是最可靠的分发方式：不需要 token、不需要网络权限，而且人能直接看。
 * 2. **发到 MR 上**（`comment_mr: true`）—— 做不成只是少了个便利。
 * 3. **建 PR**（`auto_pr: true`）—— 会改动远端，因此最后做，
 *    且需要 git + scm 两个端口都齐。
 *
 * ## 一条硬规则：发布失败不能让门禁结论变红
 *
 * 评论发不出去是**平台问题**（token 过期、网络抖动、权限不足），
 * 与"这次改动的性能过不过关"无关。把它算进门禁，会让一个真正绿灯的
 * 提交因为 GitHub API 500 而失败 —— 于是团队学会重跑 CI 直到绿为止，
 * 门禁就此失去意义。所有发布失败都变成 note 与 warning。
 */

/** CI 环境上下文，由适配器从环境变量里读出来（core 不碰 process.env） */
export interface CiPublishContext {
  provider: 'github' | 'gitlab' | 'none';
  mrId: string | null;
  baseBranch: string | null;
  headBranch: string | null;
  commitSha: string | null;
  eventName: string | null;
}

export interface PublishInput {
  run: RunRecord;
  diagnosis: Diagnosis | null;
  candidates: readonly Candidate[];
  decisions: readonly Decision[];
  executions: readonly ExecutionResult[];
  verifications: readonly Verification[];
  config: PerfPilotConfig;
  store: RunStorePort;
  logger: LoggerPort;
  scm: ScmPort | null;
  git: GitPort | null;
  ci: CiPublishContext;
  gate: CiGateResult | null;
  /** 报告链接（服务端或 artifact 地址） */
  reportUrl?: string | null;
}

export interface PublishOutcome {
  /** 评论是否真的发到了 MR 上 */
  commentPosted: boolean;
  /** 评论文件的落盘路径；没写成时为 null */
  commentFile: string | null;
  /** 自动 PR 的地址；没建时为 null */
  prUrl: string | null;
  /** 面向用户的说明（"没发出去，因为……"） */
  notes: string[];
}

export async function publishCiReport(input: PublishInput): Promise<PublishOutcome> {
  const { logger, store, scm, git, ci, config, run } = input;
  const notes: string[] = [];

  // ── 1. 评论总是先落盘 ──────────────────────────────────────────
  const body = renderMrComment({
    run,
    diagnosis: input.diagnosis,
    candidates: input.candidates,
    decisions: input.decisions,
    verifications: input.verifications,
    reportUrl: input.reportUrl ?? null,
    gate: input.gate,
  });

  let commentFile: string | null = null;
  try {
    commentFile = await store.saveReport(run.id, {
      format: 'markdown',
      filename: 'mr-comment.md',
      content: body,
    });
  } catch (err) {
    notes.push(`评论文件写入失败：${toPerfPilotError(err).message}`);
  }

  // ── 2. 发到 MR（有旧评论就更新，没有才新建）─────────────────────
  let commentPosted = false;
  if (!config.report.comment_mr) {
    notes.push('`report.comment_mr` 为 false，评论只落盘未发布');
  } else if (scm === null) {
    notes.push('未接入 SCM，评论只落盘未发布');
  } else if (ci.mrId === null) {
    // 在 main 分支上推代码时没有 MR 编号 —— 这是正常情况，不是错误
    notes.push('当前不是 MR / PR 触发，评论只落盘未发布');
  } else {
    try {
      /**
       * 用 upsert 而不是追加。
       *
       * MR 会被反复推送，每次推送都跑一轮 CI。只追加的话，一个来回十几次的 MR
       * 会攒出十几条几乎一样的评论 —— 评审的人会把整个区块折叠掉，
       * 门禁结论再也没人看。判据是正文里的 `MR_COMMENT_MARKER`。
       */
      const action = await scm.upsertComment(ci.mrId, MR_COMMENT_MARKER, body);
      commentPosted = true;
      logger.info(action === 'updated' ? 'MR 评论已更新' : 'MR 评论已发布', {
        mrId: ci.mrId,
        provider: scm.provider,
      });
    } catch (err) {
      // 平台问题：记下来，但不影响门禁
      notes.push(`MR 评论发布失败：${toPerfPilotError(err).message}`);
      logger.warn('MR 评论发布失败', { error: toPerfPilotError(err).message });
    }
  }

  // ── 3. 自动 PR ────────────────────────────────────────────────
  let prUrl: string | null = null;

  if (config.report.auto_pr) {
    if (scm === null || git === null) {
      notes.push('未接入 SCM 或 git，跳过自动 PR');
    } else if (input.verifications.length === 0) {
      // 没有验证结论的 PR 不该发出去：那等于把"没人验过的改动"推给人
      notes.push('本次没有任何验证结论，跳过自动 PR');
    } else {
      try {
        prUrl = await createOptimizationPr({ ...input, scm, git, body });
        if (prUrl !== '') {
          logger.info('自动 PR 已创建', { prUrl });
        } else {
          // 平台返回了成功但没有 URL：不假装成功
          notes.push('PR 创建返回成功但未拿到地址，请到平台上确认');
          prUrl = null;
        }
      } catch (err) {
        notes.push(`自动 PR 创建失败：${toPerfPilotError(err).message}`);
        logger.warn('自动 PR 创建失败', { error: toPerfPilotError(err).message });
      }
    }
  }

  return { commentPosted, commentFile, prUrl, notes };
}

/**
 * 创建优化 PR。
 *
 * 分支名带 runId 而不是时间戳：同一个 run 重跑两次不该产生两个分支 ——
 * CI 重试是常态，每次重试都往远端推一个新分支很快就没法收拾了。
 */
async function createOptimizationPr(
  input: PublishInput & { scm: ScmPort; git: GitPort; body: string },
): Promise<string> {
  const { git, scm, ci, run, verifications } = input;

  const head = ci.headBranch ?? `perfpilot/${run.id}`;
  const base = ci.baseBranch ?? 'main';

  await git.push(head);

  const kept = verifications.filter((v) => v.status === 'kept');
  const rolled = verifications.filter((v) => v.status === 'rolled_back');

  const summary = [
    `## PerfPilot 自动优化 — ${run.project}`,
    '',
    `run \`${run.id}\` · 路由 \`${run.route}\` · 设备 \`${run.device}\``,
    '',
    `- 保留 **${kept.length}** 个改动（已通过验证）`,
    `- 回滚 **${rolled.length}** 个改动（未通过门禁，原因见下）`,
    '',
    '### 验证结论',
    '',
    ...verifications.map((verification) => {
      const gain = Object.entries(verification.gain)
        .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
        .map(([name, value]) => `${name} ${value > 0 ? '+' : ''}${value}`)
        .join('、');
      return `- \`${verification.candidateId}\` — **${verification.status}**${gain === '' ? '' : `（实际收益 ${gain}）`}${verification.gate.failedRules.length > 0 ? `：${verification.gate.failedRules.join('；')}` : ''}`;
    }),
    '',
    '### 补丁',
    '',
    `补丁文件在 \`.perfpilot/runs/${run.id}/patches/\`，每个候选一份 unified diff，可单独 \`git apply\` 复核。`,
    '',
    '<details><summary>完整报告</summary>',
    '',
    input.body,
    '',
    '</details>',
  ].join('\n');

  return scm.createPullRequest({
    title: `perfpilot: ${run.project} 性能优化（保留 ${kept.length} 项）`,
    body: summary,
    head,
    base,
  });
}
