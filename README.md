# PerfPilot Agent

> 前端性能诊断与自动优化 Agent —— CI/CD 的性能质量门禁。
> Front-end performance diagnosis & auto-optimization agent: a performance quality gate for CI/CD.

---

## 它解决什么问题

性能回归是**慢慢发生的**：每个 PR 多引一个第三方脚本、少写一个 `loading="lazy"`、少拆一个 chunk，单次都只有几十毫秒，评审时没人会拦。等到有人说"首页怎么这么慢"，已经查不清是哪次改动造成的了。

PerfPilot 把这件事变成一个**可判定的门禁**：

| 阶段 | 做什么 |
| --- | --- |
| **测量** | Lighthouse + HAR + 构建产物分析，拿到真实指标（不是估算模型） |
| **归因** | 把"慢"落到具体瓶颈上，每条都带证据：是哪个包的哪段代码、哪个网络请求、哪次长任务 |
| **改** | 规划候选改动并**先出补丁**：A 类（确定且可测量）自动应用，B 类只出补丁等人工确认，C 类只给建议 |
| **验证** | 改动后**重新采集**，指标确实变好才保留；否则 `git` 回滚到原样 |
| **判门禁** | 与基线对比：回归超阈值、或新增了错误，CI 就红 —— 并附上报告 |

一句话原则：**每个优化都必须被验证过才留下，失败必须能回到原样。**

## 它不做什么

先看这个，比看功能列表更能判断它是否适合你：

- **不会在你没让它改的时候改代码。** `diagnose` 和 `serve` 是严格只读的；只有 `run`（和 `fix`）会动工作区，且要求 `git status` 干净。
- **不做生产环境压测。** 测的是本地预览服务或预发环境，以及构建产物。
- **不做后端性能。** 只测前端交付指标（LCP/CLS/INP/TBT、JS/CSS/图片体积、请求数等）。
- **不会留下没验证过的东西。** 改了必须测，测不过必须回滚 —— 这是硬约束，不是选项。
- **默认不调用任何 LLM。** `llm.provider` 默认 `none`：零调用、零成本。开启后 LLM 也只参与**诊断**（提出带证据的瓶颈），**不参与决策** —— 决策必须可复现。

## 安装与使用

> 目前还没发布到 npm，直接从源码用（发布后这里会改成 `npm i -D @perfpilot/cli`）。

```bash
git clone <这个仓库>
cd perfpilot-agent
pnpm install
pnpm build          # 六个包全部构建（含报告页）
```

然后到**你自己的项目**里：

```bash
cd /path/to/your-project

# 生成配置（自动识别包管理器、build 脚本、仓库；只问测量地址）
node /path/to/perfpilot-agent/packages/cli/dist/index.js init

# 先只诊断：不修改任何代码
node /path/to/perfpilot-agent/packages/cli/dist/index.js diagnose --url http://127.0.0.1:4173

# 看报告页（只读）
node /path/to/perfpilot-agent/packages/cli/dist/index.js serve --port 3099

# 完整闭环：应用 → 验证 → 保留/回滚（会真的改代码，工作区必须干净）
node /path/to/perfpilot-agent/packages/cli/dist/index.js run --url http://127.0.0.1:4173
```

前置条件：

- **Node ≥ 22.13**（记忆层用 `node:sqlite`，它在 22.13 之前还在 `--experimental-sqlite` 后面）
- 你的项目是 **git 仓库**且工作区干净（回滚靠 `git reset --hard`）
- 想测 LCP / CLS / TBT 需要 **Lighthouse + Chrome**；只测产物体积不需要
- 把 `.perfpilot/` 写进 `.gitignore`（`init` 会帮你加，**别删** —— 原因写在注释里）

## 命令

| 命令 | 做什么 |
| --- | --- |
| `perfpilot init` | 生成 `.perfpilot.yml`，可选生成 CI 门禁文件（`--ci github|gitlab`） |
| `perfpilot diagnose` | 只采集 + 诊断，产出报告，**不修改任何代码** |
| `perfpilot run` | 完整闭环：采集 → 诊断 → 方案 → 决策 → 执行 → 验证 → 保留/回滚 → 报告 |
| `perfpilot run --dry-run` | 只产出补丁，不动工作区 |
| `perfpilot fix` | 对上一轮诊断出的候选执行改动（`--only A` / `--candidate <id>`） |
| `perfpilot history` | 历史运行记录（`--show-failures` 看被回滚的那些） |
| `perfpilot serve` | 只读报告服务：API + 网页报告页 |

常用参数：`-u/--url` 覆盖测量地址、`-r/--routes` 覆盖路由、`-d/--device mobile|desktop`、`-b/--baseline <runId>` 指定基线、`--ci` 开启 CI 退出码语义。

## 门禁是怎么判的

`run --ci` 结束时综合三件事：

| 条件 | 含义 |
| --- | --- |
| `gain ≥ min_gain` | 这轮优化带来的总分不能太少 |
| `worstRegression ≤ max_regression` | 任何单个指标的变差不能超过阈值 |
| `newErrorCount ≤ max_new_errors` | 不能引入新的控制台错误 |

**门禁判的是"回归"，不是"绝对值"。** 想卡绝对上限（例如"LCP 必须 < 2.5s"），写在 `.perfpilot.yml` 的 `baseline.metrics.LCP.error` 里。

退出码：

| 码 | 含义 |
| --- | --- |
| `0` | 通过 |
| `1` | **门禁未通过**（只在带 `--ci` 时返回，避免本地跑因为不达标而看起来像失败） |
| `2` | 配置错误 |
| `3` | 采集失败（一条路由都没测到） |
| `4` | 内部错误 |

## CI 集成

`perfpilot init --ci github`（或 `--ci gitlab`）会在你的项目里生成门禁流水线：装依赖 → 起预览服务 → 跑 `run --ci` → **无论成败**都上传报告 → 按门禁结论决定流水线成败。

要点：

- **基线**跨运行保存在 `.perfpilot/` 里，流水线会缓存它；没有基线时首轮只记录、不判定。
- **auto-apply 需要 git 身份**：CI 里要先 `git config user.name/email`，否则"保留改动"会静默失败。
- GitLab 版模板见 [`ci/gitlab-perfpilot.yml`](./ci/gitlab-perfpilot.yml)。

## 架构

```
shared  ←  adapters  ←  core  ←  cli / server
  ↑                                        ↑
  └──────────  web（只能 import type）──────┘
```

| 包 | 职责 |
| --- | --- |
| [`@yuki-byte18/shared`](./packages/shared) | 类型 / zod schema / 端口定义 —— 全项目唯一类型来源 |
| [`@yuki-byte18/adapters`](./packages/adapters) | 外部工具适配器：Lighthouse、ts-morph、sharp、git、SQLite/Postgres |
| [`@yuki-byte18/core`](./packages/core) | 线性八段流水线、决策层（期望值模型）、报告渲染 |
| [`@yuki-byte18/cli`](./packages/cli) | 命令行入口 |
| [`@yuki-byte18/server`](./packages/server) | 只读报告 API |
| [`@yuki-byte18/web`](./packages/web) | 报告页（预构建的静态产物） |

依赖是**严格单向**的，由 ESLint 强制：`core` 不认识任何具体工具（只认识端口），`web` 对 `shared` 只能 `import type`，**决策层不许 import `core/llm`**（诊断错得起，决策错不起）。

## 文档

| 文件 | 内容 |
| --- | --- |
| [`spec.md`](./spec.md) | 完整规格：需求、接口定义、决策模型、里程碑验收、以及每一轮通盘审计的记录（含踩过的坑与教训） |
| [`docs/decisions/`](./docs/decisions) | ADR：为什么不用 DAG、为什么不用多 Agent、为什么 LLM 只主导诊断、为什么执行器只产出 patch…… |
| [`CONTRIBUTING.md`](./CONTRIBUTING.md) | 开发环境、硬规则、怎么加一条优化规则 |

## 开发

```bash
pnpm install
pnpm build
pnpm check        # lint + 循环依赖 + 类型 + 覆盖率门禁
pnpm test         # 单元测试
pnpm dev:web      # 报告页的 Vite 开发服务器
```

细节与约定见 [`CONTRIBUTING.md`](./CONTRIBUTING.md)。

## License

[MIT](./LICENSE)
