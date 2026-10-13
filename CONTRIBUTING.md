# 参与开发

## 环境

| 要求 | 为什么 |
| --- | --- |
| **Node ≥ 22.13** | 记忆层用 `node:sqlite`；它在 22.5 出现，但直到 22.13 才不需要 `--experimental-sqlite` |
| **pnpm 11** | `package.json` 里锁了 `packageManager`，`corepack enable` 即可；pnpm 11 的 lockfile / store 格式与 10 不兼容 |
| **Lighthouse + Chrome**（可选） | 只有测 LCP / CLS / TBT 才需要；没有也不影响其它指标与构建产物分析 |

## 常用命令

```bash
pnpm install
pnpm build          # turbo 构建六个包（web 是 vite）
pnpm typecheck
pnpm test           # vitest
pnpm test:cov       # 覆盖率（门禁 70%）
pnpm lint           # eslint，含依赖边界规则
pnpm cycles         # madge 循环依赖检查
pnpm check          # 上面四项一次跑完 —— 提交前跑这个
pnpm clean          # 清 dist / coverage / .perfpilot

pnpm perfpilot diagnose --url http://127.0.0.1:4173   # 用源码直接跑 CLI（tsx）
pnpm dev:web                                          # 报告页开发服务器
```

## 两条不能破的规则

1. **依赖严格单向**：`shared ← adapters ← core ← cli/server`；`web` 只允许 `import type` 引用 `shared`。`core` 不许 import 任何具体 adapter（它只认识 `shared` 里的端口），`cli` 是唯一知道"用哪个实现"的地方。ESLint 会拦住违规。
2. **决策层不许 import `core/llm`。** 诊断错得起 —— 它是给人看的、带证据、可复核；决策错不起 —— 它要被机器执行，必须可复现。理由见 [ADR 008](./docs/decisions/008-why-llm-only-diagnosis.md)。

另外：所有外部工具调用都要经过 adapter，所有 LLM 调用都要经过 `core/llm`，所有外部输入都要用 zod 校验。

## 想加一条优化规则？

一条规则要跨四层，缺一层它就是"说了不做"：

| 层 | 位置 | 要做的事 |
| --- | --- | --- |
| 诊断 | `core/src/diagnoser/rules/` | 从指标里认出瓶颈，**必须带证据**（哪个文件/请求/长任务） |
| 规划 | `core/src/planner/rules/` | 把瓶颈变成候选改动，给出**可测量的**预期收益与置信度 |
| 执行 | `adapters/src/executor/` | 真的产出补丁（`patch-first`） |
| 验证 | 不需要改 | 但你的收益必须**能被重新采集测到**，否则一定被回滚 |

三个来自真实事故的提醒：

- **别把"不可能兑现的收益"写进候选。** 曾经有一条规则把「拆 vendor chunk」标成"预期节省 436KB"，而拆 chunk 前后 JS 总量完全相等 —— 它改善的是缓存命中，而这件事项目并不测量。现在那条规则降级成 C 类建议，`expectedGain` 留空。
- **别猜用户项目里的东西。** 同一条规则曾在 Vue 项目上生成 `vendor: ['react','react-dom']` —— 依赖清单在规划阶段根本拿不到，写出来的"示例值"就是编数据。
- **改完要能回滚。** 二进制资产没有文本补丁，它的回滚是靠 `git checkout`，得在 verifier 的回滚分支里照顾到。

## 测试怎么写

- **少而准。** 不追求数量，每条断言都要能回答"它挡住的是哪种真实错误"。
- **不编数字。** 测不了的东西就说没测 —— 例如报告页的性能预算测试（`packages/web/src/perf.test.ts`）明确写着"LCP < 2.5s 这个数字没有被真实测量过"，它检查的是决定 LCP 与 CLS 的**结构**，而不是编一个耗时出来。
- **测"这条规则的输出，是它真的知道的事实吗"。** 规则库是确定性的，它的错误也会确定地每轮重复。

## 仓库刚推上 GitHub 之后要改的三处

这三处都是"只有你自己知道答案"的信息，代码里故意留了占位：

| 位置 | 现状 | 改成 |
| --- | --- | --- |
| 根与各包的 `package.json` | 没有 `repository` / `homepage` / `bugs` | 加上 `"repository": {"type":"git","url":"git+https://github.com/<你>/perfpilot-agent.git","directory":"packages/<包名>"}` |
| 使用者项目里生成的 workflow | `repository: CHANGE_ME/perfPilot-agent` | 改成你的 PerfPilot 仓库（`init` 无法知道它将来的地址，所以留空而不是猜） |
| README（可选） | 没有 CI 徽章 | 想加就写 `![CI](https://github.com/<你>/perfpilot-agent/actions/workflows/ci.yml/badge.svg)` |

> 前两处填错或留空不会让任何东西崩，但 npm 页面与 GitHub 页面上的链接会是空的。

## 发布到 npm（目前没做）

`@yuki-byte18/cli` 现在还发不出去：npm 要求发布者账号开启 2FA，或使用带 "Bypass 2FA" 的 granular token，而后者已被 npm 逐步限制用于直接发布（[公告](https://github.blog/changelog/2026-07-31-restricting-npm-bypass-2fa-granular-access-tokens/)）。

现在能用的方式就是本 README 里那条：**从源码构建、用 `node .../dist/index.js` 运行**，CI 里也一样（生成的 workflow 会自动检出并构建 PerfPilot）。将来要发布，推荐走 **Trusted Publishing（OIDC）**：不需要在仓库里存任何 token。

发布流程本身（`pnpm release`）已经准备好了，细节见 [`spec.md` §17](./spec.md)。
