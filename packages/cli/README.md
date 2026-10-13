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

## 退出码（CI 里用得上）

| 码 | 含义 |
| --- | --- |
| `0` | 通过（或非 CI 模式下的正常结束） |
| `1` | **门禁未通过** —— 只在带 `--ci` 时返回，这样本地跑不会因为"没达标"而看起来像命令失败 |
| `2` | 配置错误 |
| `3` | 采集失败（一条路由都没测到） |
| `4` | 内部错误 |

## CI 集成

`init --ci github` 会把下面的逻辑写进 `.github/workflows/perfpilot.yml`：
安装依赖 → 起 preview 服务器 → `perfpilot run --ci` → 上传报告 artifact →
（可选）把结论作为 PR 评论发出来。

要点：

- **基线**：默认拿"同项目 + 同路由 + 同设备"的上一次运行做对比，并把 `.perfpilot/` 目录缓存起来；
  也可以用 `-b <runId>` 显式指定。
- **门禁判的是回归**，不是绝对值：`gain ≥ min_gain`、单指标回退 ≤ `max_regression`、新增错误 ≤ `max_new_errors`。
  想卡绝对上限（例如"LCP 必须 < 2.5s"），写在 `baseline.metrics.<指标>.error` 里。
- 跑在 CI 里时，`target.repo` / `target.branch` 可以从环境变量推断；想让结论进 MR 评论，
  需要平台 token（`GITHUB_TOKEN` / `GITLAB_TOKEN`）。

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
