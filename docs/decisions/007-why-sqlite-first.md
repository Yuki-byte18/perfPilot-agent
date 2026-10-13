# ADR 007：为什么先 SQLite，Postgres 留到服务端

- **状态**：已采纳
- **日期**：M1 定方向，M6 落地
- **相关**：README §10 记忆系统、`packages/shared/src/ports/memory.ts`

---

## 背景

记忆系统要存四类数据（README §10）：

| 记忆 | 内容 |
| --- | --- |
| 历史诊断 | 同一页面历次诊断的指标与瓶颈 |
| 方案库 | 候选方案及其验证结果（成功/失败/实际收益） |
| 项目画像 | 技术栈、构建工具、基线、偏好 |
| 失败记忆 | 哪些修复失败过、原因 |

直觉上"持久化 = 上数据库"，而数据库第一反应是 Postgres。

## 决策

**本地与 CI 用 SQLite（零配置、单文件），服务端用 Postgres；两者实现同一个 `MemoryPort`。**

`packages/shared/src/ports/memory.ts` 定义接口，`core/memory` 只依赖接口。

## 理由

### 1. CI 里不该为了"记录历史"而依赖一个外部数据库

`perfpilot run` 的主场景是 CI 流水线。如果每次运行都需要连一个 Postgres：

- 每个使用者的 CI 都要配一个数据库（连接的便利性直接决定工具能不能推广）
- 数据库不可用时工具会怎样？降级？失败？—— 多了一种与"性能诊断"无关的失败模式
- 本地开发者想跑一次诊断，也得先起数据库

SQLite 是一个文件。`.perfpilot/memory.db`。删掉就是清空历史。

### 2. `MemoryPort` 让存储选择变成实现细节，而不是架构决定

这和整个项目的依赖倒置是同一条思路（硬约束 4）：

```
core/memory  →  MemoryPort  ←  SQLite 实现（adapters/memory）
                            ←  Postgres 实现（adapters/memory，骨架）
                            ← 内存实现（shared，单测用）
```

直接效果：**core 不 import 任何数据库驱动**。M1 起所有涉及存储的测试都用内存实现，
单测全程不碰磁盘 —— 因此 CI 里不会出现"本地过了、容器里因为权限挂了"这类问题。

M6 落地时这条线被真的走了一遍：SQLite 实现放在 `adapters/memory`，
`core/memory` 里只有纯逻辑（画像推断、召回编排、失败记忆的构造规则）。
README 的 M6 交付清单原本写的是「`core/memory`（SQLite 实现）」，
落点与那句措辞不同 —— 但改的是位置，不是意图：驱动是外部依赖，
放进 core 就等于把「core 只依赖 shared」这条能被机械检查的约束作废。

**用什么驱动也算在这条线里**：选了 Node 自带的 `node:sqlite` 而不是 `better-sqlite3`，
因为后者是**原生扩展** —— CI 里多一个原生扩展就多一类"在我机器上能跑"的问题
（编译工具链、Node ABI 匹配、Windows 上尤其麻烦）。代价是 `node:sqlite`
仍标记为 experimental，因此取值走 `process.getBuiltinModule('node:sqlite')`
并集中在 `adapters/memory/sqlite.ts` 一个函数里：要换驱动改这里。

### 3. 先做 SQLite 能让闭环更早跑通

项目的第一优先级是**把八段闭环跑通**（采集→…→回滚），而不是把存储做得多强。
SQLite 能在一小时内提供可用的记忆，Postgres 需要先有服务的部署形态（M7 之后才有意义）。

**先把闭环跑通，再优化其中一环。**

## 取舍

**放弃了**：

- 多进程/多 job 并发写。SQLite 是单写者模型，并行跑多个 `perfpilot` 会争锁。
- 开箱即用的"团队共享记忆"。SQLite 是每个工作区一份，天然不共享。

**当前应对**：并行 CI job 各自使用独立 db（把 `memory.url` 指向 job 专属路径），
或先不启用记忆。**这是一个真实限制，不该假装没有。**

**换来了**：

- 零配置可用；本地、CI、容器行为一致
- 存储实现可替换，且替换不影响 core 一行代码
- 单测完全不依赖存储

**什么时候该换 Postgres**：当出现「**多个 CI job / 多台机器需要共享同一份记忆**」时
（比如团队想看到"这个项目历史上所有优化尝试"）。
在那之前，SQLite 是正确选择 —— 而不是"先把 Postgres 搭好，将来用得上"。
