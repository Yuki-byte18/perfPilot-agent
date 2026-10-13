# @yuki-byte18/cli

前端性能的诊断与自动优化 Agent，作为 CI/CD 的**性能质量门禁**使用。

它做三件事：

1. **诊断** —— 用 Lighthouse / HAR / 产物分析测量真实指标，把"慢"归因到具体瓶颈（附证据）；
2. **优化** —— 规划候选改动、按期望值裁决，**先出补丁**，通过检查后才应用；
3. **验证** —— 改动后重新采集，指标确实变好才保留，否则 `git` 回滚到原样。

一句话原则：**每个优化都必须被验证过才留下，失败必须能回到原样。**

## 要求

- **Node ≥ 22.13**（`node:sqlite` 在 22.5 出现，22.13 之前还在 `--experimental-sqlite` 后面）
- **git 仓库** —— 闭环里的"回滚"就是 `git reset --hard`；没有 git 时只能出补丁，不能应用
- 想测 LCP / CLS / TBT 需要 **Lighthouse**（`npm i -g lighthouse`）；只测产物与体积不需要

## 安装

```bash
npm i -D @yuki-byte18/cli      # 或 pnpm add -D @yuki-byte18/cli
```

## 快速开始

```bash
npx perfpilot doctor               # 先体检：环境/配置/git/测量地址/Lighthouse/LLM key，每条给修法
npx perfpilot init                 # 生成 .perfpilot.yml（自动检测包管理器/脚本/仓库，只问测量地址）
npx perfpilot diagnose             # 只采集 + 诊断：不修改任何代码
npx perfpilot run --dry-run        # 看会改什么：补丁落盘，不动工作区
npx perfpilot run                  # 完整闭环：应用 → 验证 → 保留/回滚
npx perfpilot serve --port 3099    # 打开报告页（只读）
```

`init` 顺手可以生成 CI 文件（GitHub Actions / GitLab CI），并且**先自校验**再写盘：

```bash
npx perfpilot init --ci github
```

## 它会改我的代码吗？

只有 `run`（以及 `fix`）会。候选按可自动化的程度分三级：

| 级别 | 含义 | `run` 里的行为 |
| --- | --- | --- |
| **A** | 改动确定、可测量收益 | 自动应用 → 验证 → 保留或回滚 |
| **B** | 需要同步更新引用等人工判断 | **只产出补丁**，`fix --only B` 才落地 |
| **C** | 建议 | 不出补丁，只在报告里说明 |

两条硬规则：

- **工作区必须干净**，否则一个补丁都不应用 —— 因为回滚会连带丢掉你未提交的改动。
  记得把 `.perfpilot/` 写进 `.gitignore`（`init` 会帮你加）。
- **验证不通过就回滚。** 报告里会留下这次失败，下一轮不会再试同一个方案。

## 命令手册

所有命令都支持 `-c/--config <路径>`（默认 `.perfpilot.yml`）。

| 命令 | 用途 | 会不会改代码 |
| --- | --- | :---: |
| `doctor` | 体检环境，每条结论给可执行的修法 | 不改 |
| `init` | 生成 `.perfpilot.yml`，可选生成 CI 文件 | 只写配置 |
| `diagnose` | 只采集 + 诊断，出报告 | **不改** |
| `run` | 完整闭环：改 → 验证 → 保留/回滚 | **会改** |
| `fix` | 对上一轮的候选执行改动 | **会改** |
| `history` | 历史记录与失败记忆 | 不改 |
| `serve` | 只读报告服务（API + 网页） | 不改 |

```bash
npx perfpilot doctor                                   # 建议第一条就跑它
npx perfpilot init --url http://127.0.0.1:4173 --yes   # 全自动生成配置
npx perfpilot diagnose --routes /,/dashboard           # 只诊断，可选路由
npx perfpilot run --preview                            # 自己起预览服务再跑闭环
npx perfpilot run --dry-run                             # 只出补丁，不动工作区
npx perfpilot run --ci                                  # 让门禁结论决定退出码
npx perfpilot fix --only B                              # 落地"等你确认"的那批
npx perfpilot history --show-failures                   # 哪些改法失败过、为什么
npx perfpilot serve --port 3099                         # 报告页 http://127.0.0.1:3099
```

通用参数：`-u/--url`、`-r/--routes`、`-d/--device mobile|desktop`、`-b/--baseline <runId>`、`--json`、`-q/--quiet`、`-v/--verbose`。

**`doctor` 查什么**（每一项都给"下一步敲什么命令"）：Node 版本、配置合法性、是不是 git 仓库、工作区干净不干净、`.gitignore` 有没有忽略运行产物、**测量地址能不能打开**、Lighthouse 装没装、LLM key 在不在环境里、声明的检查脚本存不存在、CI 文件里还有没有占位符。

> 这个工具最容易失败的方式不是"报错"，而是**什么都不做、看起来还正常**：工作区脏 → 补丁一个都不应用；预览服务没起 → 指标整块缺失；key 没设 → agent 静默降级。`doctor` 就是为这三种情况准备的。

## 门禁怎么判 + 退出码

`run --ci` 结束时综合三件事：`gain ≥ min_gain`、单指标回退 ≤ `max_regression`、新增错误 ≤ `max_new_errors`。

**它判的是"回归"，不是绝对值。** 想卡绝对上限（例如"LCP 必须 < 2.5s"），写在 `baseline.metrics.LCP.error` 里。

| 码 | 含义 |
| --- | --- |
| `0` | 通过（或非 CI 模式下的正常结束） |
| `1` | **门禁未通过** —— 只在带 `--ci` 时返回，这样本地跑不会因为"没达标"而看起来像命令失败 |
| `2` | 配置错误（环境没准备好时 `doctor` 也返回这个） |
| `3` | 采集失败（一条路由都没测到） |
| `4` | 内部错误 |

## CI 集成教程

### 1. 先有个数

- CI 里测的是**构建产物**：workflow 会先 `build` 再起 `preview`（不是 dev server）。
- **第一次运行没有基线，只记录、不判定**，第二轮才有"变好/变差"的结论。
- 门禁没过 → 退出码 1 → job 失败；报告**无论成败都会上传**，并贴进 job summary。

### 2. 让 CI 能拿到 PerfPilot

CI 里拿到工具有两条路，当前用的是第二条：

| 方式 | 怎么拿 | 现状 |
| --- | --- | --- |
| 从 npm 装 | `npm i -D @perfpilot/cli` → `npx perfpilot run --ci` | 尚未发布 |
| **从 git 检出并构建** | `actions/checkout` 一份 PerfPilot → `pnpm install && pnpm build` → `node tools/perfpilot/packages/cli/dist/index.js run --ci` | ✅ |

所以先**把 PerfPilot 推到 GitHub**（自己的账号即可）。公开仓库最省事；私有仓库需要第 4 步那个 token。

### 3. 生成流水线

```bash
npx perfpilot init --ci github --url http://127.0.0.1:4173
```

生成 `.github/workflows/perfpilot.yml`：装依赖 → 构建 → **起 preview 并 curl 轮询到就绪** → 检出并构建 PerfPilot → `run --ci` → 无论成败上传报告 + 写 job summary → 按门禁结论决定 job 成败。

`init` 同时把两个目录写进 `.gitignore`：`.perfpilot/` 和 `tools/perfpilot/`。
**后者别删** —— 那是 CI 检出 PerfPilot 的位置，就在你的仓库里；不忽略它，`git status` 永远是脏的，`run` 会拒绝应用任何改动。

### 4. 改三处（模板故意留空）

1. **PerfPilot 的仓库地址**：把 `repository: CHANGE_ME/perfPilot-agent` 改成 `<你的用户名>/perfpilot-agent`。
2. **私有仓库要加 token**（公开仓库跳过）：检出步骤加一行 `token: ${{ secrets.PERFPILOT_TOKEN }}`，并在你的项目里 Settings → Secrets and variables → Actions 建一个只读 PAT —— 默认的 `GITHUB_TOKEN` 只能访问当前仓库。
3. **端口一致**：workflow 里 `npm run preview -- --port 4173` 的端口，必须和 `.perfpilot.yml` 的 `target.url` 一致。

### 5. 推送，看第一次运行

```bash
git add .perfpilot.yml .github/workflows/perfpilot.yml .gitignore
git commit -m "ci: 接入 PerfPilot 性能门禁"
git push -u origin <分支>
```

开 PR → Actions → `PerfPilot 性能门禁`。一次约 5–10 分钟；结论在 job summary、artifact（`report.md` / `gate.json` / `patches/`）和退出码里。

### 6. CI 里出问题先查这张表

| 症状 | 原因 | 修 |
| --- | --- | --- |
| 退出码 3 / "页面打不开" | preview 没起，或端口与 `target.url` 不一致 | 本地验证 `curl http://127.0.0.1:4173` 返回 200；核对端口 |
| LCP / CLS 整块缺失 | 同上（Chrome 打不开这个地址） | 同上；或改用 `run --ci --preview` 让工具自己起服务 |
| 报告写"工作区不干净"，零补丁 | `tools/perfpilot/` 没被忽略 | 确认 `.gitignore` 里有它 |
| 写了"已保留"但仓库里什么都没有 | CI 里缺 git 身份，`git commit` 静默失败 | 保留模板里的 `git config user.name/user.email` 步骤 |
| 只记录、从不判定 | `.perfpilot/` 缓存没生效，基线每轮都丢 | 确认 `actions/cache` 步骤还在 |
| 想快速定位环境问题 | —— | 在 CI 里加一步 `node tools/perfpilot/packages/cli/dist/index.js doctor` |

**GitLab**：`init --ci gitlab` 生成 `ci/perfpilot.yml`（**不会动你的 `.gitlab-ci.yml`**），在你的流水线里 `include: - local: ci/perfpilot.yml` 即可。

## LLM 是可选功能，默认**关**

`llm.provider` 默认 `none`：一次调用都不会发生，也一分钱不花。
开启后 LLM 只参与**诊断**（提出带证据的瓶颈、细化归因），不参与决策 ——
决策必须可复现，见 ADR 008。

```bash
npm i -D ai @ai-sdk/openai        # 装在你自己的项目里
export DEEPSEEK_API_KEY=sk-...    # key 只放在环境变量里
```

```yaml
llm:
  provider: openai                # DeepSeek / Qwen / GLM / Ollama 都是 OpenAI 兼容接口
  base_url: https://api.deepseek.com
  model: deepseek-chat
  api_key_env: DEEPSEEK_API_KEY   # 这里只写变量名，key 本身永远不进配置文件
  maxCostUsd: 2                   # 硬预算：超出后自动退回仅规则库
```

没装 SDK 时 LLM 路径自动降级为"仅规则库"，并在报告里说明原因。

## 其它命令

```bash
npx perfpilot history --show-failures   # 历史运行（含被回滚的那些）
npx perfpilot fix --only A              # 对上一轮诊断出的候选执行改动
npx perfpilot fix --candidate cand_8f2a # 只落地指定的一个候选
```

## 许可

MIT
