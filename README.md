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
pp="node /path/to/perfpilot-agent/packages/cli/dist/index.js"

$pp doctor                                  # ① 体检：环境、配置、git、地址、Lighthouse、LLM key
$pp init                                    # ② 生成 .perfpilot.yml（只问测量地址）
$pp diagnose --url http://127.0.0.1:4173    # ③ 只诊断：不修改任何代码
$pp serve --port 3099                       # ④ 看报告页（只读）
$pp run --preview --url http://127.0.0.1:4173   # ⑤ 完整闭环：改 → 验证 → 保留/回滚
```

前置条件：

- **Node ≥ 22.13**（记忆层用 `node:sqlite`，它在 22.13 之前还在 `--experimental-sqlite` 后面）
- 你的项目是 **git 仓库**且工作区干净（回滚靠 `git reset --hard`）
- 想测 LCP / CLS / TBT 需要 **Lighthouse + Chrome**；只测产物体积不需要
- 把 `.perfpilot/` 写进 `.gitignore`（`init` 会帮你加，**别删** —— 原因写在注释里）

---

# 命令手册

所有命令都可以加 `-c/--config <路径>` 指定配置文件（默认 `.perfpilot.yml`）。

## `doctor` —— 体检（**建议第一条就跑它**）

```bash
perfpilot doctor
```

逐项检查并给出**可直接执行的修法**：

| 检查 | 不合格的后果 |
| --- | --- |
| Node 版本 ≥ 22.13 | 记忆层用的 `node:sqlite` 在更早的版本上不可用 |
| 配置存在且合法 | 不合法会在启动时报错（退出码 2） |
| 是 git 仓库 | 改动了也没法回滚 |
| 工作区干净 | **`run` 会一个补丁都不应用**（回滚会抹掉未提交的改动） |
| `.gitignore` 忽略 `.perfpilot/` | 运行记录与基线库会被当成项目文件 |
| **测量地址能不能打开** | 打不开 → Lighthouse 报"拦在了错误页"、LCP/CLS/TBT 整块缺失 |
| Lighthouse 可用 | 缺它 → 只剩产物体积类指标 |
| LLM key 在环境里 | 缺它 → agent 静默降级为纯规则库 |
| 声明的检查脚本存在 | 不存在 → 那个检查会被跳过 |
| CI 文件里的占位符 | 不改成你的仓库地址 → CI 检出失败 |

退出码：有 ❌ 返回 2，只有 ⚠️ 返回 0。

> 这个工具最容易失败的方式不是"报错"，而是**什么都不做、看起来还正常**：补丁不应用（工作区脏）、指标测不到（服务没起）、agent 不干活（key 没设）。`doctor` 就是为这三种情况准备的。

## `init` —— 生成配置

```bash
perfpilot init                              # 交互式：检测完项目，只问你测量地址
perfpilot init --url http://127.0.0.1:4173 --yes   # 全自动采用检测值与建议值
perfpilot init --llm deepseek               # 同时接上 LLM（key 只从环境变量读）
perfpilot init --ci github                  # 同时生成性能门禁流水线
perfpilot init --force                      # 覆盖已存在的配置
```

它做四件事：检测项目（包管理器 / 构建工具 / 检查脚本 / git 远端）→ 写 `.perfpilot.yml` → 把 `.perfpilot/`（必要时还有 CI 检出目录）写进 `.gitignore` → 可选生成 CI 文件。

**已存在的配置不会被覆盖**（除非 `--force`）—— 那可能是你手改过的。

## `diagnose` —— 只诊断，不改代码

```bash
perfpilot diagnose --url http://127.0.0.1:4173
perfpilot diagnose --routes /,/dashboard --device desktop
perfpilot diagnose --json > report.json      # 机器可读
```

采集 + 诊断 + 出报告，**一个字节都不会改**。第一次接入时用它确认"能测到数据、瓶颈有证据"。

## `run` —— 完整闭环（**会改代码**）

```bash
perfpilot run --url http://127.0.0.1:4173
perfpilot run --preview --url http://127.0.0.1:4173   # 自己起预览服务，跑完自动停
perfpilot run --dry-run                                # 只产出补丁，不动工作区
perfpilot run --ci                                     # 门禁结论决定退出码
perfpilot run --max-regression 8                       # 临时放宽门禁
```

流程：采集 → 诊断 → 方案 → 决策 → **应用** → **重新采集验证** → 有效保留 / 无效回滚 → 报告。

- **A 类**改动会自动应用并验证；**B 类**只产出补丁等你确认；**C 类**只给建议。
- 前置：git 仓库 + 工作区干净。
- `--preview` 会从 `package.json` 找 `preview`（优先）或 `dev` 脚本，按 `target.url` 的端口起起来，轮询到就绪才开始测，跑完（含异常退出）**连同子孙进程一起收掉**。

## `fix` —— 对上一轮的候选执行改动

```bash
perfpilot fix --only B                     # 落地"等你确认"的那批
perfpilot fix --only A                     # 只落地全自动那类
perfpilot fix --candidate cand_8f2a        # 只落地指定的一个
perfpilot fix --run run_20260117T142530    # 指定某一轮 run（默认最近一次）
perfpilot fix --dry-run                    # 只出补丁
```

与 `run` 的区别：**不重新采集、不重新诊断**，直接拿上一轮已算好的候选走执行 → 验证 → 保留/回滚。

## `history` —— 历史记录

```bash
perfpilot history                          # 最近的运行
perfpilot history --show-failures          # 只看失败记忆：哪些改法试过、为什么失败
perfpilot history --forget <指纹>          # 忘掉某条（被误判拦下的改法可以这样放行）
perfpilot history --forget-all             # 忘掉本项目的全部失败记忆
```

失败记忆的意义：同一个改法失败过一次之后，下一轮不会再去试它 —— **记忆跨运行累积**，这也是它必须落 SQLite 而不是内存的原因。

## `serve` —— 只读报告服务

```bash
perfpilot serve --port 3099
perfpilot serve --host 0.0.0.0 --token <随机串>    # 暴露到内网时必须带 token
```

API + 网页报告页（总览 / 指标 / 诊断 / 优化 / 趋势）。**严格只读**：不触发采集、不执行改动、不写任何东西。

## 通用参数

| 参数 | 作用 |
| --- | --- |
| `-u, --url <url>` | 覆盖配置里的 `target.url` |
| `-r, --routes <list>` | 覆盖路由列表（逗号分隔） |
| `-d, --device <d>` | `mobile`（默认）/ `desktop` |
| `-b, --baseline <runId>` | 指定基线运行（默认取同路由同设备的上一次） |
| `--json` | 输出 JSON 报告到 stdout |
| `-q, --quiet` | 只写文件，不输出报告 |
| `-v, --verbose` | debug 日志 |

---

# 门禁是怎么判的

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
| `2` | 配置错误（环境没准备好时 `doctor` 也返回这个） |
| `3` | 采集失败（一条路由都没测到） |
| `4` | 内部错误 |

---

# CI 集成教程

## 第 0 步：先在心里有个数

- CI 里跑的是**构建产物**，不是 dev server：workflow 会先 `build` 再起 `preview`。
- 门禁判的是**和基线比有没有变差**；**第一次运行没有基线，只记录、不判定**，第二轮才有结论。
- 门禁没过时退出码是 **1**（只有 `--ci` 才有这个语义），报告**无论成败都会上传**。

## 第 1 步：让 CI 能拿到 PerfPilot

CI 里拿到工具有两条路，PerfPilot 用的是第二条：

| 方式 | 怎么拿 | 现状 |
| --- | --- | --- |
| 从 npm 装 | `npm i -D @perfpilot/cli` → `npx perfpilot run --ci` | 尚未发布 |
| **从 git 检出并构建** | `actions/checkout` 一份 PerfPilot → `pnpm install && pnpm build` → `node tools/perfpilot/packages/cli/dist/index.js run --ci` | ✅ 当前方式 |

所以：**把 PerfPilot 推到 GitHub**（你自己的账号即可）。
公开仓库最省事；私有仓库需要下一步配一个 token。

## 第 2 步：在你的项目里生成流水线

```bash
cd your-project
perfpilot init --ci github --url http://127.0.0.1:4173
```

生成 `.github/workflows/perfpilot.yml`，它按顺序做四件事：

1. 装依赖 → 构建 → **起预览服务并用 curl 轮询到就绪**
2. 检出 PerfPilot 到 `tools/perfpilot` 并构建它
3. 跑 `run --ci`（`continue-on-error`，让后面的上传照常执行）
4. **无论成败**上传报告与补丁，把报告贴进 job summary，最后按门禁结论决定 job 成败

`init` 还会把两个目录写进 `.gitignore`：`.perfpilot/`（运行记录与基线）和 `tools/perfpilot/`（CI 检出 PerfPilot 的位置 —— 它在你仓库里，不忽略的话"工作区永远不干净"，`run` 会拒绝应用任何改动）。

## 第 3 步：改三处（模板故意留空的地方）

1. **PerfPilot 的仓库地址**：

   ```yaml
   - name: 检出 PerfPilot
     uses: actions/checkout@v4
     with:
       repository: <你的用户名>/perfpilot-agent     # ← 把 CHANGE_ME 改掉
       path: tools/perfpilot
   ```

   一行命令改掉它：

   ```bash
   sed -i 's#CHANGE_ME/perfPilot-agent#<你的用户名>/perfpilot-agent#' .github/workflows/perfpilot.yml
   # Windows PowerShell:
   # (Get-Content .github\workflows\perfpilot.yml -Raw) -replace 'CHANGE_ME/perfPilot-agent','<你>/perfpilot-agent' | Set-Content .github\workflows\perfpilot.yml -Encoding utf8
   ```

2. **私有 PerfPilot 仓库要加 token**（公开仓库跳过这条）。默认的 `GITHUB_TOKEN` 只能访问当前仓库：

   ```yaml
       with:
         repository: <你>/perfpilot-agent
         path: tools/perfpilot
         token: ${{ secrets.PERFPILOT_TOKEN }}      # 一个只读 PAT
   ```

   然后在**你的项目**里：Settings → Secrets and variables → Actions → 新建 `PERFPILOT_TOKEN`。

3. **端口要一致**：workflow 里 `npm run preview -- --port 4173 --strictPort` 的端口，必须和 `.perfpilot.yml` 的 `target.url` 一致（模板默认都是 `4173`）。

## 第 4 步：推送，看第一次运行

```bash
git add .perfpilot.yml .github/workflows/perfpilot.yml .gitignore
git commit -m "ci: 接入 PerfPilot 性能门禁"
git push -u origin <你的分支>
```

打开 PR → **Actions** → 看 `PerfPilot 性能门禁`：

- 一次约 **5–10 分钟**（装依赖 + 构建双方 + Lighthouse）
- **首轮只记录**（报告会写明"无基线可比"），第二轮开始才有回归判定
- 结论在哪看：job summary（贴了完整报告）、artifact `perfpilot-report`（`report.md` / `report.html` / `gate.json` / `patches/`）、退出码

> 想让第二次尽快拿到基线：对 `main` 推一次（模板里 `push: branches: [main]` 也会跑），基线写进缓存的 `.perfpilot/`。

## 第 5 步：CI 里出问题先查这张表

| 症状 | 原因 | 修 |
| --- | --- | --- |
| 退出码 3 / 报告写"页面打不开" | 预览服务没起，或端口与 `target.url` 不一致 | 本地先验证：`npm run preview -- --port 4173`，`curl http://127.0.0.1:4173` 返回 200；再核对端口 |
| LCP / CLS 整块缺失，Lighthouse 报"Chrome 拦在了错误页" | 同上（Chrome 打不开这个地址） | 同上；或改用 `run --ci --preview`，让工具自己起服务 |
| 报告写"工作区不干净"，一个补丁都没应用 | CI 检出 PerfPilot 的 `tools/perfpilot/` 没被忽略 | 确认 `.gitignore` 里有 `tools/perfpilot/`（`init` 会加） |
| 写了"已保留改动"，但仓库里什么都没有 | CI 里没有 git 身份，`git commit` **静默失败** | 模板里有 `git config user.name/user.email` 步骤，别删 |
| 每次都只记录、从不判定 | `.perfpilot/` 缓存没生效，基线每轮都丢 | 确认 `actions/cache` 步骤还在（key/restore-keys 都指向 `.perfpilot`） |
| 本地跑得好、CI 一跑就红 | Node 版本、路径大小写（Windows 不区分 / Linux 区分）、缺 Chrome | 看 job summary 的阶段备注；Lighthouse 需要 Chrome（`ubuntu-latest` 自带） |
| 想快速判断"环境哪不对" | —— | 在 CI 里加一步 `node tools/perfpilot/packages/cli/dist/index.js doctor`，它会把上面这些都报出来 |

## GitLab CI

```bash
perfpilot init --ci gitlab
```

生成 `ci/perfpilot.yml`（**它不会动你的 `.gitlab-ci.yml`**），然后在 `.gitlab-ci.yml` 里加两行即可启用：

```yaml
include:
  - local: ci/perfpilot.yml
```

模板见 [`ci/gitlab-perfpilot.yml`](./ci/gitlab-perfpilot.yml)。

---

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
