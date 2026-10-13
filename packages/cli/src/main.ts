import { Command } from 'commander';
import { CORE_VERSION } from '@yuki-byte18/core';
import type { ExitCode } from '@yuki-byte18/shared';
import { execute, type ExecuteOptions } from './commands/execute.js';
import { fix, type FixOptions } from './commands/fix.js';
import { history } from './commands/history.js';
import { init } from './commands/init.js';
import { serve } from './commands/serve.js';

export interface MainDeps {
  cwd?: string;
  /** 测试注入：返回退出码而不真的退出进程 */
  onExit?: (code: ExitCode) => void;
}

/**
 * 命令注册。
 *
 * 与 `index.ts`（bin shim）分开，是为了让命令定义可以被测试直接构造，
 * 而不需要 spawn 一个子进程 —— 子进程测试在 Windows 上尤其脆。
 */
export function buildProgram(deps: MainDeps = {}): Command {
  const cwd = deps.cwd ?? process.cwd();
  const program = new Command();

  program
    .name('perfpilot')
    .description('前端性能诊断与自动优化 Agent')
    .version(CORE_VERSION)
    .showHelpAfterError();

  const withCommon = (command: Command): Command =>
    command
      .option('-c, --config <path>', '配置文件路径', '.perfpilot.yml')
      .option('-u, --url <url>', '覆盖 target.url')
      .option('-r, --routes <list>', '逗号分隔的路由列表，覆盖 target.routes')
      .option('-d, --device <device>', 'mobile | desktop', 'mobile')
      .option('-b, --baseline <runId>', '基线运行 ID（默认：同项目 + 同路由 + 同设备的上一次运行）')
      .option('--json', '输出 JSON 报告到 stdout')
      .option('-q, --quiet', '只写文件，不输出报告')
      .option('-v, --verbose', '输出 debug 日志');

  withCommon(
    program
      .command('run')
      .description('跑完整闭环：采集 → 诊断 → 方案 → 决策 → 执行 → 验证 → 保留/回滚 → 报告')
      .option('--dry-run', '只生成 patch，不修改工作区')
      .option('--ci', 'CI 模式：门禁未通过时返回退出码 1')
      .option('--max-regression <score>', '覆盖配置里的 max_regression（临时放宽/收紧门禁）'),
  ).action(async (options: ExecuteOptions) => {
    deps.onExit?.(await execute({ ...options, cwd, apply: true }));
  });

  withCommon(
    program.command('diagnose').description('只诊断，产出报告，不修改任何代码'),
  ).action(async (options: ExecuteOptions) => {
    deps.onExit?.(await execute({ ...options, cwd, apply: false }));
  });

  program
    .command('init')
    .description('生成 .perfpilot.yml（自动检测包管理器 / 检查脚本 / 仓库，只问测量地址）')
    .option('-c, --config <path>', '写入哪个配置文件', '.perfpilot.yml')
    .option('-u, --url <url>', '测量地址（给了就不再交互询问）')
    .option('-r, --routes <list>', '逗号分隔的路由列表', '/')
    .option('--llm <provider>', '接 LLM：none | deepseek | openai | anthropic（默认不接）')
    .option('--ci <platform>', '生成 CI 门禁文件：auto | github | gitlab | none')
    .option('-y, --yes', '非交互：全部用检测值与建议值')
    .option('--force', '覆盖已存在的配置')
    .action(
      async (options: {
        config?: string;
        url?: string;
        routes?: string;
        llm?: string;
        ci?: string;
        yes?: boolean;
        force?: boolean;
      }) => {
        deps.onExit?.(
          await init({
            cwd,
            ...(options.config !== undefined ? { configPath: options.config } : {}),
            ...(options.url !== undefined ? { url: options.url } : {}),
            ...(options.routes !== undefined ? { routes: options.routes } : {}),
            ...(options.llm !== undefined ? { llm: options.llm } : {}),
            ...(options.ci !== undefined ? { ci: options.ci } : {}),
            ...(options.yes !== undefined ? { yes: options.yes } : {}),
            ...(options.force !== undefined ? { force: options.force } : {}),
          }),
        );
      },
    );

  program
    .command('history')
    .description('查看历史记录')
    .option('-c, --config <path>', '配置文件路径', '.perfpilot.yml')
    .option('-p, --project <name>', '按项目过滤')
    .option('-n, --limit <count>', '最多显示条数', '20')
    .option('--show-failures', '只看失败记忆（哪些改法失败过、为什么）')
    .option('--forget <fingerprint>', '忘掉指定指纹的失败记忆（被误判拦下的改法可以这样放行）')
    .option('--forget-all', '忘掉本项目的全部失败记忆')
    .action(
      async (options: {
        config?: string;
        project?: string;
        limit?: string;
        showFailures?: boolean;
        forget?: string;
        forgetAll?: boolean;
      }) => {
        deps.onExit?.(
          await history({
            cwd,
            ...(options.config !== undefined ? { config: options.config } : {}),
            ...(options.project !== undefined ? { project: options.project } : {}),
            ...(options.limit !== undefined ? { limit: options.limit } : {}),
            ...(options.showFailures !== undefined ? { showFailures: options.showFailures } : {}),
            ...(options.forget !== undefined ? { forget: options.forget } : {}),
            ...(options.forgetAll !== undefined ? { forgetAll: options.forgetAll } : {}),
          }),
        );
      },
    );

  program
    .command('fix')
    .description('对上一轮诊断出的候选执行改动（产出 patch → 应用 → 验证 → 保留/回滚）')
    .option('-c, --config <path>', '配置文件路径', '.perfpilot.yml')
    .option('--run <runId>', '指定 run；默认取最近一次')
    .option('--candidate <id>', '只处理指定候选')
    .option('--only <class>', '只处理某一级：A / B / C')
    .option('--dry-run', '只生成 patch，不修改工作区')
    .option('--allow-dirty', '允许在工作区有未提交改动时执行（回滚会丢弃这些改动）')
    .option('--json', '输出 JSON 结果')
    .option('-q, --quiet', '不输出报告')
    .option('-v, --verbose', '输出 debug 日志')
    .action(async (options: FixOptions) => {
      deps.onExit?.(await fix({ ...options, cwd }));
    });

  program
    .command('serve')
    .description('启动只读报告服务（API + Web 报告页）')
    .option('-c, --config <path>', '配置文件路径', '.perfpilot.yml')
    .option('-p, --port <port>', '监听端口', '3080')
    .option('--host <host>', '监听地址（默认 127.0.0.1，报告含内部信息，别随手对外）', '127.0.0.1')
    .option('--token <token>', '访问令牌（暴露到网络时必设；也可用环境变量 PERFPILOT_TOKEN）')
    .option('-v, --verbose', '输出 debug 日志')
    .action(
      async (options: {
        config?: string;
        port?: string;
        host?: string;
        token?: string;
        verbose?: boolean;
      }) => {
        deps.onExit?.(
          await serve({
            cwd,
            ...(options.config !== undefined ? { config: options.config } : {}),
            ...(options.port !== undefined ? { port: options.port } : {}),
            ...(options.host !== undefined ? { host: options.host } : {}),
            ...(options.token !== undefined ? { token: options.token } : {}),
            ...(options.verbose !== undefined ? { verbose: options.verbose } : {}),
          }),
        );
      },
    );

  return program;
}
