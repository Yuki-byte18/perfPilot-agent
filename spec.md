# PerfPilot Agent

> 前端性能诊断与自动优化 Agent —— 面向 CI/CD 的前端性能质量门禁。

[![node](https://img.shields.io/badge/node-%3E%3D20-black)](https://nodejs.org)
[![pnpm](https://img.shields.io/badge/pnpm-workspaces-orange)](https://pnpm.io)
[![typescript](https://img.shields.io/badge/typescript-strict-blue)](https://www.typescriptlang.org)

---

## 1. 项目定位与目标

PerfPilot Agent 不是一个"性能监控平台"，也不是一个"通用 Agent 框架"。

它解决一个具体问题：

> **代码合并前，没有人知道这次改动让页面慢了多少；知道的人，也没时间定位到是哪一行代码、哪张图片、哪个依赖导致的。**

传统做法有三条路，都不够好：

| 做法 | 问题 |
| --- | --- |
| Lighthouse CI 卡阈值 | 只告诉"变慢了"，不告诉"为什么"和"怎么改" |
| 人工看报告 | 不可规模化，结论不可复现，无法沉淀 |
| 接一个 LLM Agent 自由发挥 | 不确定、不可测、不可回滚，CI 里不敢开权限 |

PerfPilot 的答案是：**用确定性工程手段做采集、诊断、决策、验证与回滚；只在"生成候选方案"这一层使用 LLM，且 LLM 的输出必须经过确定性决策层打分与风险分级后才能落地。**

目标：

1. 把性能劣化从"感觉"变成**可归因的数字**（下钻到资源 / 组件 / 代码行 / 依赖版本）。
2. 把优化从"人肉经验"变成**可复用的方案库**（成功与失败都入库）。
3. 把优化落地变成**有验证、有回滚的自动化闭环**（收益不达标就回滚，Git 即记忆）。
4. 把这一切塞进 CI：`perfpilot run` 一条命令，产出报告 + MR 评论 + 可选的自动 PR。

---

## 2. 核心能力

| 能力 | 说明 |
| --- | --- |
| **采集** | Lighthouse、Playwright、Web Vitals、HAR、Trace、Bundle 六类数据源，统一为 `Metric[]` |
| **诊断** | 指标计算 → 瓶颈排序 → 归因下钻（resource / component / source line / dependency version / config） |
| **方案** | 规则库（确定性）+ LLM（生成式），产出带 `expectedGain` / `confidence` / `class` 的候选方案 |
| **决策** | 自研期望值效用模型（Jev 式）做工具路由 + 方案评分 + 风险分级（A/B/C），输出 `apply / confirm / suggest / reject`；**纯函数、不调 LLM** |
| **执行** | AST 改写、资源处理、配置修改，统一产出 **patch**（不直接改工作区） |
| **验证** | 单测 + E2E + 重新采集 + 收益对比，四项全过才保留 |
| **保留/回滚** | `gain > min_gain && regression < max_regression && newErrors == 0` → 保留 + 提 PR；否则回滚并写入失败记忆 |
| **输出** | Markdown / HTML / JSON 报告、MR 评论、自动 PR |
| **记忆** | 历史诊断、方案库、项目画像、失败记忆，支撑跨次召回 |

---

## 3. 执行链路

**线性八段流水线**，没有分支调度，没有动态依赖解析：

```
采集 → 诊断 → 方案 → 决策 → 执行 → 验证 → 保留/回滚 → 输出
collect diagnose plan  decide  execute verify  keep/rollback  report
```

```
┌──────────┐   ┌───────────┐   ┌────────┐   ┌────────┐
│ collect  │──▶│ diagnose  │──▶│  plan  │──▶│ decide │
└──────────┘   └───────────┘   └────────┘   └────────┘
   Promise.all     规则引擎     规则+LLM      期望值评分
   (并行采集)     (瓶颈排序)   (候选方案)    (风险分级)
                                                   │
      ┌────────────────────────────────────────────┘
      ▼
┌──────────┐   ┌──────────┐   ┌───────────────────┐   ┌──────────┐
│ execute  │──▶│  verify  │──▶│ keep / rollback   │──▶│  report  │
└──────────┘   └──────────┘   └───────────────────┘   └──────────┘
   生成 patch    单测+E2E+     达标保留+提 PR            MD/HTML/JSON
              重采集+对比     否则 git 回滚             MR 评论 / PR
```

每一步的产物都是**可校验的 JSON**（zod schema），并落盘到 `.perfpilot/runs/<runId>/`。失败时链路在**失败点**终止，已完成步骤的产物保留，便于复现与调试。

---

## 4. 架构

### 4.1 Monorepo 结构

```
perfpilot-agent/
├─ pnpm-workspace.yaml
├─ turbo.json
├─ tsconfig.base.json
├─ eslint.config.js               # 依赖边界规则在这里强制
├─ .perfpilot.yml                 # 项目配置（示例见 §11）
├─ docs/
│  └─ decisions/                  # ADR（见 §15）
├─ packages/
│  ├─ shared/                     # 类型 / schema / 错误 / 工具
│  │  └─ src/
│  │     ├─ types/                # Metric Diagnosis Bottleneck Candidate Decision Verification Config
│  │     ├─ schema/               # zod schema（与 types 一一对应）
│  │     ├─ ports/                # adapter 接口（依赖倒置的"接口"侧）
│  │     ├─ errors/               # PerfPilotError 及子类
│  │     └─ utils/                # 纯函数工具
│  ├─ adapters/                   # 工具适配器（实现 shared/ports）
│  │  └─ src/
│  │     ├─ lighthouse/  web-vitals/
│  │     ├─ bundle-analyzer/  source-map/  har/  trace/
│  │     ├─ executor/             # 四类执行器：AST 改写 / 资产 / 配置 / 依赖
│  │     ├─ asset/                # sharp 封装（转码 / 压缩 / 缩放）
│  │     ├─ git/                  # git 操作：回滚的唯一执行者
│  │     ├─ check-runner/         # 单测 / 类型检查 / lint / E2E
│  │     ├─ memory/               # MemoryPort 的 SQLite 实现 + Postgres 骨架
│  │     ├─ playwright/  github/  gitlab/  sentry/    # 待 M7
│  │     └─ registry.ts           # createAdapterRegistry()：组合根
│  ├─ core/                       # 核心引擎
│  │  └─ src/
│  │     ├─ pipeline/             # 八段编排（线性）
│  │     ├─ collector/  diagnoser/  planner/
│  │     ├─ decision/             # 期望值决策层（唯一决策入口）
│  │     ├─ executor/  verifier/  memory/  reporter/
│  │     ├─ storage/              # RunStorePort 的文件/内存实现
│  │     ├─ logger/               # pino 封装，全项目唯一日志出口
│  │     └─ llm/                  # 唯一 LLM 出口
│  ├─ cli/                        # bin: perfpilot
│  ├─ server/                     # 只读报告 API + 报告页静态托管（node:http，零依赖，见 M7）
│  └─ web/                        # React 报告页（Vite 构建，只 import type from shared）
├─ .github/workflows/ci.yml           # 本仓库自己的 CI（风格 / 循环依赖 / 类型 / 构建 / 测试）
├─ ci/gitlab-perfpilot.yml            # 给使用者的 GitLab 门禁模板
│                                     # （GitHub 版不落盘：由 `perfpilot init --ci github` 生成到使用者仓库）
├─ README.md  CONTRIBUTING.md         # 门面与开发约定
├─ .gitattributes                     # 换行统一成 LF（Windows 开发 / Linux 跑 CI）
```

### 4.2 依赖方向（严格单向，ESLint 强制）

```
shared  ←  adapters  ←  core  ←  cli
                          ↑
                          └──────  server

web  ──▶  shared（仅类型）
```

规则明细（全部由 `eslint.config.js` 的 `@typescript-eslint/no-restricted-imports` 强制，
**构建期报错而非代码评审发现**）：

| 规则 | 强制方式 |
| --- | --- |
| `shared` 不依赖任何内部包 | 禁止 group `@yuki-byte18/*` |
| `adapters` 只依赖 `shared` | 禁止 group `@yuki-byte18/{core,cli,server,web}` |
| `core` 不许 import 具体 adapter | 对 `@yuki-byte18/adapters` 设 `allowTypeImports: true`，只放行 `import type` |
| `core` 不许调用外部进程 | 禁止 `node:child_process` / `node:worker_threads` |
| `core` 不许直接发网络请求 | 禁止 `fetch` 全局 + 禁止 `axios`/`undici`/`node-fetch` |
| 只有 `core/llm` 能碰 LLM SDK | 其余模块禁止 `ai`/`@ai-sdk/*`/`openai` |
| `core/decision` 不许调用 LLM（硬约束 7） | 该目录额外禁止 import `**/llm/*` |
| `web` 只依赖 `shared` 类型 | 禁止 `@yuki-byte18/{core,adapters,cli,server}` |
| 统一 pino 日志（硬约束 12） | `no-console: error` |
| 禁止循环依赖 | `pnpm cycles`（`madge --circular`）进 CI |

> 为什么循环依赖用 madge 而不是 `eslint-plugin-import`：madge 零配置、直接对源码做图分析，
> 不需要为 flat config 再配一层 resolver；少一个需要调参的插件，就少一处会在 CI 上莫名其妙失败的地方。

**关于 `adapters ← core` 与"core 不许直接 import 具体 adapter"的精确落地**（硬约束 3 与 4 的调和）：

- **接口（port）定义在 `@yuki-byte18/shared/ports`** —— 满足硬约束 10「所有类型必须来自 shared」。
- **具体实现放在 `@yuki-byte18/adapters`** —— 满足硬约束 3 的 `shared ← adapters`。
- **`core` 只通过构造注入拿到 `AdapterRegistry`**，对 `@yuki-byte18/adapters` 的引用**仅允许 `import type`**，不含任何 `createXxxAdapter()` 运行时调用 —— 满足硬约束 4。
- **运行时装配在 `cli` / `server`** —— 组合根显式调用 `createAdapterRegistry(config)`，再 `new Pipeline({ adapters, llm, memory, config })`。

这样 `core` 可以在测试里注入 fake adapters，零网络、零浏览器即可跑完整链路。

### 4.3 外部边界铁律

1. 所有外部工具调用（lighthouse / playwright / sharp / git / http）**必须**经过 adapter —— core 里出现 `child_process` 或裸 `fetch` 视为违规。
2. 所有 LLM 调用**必须**经过 `core/llm` —— 其它模块不得持有 LLM client。
3. 所有决策**必须**经过 `core/decision` —— executor 不得自行判断"改不改"。
4. 所有优化**必须**经过 `core/verifier` 才能保留。
5. 所有外部输入（配置文件、CLI 参数、API body、adapter 原始输出）**必须**经 zod 校验后才能进入内部类型。

---

## 5. 各包职责

### `@yuki-byte18/shared`
- **类型**：全项目唯一类型来源（硬约束 10）。
- **schema**：每个类型都有对应 zod schema，`parseExternal()` 是所有外部数据的入口。
- **ports**：`CollectorPort` / `ExecutorPort` / `ReporterPort` / `LlmPort` / `MemoryPort` / `GitPort` / `ScmPort` 等接口。
- **errors**：`PerfPilotError`（含 `code` / `stage` / `cause` / `retryable`）。
- **utils**：纯函数（数值归一化、指标评分、路径处理、哈希），无副作用、无 IO。

### `@yuki-byte18/adapters`
每个适配器只做一件事：**把外部工具的原始输出翻译成 shared 类型**，不做判断、不做聚合。

| Adapter | 输入 | 输出 |
| --- | --- | --- |
| `lighthouse` | URL + 配置 | LCP/CLS/INP/TBT/FCP/TTFB/SI + opportunities |
| `playwright` | URL + 脚本 | 真实用户路径指标、E2E 断言、错误收集 |
| `web-vitals` | 页面注入 | 现场 Web Vitals（attribution） |
| `bundle-analyzer` | 构建产物 / stats | chunk 体积、重复依赖、未使用导出 |
| `source-map` | bundle + map | 压缩代码位置 → 源码 file:line |
| `har` | HAR 文件 | 请求瀑布、阻塞链、传输体积 |
| `trace` | Chrome trace | 主线程长任务、layout/scripting 归因 |
| `git` | repo | ref、diff、worktree、branch、commit |
| `github` / `gitlab` | API | MR 评论、PR 创建、流水线状态 |
| `sentry` | API | 新错误 / 回归错误（验证阶段用） |

`registry.ts` 导出 `createAdapterRegistry(config): AdapterRegistry`，是适配器层唯一对外组装入口。

### `@yuki-byte18/core`
| 模块 | 职责 | 关键约束 |
| --- | --- | --- |
| `pipeline` | 八段线性编排、产物落盘、错误短路 | 无动态调度；并行只在段内用 `Promise.all` |
| `collector` | 并发调起多个 adapter，归并为 `Metric[]` | 单 adapter 失败降级为 warning，不阻断链路 |
| `diagnoser` | 指标计算 → 瓶颈识别 → 排序 → 归因下钻 | 规则驱动，纯函数，可快照测试 |
| `planner` | 规则库 + LLM 生成 `Candidate[]`，召回记忆调整置信度 | LLM 输出必须 schema 校验，失败则只用规则库 |
| `decision` | **唯一决策入口**：期望值评分、工具路由、A/B/C 风险分级 | 纯函数、确定性、**禁止调用 LLM** |
| `executor` | 把 `apply/confirm` 的候选变成 patch | 不直接改工作区；只输出 diff |
| `verifier` | 单测 + E2E + 重采集 + 收益对比 | 任何检查失败 → `rolled_back` |
| `memory` | 四类记忆的读写与召回 | 只经 `MemoryPort`，不直接 import SQLite 驱动 |
| `reporter` | Markdown / HTML / JSON 渲染 | 纯模板 → 字符串，无 IO |
| `llm` | **唯一 LLM 出口**，prompt 版本化、重试、成本记账 | 其它模块不得持有 LLM client |

### `@yuki-byte18/cli`（bin: `perfpilot`）
参数解析（commander）、配置加载（zod 校验）、日志初始化（pino）、**组合根**、退出码语义。

### `@yuki-byte18/server`
Fastify API + 静态报告托管：`GET /runs`、`GET /runs/:id`、`GET /runs/:id/report`、`POST /run`。薄层，业务逻辑全部在 core。

### `@yuki-byte18/web`
React + Vite 报告页。**只依赖 `@yuki-byte18/shared` 的类型**，通过 server API 取数。展示：指标趋势、瓶颈下钻、候选→决策→验证时间线、回滚记录。

---

## 6. 技术栈

| 关注点 | 选型 | 说明 |
| --- | --- | --- |
| 语言 | TypeScript（strict） | `noUncheckedIndexedAccess`、`exactOptionalPropertyTypes` 开启 |
| 运行时 | Node.js ≥ 20 | 原生 test runner 不用，统一 Vitest |
| 包管理 | pnpm workspaces | `workspace:*` 协议 |
| 构建 | Turborepo | 只做任务编排与缓存，不做运行时调度 |
| CLI | commander | 5 个命令，不需要 clipanion 的复杂路由 |
| 服务 | Fastify | 比 Express 快，schema 校验原生支持 |
| Web | React + Vite | 只读报告页，不需要 SSR |
| 校验 | zod | 所有外部输入 |
| LLM | Vercel AI SDK（OpenAI / Anthropic provider） | 统一经 `core/llm` 封装 |
| 决策 | 自研（零依赖） | 期望值效用模型；`utility = 收益×置信 − 成本 − λ×风险`，见 ADR 003 |
| 存储 | SQLite（本地） / Postgres（服务） | 同一 `MemoryPort` 两套实现 |
| 测试 | Vitest + Playwright | 单测 + E2E，覆盖率门禁 70% |
| AST | ts-morph（优先）/ jscodeshift | ts-morph 类型友好，仅在需要时降级 jscodeshift |
| 图片 | sharp | WebP/AVIF 转换与压缩 |
| 日志 | pino | 唯一日志出口，JSON 结构化 |

---

## 7. 关键接口定义

```ts
// ─────────────────────────────────────────────────────────────
// packages/shared/src/types/metric.ts
// ─────────────────────────────────────────────────────────────

export type MetricName =
  | 'LCP' | 'CLS' | 'INP' | 'FCP' | 'TTFB' | 'TBT' | 'SI'
  | 'JS_SIZE' | 'CSS_SIZE' | 'IMAGE_SIZE' | 'TRANSFER_SIZE'
  | 'REQUEST_COUNT' | 'DUPLICATE_DEPS' | 'UNUSED_DEPS';

export type MetricUnit = 'ms' | 'score' | 'byte' | 'count';
export type Rating = 'good' | 'needs-improvement' | 'poor';

export interface Metric {
  name: MetricName;
  value: number;
  unit: MetricUnit;
  rating: Rating;
  /** 归一化到 0-100，越大越好，用于统一打分与收益计算 */
  score: number;
  route: string;
  device: 'mobile' | 'desktop';
  /** 产出该指标的 adapter，便于追溯 */
  source: AdapterId;
  collectedAt: string; // ISO 8601
}

export interface MetricDelta {
  name: MetricName;
  /** 无基线时为 null —— 不编造 0，否则「缺失」会被读成「零变化」 */
  baseline: number | null;
  current: number;
  /** 正 = 改善，负 = 回归，单位与指标一致。基线缺失时为 null */
  delta: number | null;
  /** 正 = 改善，负 = 回归。基线为 0 时不可计算，返回 null 而非 Infinity */
  deltaPercent: number | null;
  baselineScore: number | null;
  currentScore: number;
  /** 正 = 改善，负 = 回归，纯分数差。门禁与决策用这个字段，跨指标同尺度 */
  scoreDelta: number | null;
}

/**
 * 适配器产出的**未打分**样本：只有名字和值。
 *
 * 刻意不让 adapter 产出 `Metric`：`unit` / `rating` / `score` 由规格表加项目阈值唯一决定，
 * 若每个 adapter 各自算一遍，迟早出现两个 adapter 对同一指标给出不同 rating。
 * 打分统一在 core/collector 完成，阈值覆盖也就在那一个地方生效。
 */
export interface MetricSample {
  name: MetricName;
  value: number;
}

// ─────────────────────────────────────────────────────────────
// packages/shared/src/types/bottleneck.ts
// ─────────────────────────────────────────────────────────────

export type BottleneckKind =
  | 'OVERSIZED_IMAGE' | 'UNCOMPRESSED_IMAGE' | 'MISSING_DIMENSIONS'
  | 'RENDER_BLOCKING_RESOURCE' | 'LARGE_JS_BUNDLE' | 'DUPLICATE_DEPENDENCY'
  | 'UNUSED_DEPENDENCY' | 'MISSING_LAZY_LOADING' | 'NO_CODE_SPLITTING'
  | 'LONG_MAIN_THREAD_TASK' | 'EXCESSIVE_REQUESTS' | 'MISSING_PRELOAD'
  | 'FONT_FLASH' | 'WEBFONT_BLOCKING' | 'CLS_SHIFT_SOURCE'
  | 'NO_COMPRESSION' | 'CACHE_MISS' | 'LEGACY_LIBRARY';

/** 归因下钻：必须能落到具体主体 */
export type Attribution =
  | { level: 'resource'; url: string; size: number; contentType: string }
  | { level: 'dependency'; name: string; version: string; size: number }
  | { level: 'source'; file: string; line: number; column?: number; component?: string }
  | { level: 'component'; name: string; file: string; line: number; renderCount?: number }
  | { level: 'config'; file: string; key: string };

export interface Evidence {
  kind: 'har-entry' | 'trace-event' | 'bundle-chunk' | 'lighthouse-audit' | 'source-map' | 'diff';
  /** adapter 原始载荷，保留以便人工复核 */
  payload: unknown;
  description: string;
}

export interface Bottleneck {
  id: string;
  runId: string;
  kind: BottleneckKind;
  title: string;
  /** 0-100，越大越严重（综合影响面 × 影响量 × 置信度） */
  severity: number;
  /** 对每个指标的影响量估算（ms 或 byte，正数表示"如果能修好可节省"） */
  impact: Partial<Record<MetricName, number>>;
  attribution: Attribution;
  evidence: Evidence[];
  /** 诊断置信度 0-1，低于 0.5 只作为提示，不进入自动修复 */
  confidence: number;
  /** 同一根因的合并计数（如 12 张图片都缺 width/height） */
  occurrences: number;
}

// ─────────────────────────────────────────────────────────────
// packages/shared/src/types/diagnosis.ts
// ─────────────────────────────────────────────────────────────

export interface Diagnosis {
  id: string;
  runId: string;
  project: string;
  route: string;
  device: 'mobile' | 'desktop';
  baselineRef?: string;
  metrics: Metric[];
  baselineMetrics: Metric[];
  deltas: MetricDelta[];
  regressions: MetricDelta[];       // delta < 0
  /** 按 severity 降序，已做同根因合并 */
  bottlenecks: Bottleneck[];
  /** 人类可读摘要，由 reporter 渲染进报告首屏 */
  summary: string;
  createdAt: string;
}

// ─────────────────────────────────────────────────────────────
// packages/shared/src/types/candidate.ts
// ─────────────────────────────────────────────────────────────

/** A 全自动 / B 半自动（生成 patch 待确认） / C 仅建议 */
export type OptimizationClass = 'A' | 'B' | 'C';
export type RiskLevel = 'low' | 'medium' | 'high';
export type Effort = 'low' | 'medium' | 'high';

export type PlannedChange =
  | { type: 'ast'; file: string; node: string; description: string; before?: string; after?: string }
  | { type: 'asset'; file: string; operation: 'convert-webp' | 'compress' | 'resize'; params: Record<string, unknown> }
  | { type: 'config'; file: string; key: string; before: unknown; after: unknown }
  | { type: 'dependency'; remove?: string[]; replace?: { from: string; to: string }; reason: string };

export interface Candidate {
  id: string;
  runId: string;
  /** 回链：每个候选必须来自某个瓶颈，禁止凭空提案 */
  bottleneckIds: string[];
  class: OptimizationClass;
  title: string;
  description: string;
  origin: 'rule' | 'llm';
  ruleId?: string;
  promptVersion?: string;          // origin=llm 时必填
  changes: PlannedChange[];
  /** 预期收益，与 Metric 同单位 */
  expectedGain: Partial<Record<MetricName, number>>;
  /** 置信度 0-1：规则命中 0.9+；LLM 生成默认 ≤0.75；记忆加权后调整 */
  confidence: number;
  risk: RiskLevel;
  effort: Effort;
  /** 是否可逆（决定回滚策略） */
  reversible: boolean;
  /** 记忆召回来源，便于解释"为什么这次给了更高/更低的置信度" */
  recalledFrom?: string[];
}

// ─────────────────────────────────────────────────────────────
// packages/shared/src/types/decision.ts
// ─────────────────────────────────────────────────────────────

export type Verdict = 'apply' | 'confirm' | 'suggest' | 'reject';

/** 工具路由：决定这个候选交给哪个执行器 */
export type ToolRoute =
  | 'ast-rewriter'      // ts-morph / jscodeshift
  | 'asset-processor'   // sharp
  | 'config-editor'     // 构建/框架配置
  | 'dependency-editor' // package.json
  | 'manual';           // 只出建议，不执行

export interface Decision {
  id: string;
  runId: string;
  candidateId: string;
  verdict: Verdict;
  route: ToolRoute;
  /** 期望值效用，越大越值得做 */
  score: number;
  utility: {
    expectedGain: number;   // Σ w_m × expectedGain_m，归一化到 0-100
    confidence: number;     // 0-1
    cost: number;           // 0-100：改动面 × effort × 可逆性折扣
    risk: number;           // 0-100：class 权重 × 改动文件数 × 是否触碰核心路径
  };
  riskLevel: RiskLevel;
  /** 决策理由，必须可解释（进报告、进 MR 评论） */
  reasons: string[];
  /** 阈值快照，保证历史决策可复现 */
  thresholds: {
    minGain: number;
    maxRegression: number;
    maxNewErrors: number;
    applyScore: number;
    confirmScore: number;
  };
  decidedAt: string;
}

// ─────────────────────────────────────────────────────────────
// packages/shared/src/types/verification.ts
// ─────────────────────────────────────────────────────────────

export type CheckKind =
  | 'unit-test' | 'type-check' | 'lint' | 'e2e' | 'build'
  | 'recollect' | 'error-scan' | 'bundle-size';

export interface VerificationCheck {
  kind: CheckKind;
  passed: boolean;
  durationMs: number;
  /** 失败时的原始输出摘要（截断） */
  output?: string;
}

export interface Verification {
  id: string;
  runId: string;
  candidateId: string;
  status: 'kept' | 'rolled_back';
  route: ToolRoute;
  checks: VerificationCheck[];
  /** 与基线对比的指标变化 */
  deltas: MetricDelta[];
  gain: Partial<Record<MetricName, number>>;
  regressions: MetricDelta[];
  newErrors: Array<{ type: string; message: string; count: number }>;
  /** 门禁结论 */
  gate: {
    passed: boolean;
    gainOk: boolean;
    regressionOk: boolean;
    errorsOk: boolean;
    failedRules: string[];
  };
  patchRef?: string;                        // .perfpilot/runs/<runId>/patches/<cid>.patch
  git?: { baseRef: string; resultRef?: string; reverted?: boolean };
  decidedBy: 'auto' | 'human';
  verifiedAt: string;
}

// ─────────────────────────────────────────────────────────────
// packages/shared/src/types/run.ts   （运行记录与告警）
// ─────────────────────────────────────────────────────────────

/**
 * 告警严重度。区分这两者不是修辞，而是「能不能当基线」的判据：
 *
 * - `degraded`：有数据没采到（适配器不可用 / 崩溃 / 输出不可解析）→ 运行不完整。
 * - `info`    ：数据齐全，只是需要交代来源（如某指标由次选来源提供）→ 不影响完整性。
 *
 * 如果不分，一个没装 Lighthouse 的项目会因为「LCP 由 web-vitals 提供」这条
 * 纯说明性告警，永远拿不到基线 —— 每次运行都是 partial，基线永远建立不起来。
 */
export type WarningSeverity = 'info' | 'degraded';

export interface RunWarning {
  adapter: AdapterId | null;
  code: string;
  severity: WarningSeverity;
  message: string;
}

export interface RunRecord {
  schemaVersion: number;
  id: string;
  project: string;
  route: string;
  device: Device;
  url: string;
  /** failed = 零指标；partial = 有 degraded 告警；success = 数据齐全 */
  status: 'success' | 'partial' | 'failed';
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  perfpilotVersion: string;
  stages: StageRecord[];
  metrics: Metric[];
  baseline: BaselineRef | null;
  deltas: MetricDelta[];
  warnings: RunWarning[];
  artifacts: ArtifactRef[];
}
```

**两条与「可比性」有关的硬规则**（都在 `shared` 里实现，上层无法绕过）：

1. **只有 `success` 的运行能作为基线。** 拿一次降级采集的结果当基准，
   下一次的「改善」就只是测量误差。
2. **基线与本次的来源不同则不给差值。** `computeDelta` 在
   `current.source !== baseline.source` 时返回全空差值，并由 pipeline 记一条
   `METRIC_SOURCE_CHANGED`。Lighthouse 换 web-vitals 测出来的 LCP 差，
   差的可能是工具而不是页面 —— 与其给出一个看起来精确、实则不可比的数字，
   不如留空并明说「本次不可比」。

```ts
// ─────────────────────────────────────────────────────────────
// packages/shared/src/schema/config.ts
//
// 由 schema 反推类型（z.infer），不手写两遍 —— 手写接口与 zod 推断类型
// 在 `exactOptionalPropertyTypes` 下并不等价（zod 的可选字段是 `T | undefined`，
// 手写的 `prop?: T` 在本项目开启该开关后表示「要么不存在、要么是 T」）。
// ─────────────────────────────────────────────────────────────

export interface PerfPilotConfig {
  project: { name: string; root?: string };
  target: {
    url: string;
    routes: string[];
    repo: string;
    branch: string;
  };
  baseline: {
    ref: string;                              // git ref 或 runId
    metrics: Partial<Record<MetricName, { warning: number; error: number }>>;
  };
  optimization: {
    auto_fix: string[];      // A 类白名单（ruleId / BottleneckKind）
    manual_confirm: string[];// B 类
    suggest_only: string[];  // C 类
  };
  decision: {
    /** false = 不启用效用模型，全部候选按 C 类保守处理（只出建议） */
  jev: boolean;
    thresholds: {
      min_gain: number;       // 归一化分数，最小收益
      max_regression: number; // 允许的最大回归（分数）
      max_new_errors: number;
      apply_score?: number;
      confirm_score?: number;
    };
  };
  report: {
    format: Array<'markdown' | 'html' | 'json'>;
    comment_mr: boolean;
    auto_pr: boolean;
  };
  collect: { timeoutMs: number; runs: number };
  // 没有 ci 段：触发方式由 CI 平台的 YAML 决定，基线策略在 baseline.ref
  llm?: {
    provider: 'openai' | 'anthropic' | 'none';
    model: string;
    maxCostUsd?: number;
  };
  memory?: { driver: 'sqlite' | 'postgres'; url?: string };
}
```

所有 schema 在 `@yuki-byte18/shared/schema` 下与类型一一对应：`MetricSchema`、`DiagnosisSchema`、`BottleneckSchema`、`CandidateSchema`、`DecisionSchema`、`VerificationSchema`、`PerfPilotConfigSchema`。类型用 `z.infer` 反推，**不手写两遍**。

---

## 8. 优化分级

| 级别 | 语义 | 落地方式 | 清单 |
| --- | --- | --- | --- |
| **A** | 全自动 | 决策 `apply`，执行 → 验证 → 达标即保留 | 图片压缩/转 WebP、`loading="lazy"`、`preload`/`prefetch`、移除未使用依赖、`moment → dayjs`、`lodash → lodash-es`、移除重复依赖、开启 Tree Shaking、开启 gzip/brotli、`font-display: swap`、图片加宽高防 CLS |
| **B** | 半自动 | 生成 patch，**人工确认**后合并 | 代码分割、路由懒加载、组件 memo 化、虚拟列表、状态管理重构、接口合并 |
| **C** | 仅建议 | 只出报告与 MR 评论，不产出 patch | 架构级重构、渲染逻辑重写、数据流优化、后端接口优化 |

分级不是拍脑袋，而是三个可量化维度的函数：

```
class = f(可逆性 reversible, 改动面 changeSurface, 语义风险 semanticRisk)

A: reversible=true  && changeSurface≤3 文件 && semanticRisk=低（不改运行时语义）
B: reversible=true  && changeSurface 可控 && semanticRisk=中（改渲染/加载时序）
C: reversible=false || changeSurface 大 || semanticRisk=高（改架构/数据流/跨端契约）
```

A 类之所以敢全自动，是因为它们**不改变程序语义**，最坏情况只是"没变快"，而且 git 回滚成本为零。C 类被划出去，是因为 LLM 目前对"渲染逻辑重写"这类任务的正确率不足以支撑自动化，硬上只会制造回归。

---

## 9. 决策层（期望值效用模型）

`core/decision` 是全项目**唯一的决策入口**，executor 与 planner 都无权决定"改不改"。

### 9.1 为什么用期望值模型（以及为什么不用托管的 Jev 服务）

性能优化的本质是**在不确定性下做取舍**：收益是估算的、置信度是估的、成本是估的，而回归风险是真实存在的。这正是期望值模型（expected value）要解决的问题。

**这个模型是我们自己实现的（零依赖），不接入托管的 Jev 决策服务。** 调研结论：npm 上的 `jev` 是一个 2021 年的 `0.0.0` 空占位包；真正的 "Jev" 是 TypeSafe 的托管神经决策模型（`/v1/systemone`，默认模型 `jev-1.13.0`），每次调用需要 API key、联网、计费，且结果是采样得出的。

它与本项目的三条约束正面冲突：硬约束 7（决策层禁止调用 LLM）、M4 验收 1（决策为纯函数）、M4 验收 5（决策路径不含 LLM）。更根本的是，**它会抽掉「敢在 CI 里自动改代码」的地基——决策一旦不可复现，这套自动化就没人敢开**。完整论证见 [ADR 003](./docs/decisions/003-why-jev.md)。

效用函数：

```
utility(c) = Σ_m [ w_m × gainNorm_m(c) ] × confidence(c)  −  cost(c)  −  λ × risk(c)
```

- `w_m`：指标权重（LCP 0.35 / INP 0.25 / CLS 0.25 / 体积类合计 0.15），可在 `decision.weights` 覆盖。
- `gainNorm_m`：预期收益归一化到 0-100。分母取该指标的 `(poor − good)` 跨度 ——
  LCP 跨度 1500ms，省 750ms 记 50 分。
- **`expectedGain` 取所涉指标的加权平均**（`Σw·gainNorm / Σw`），不是加权求和。
  这一步曾经写错并导致真实数据上 **12 个候选全部 reject**：直接加权求和时，
  图片体积权重 0.04 会让「一张 900KB 的图转 WebP」只值 0.3 分，
  而成本与风险是两位数。权重的作用是**跨候选排序**，不是让只影响次要指标的候选整体缩水。
- `confidence`：候选置信度，含记忆召回调整。它是**乘数**不是加项。
- `cost`：改动面 × effort；刻度压在个位数（单文件简单改动 = 3），与收益的实际量纲对齐。
- `risk`：分级权重 × 改动文件数 × 可逆性；不可逆额外放大 1.5 倍。
- `λ`：风险厌恶系数，`decision.weights.risk_aversion`，默认 1。
- 硬门禁：候选若不在 `optimization` 白名单内，直接 `reject`，不参与排序。
- `decision.jev: false` 时不启用效用模型，全部候选按 C 类保守处理（只出建议）。

### 9.2 工具路由

决策层同时决定"这件事交给谁做"，把候选映射到执行器：

| 候选特征 | ToolRoute | 实现 |
| --- | --- | --- |
| 改 JS/TS 语法树 | `ast-rewriter` | ts-morph |
| 图片/字体等二进制资产 | `asset-processor` | sharp |
| 构建配置 / 框架配置 | `config-editor` | 结构化配置改写 |
| `package.json` 依赖 | `dependency-editor` | 依赖图分析 + 改写 |
| C 类 / 不可逆 | `manual` | 只出建议 |

### 9.3 输出映射

```
utility ≥ applyScore     → verdict=apply    （A 类，全自动）
utility ≥ confirmScore   → verdict=confirm  （B 类，出 patch 待人工确认）
utility > rejectFloor    → verdict=suggest  （C 类，仅建议）
否则                      → verdict=reject
```

同时按 §8 的公式给出 `riskLevel`（low/medium/high），并写入 `thresholds` 快照 —— **同一份输入永远得到同一份决策**，这是 CI 里敢开自动化的前提。

**决策层禁止调用 LLM**，由 ESLint 规则 + 单测（`decision/__tests__/no-llm.test.ts` 断言 decision 模块的依赖图中不含 `core/llm`）双重保证。LLM 只能"提方案"，不能"拍板"。

---

## 10. 记忆系统

四类记忆，同一套 `MemoryPort` 接口，SQLite（本地）/ Postgres（服务）两种实现。

| 记忆类型 | 表 | 内容 | 用途 |
| --- | --- | --- | --- |
| **历史诊断** | `diagnosis_history` | 同一页面/项目历次 diagnosis（指标、瓶颈、时间） | 趋势分析、识别"反复变慢"的模块 |
| **方案库** | `candidate_library` | 候选方案及其验证结果（成功/失败、实际收益、耗时） | 优先复用已验证收益的方案 |
| **项目画像** | `project_profile` | 技术栈、构建工具、基线值、偏好配置 | 生成方案时收敛搜索空间 |
| **失败记忆** | `failure_memory` | 哪些修复失败过、失败原因、失败上下文 | **阻止重复提案**，避免 CI 反复无效改动 |

召回策略（按优先级）：

1. **按项目召回** —— 同 repo 的历史方案，权重最高。
2. **按问题类型召回** —— 同一 `BottleneckKind` 的历史处理方式，即使换了项目也可迁移。
3. **按技术栈召回** —— React vs Vue、Vite vs Webpack 的方案差异。

召回结果反哺 planner：

```
confidence' = clamp(confidence + α × successRate(matched) − β × failureRate(matched), 0, 1)
```

即：**成功过的方案更自信，失败过的方案更保守，多次失败的方案直接不再提案。**

`memory` 模块只依赖 `MemoryPort`，不直接 import 数据库驱动，因此单测用内存实现即可，无需起数据库。

---

## 11. 配置文件

`.perfpilot.yml`（zod 强校验，字段缺失走默认值）：

```yaml
project:
  name: my-web-app
  root: .

target:
  url: https://staging.example.com
  routes:
    - /
    - /dashboard
    - /settings/profile
  repo: https://github.com/org/my-web-app
  branch: main

baseline:
  ref: main                      # git ref 或某个 runId
  metrics:
    LCP:    { warning: 2500, error: 4000 }   # ms
    INP:    { warning: 200,  error: 500 }
    CLS:    { warning: 0.1,  error: 0.25 }
    JS_SIZE:{ warning: 300000, error: 500000 }  # byte

optimization:
  auto_fix:                      # A 类：全自动
    - OVERSIZED_IMAGE
    - UNCOMPRESSED_IMAGE
    - MISSING_DIMENSIONS
    - MISSING_LAZY_LOADING
    - UNUSED_DEPENDENCY
    - DUPLICATE_DEPENDENCY
    - LEGACY_LIBRARY
    - NO_COMPRESSION
  manual_confirm:                # B 类：出 patch 等确认
    - NO_CODE_SPLITTING
    - LARGE_JS_BUNDLE
    - MISSING_PRELOAD
  suggest_only:                  # C 类：只给建议
    - LONG_MAIN_THREAD_TASK
    - EXCESSIVE_REQUESTS

decision:
  jev: true
  thresholds:
    min_gain: 5                  # 归一化分数，低于此值不保留
    max_regression: 2            # 任一指标回归超过此值即回滚
    max_new_errors: 0            # 新增错误数上限
    apply_score: 30              # 与真实候选的量纲对齐（实测 utility 在个位数到几十）
    confirm_score: 10

report:
  format: [markdown, html, json]
  comment_mr: true
  auto_pr: true

collect:
  timeoutMs: 120000             # 单轮采集超时
  runs: 1                       # 采集轮次（>1 时逐指标取中位数以降噪）

checks:
  package_manager: auto         # auto | pnpm | npm | yarn | bun（auto 按 lockfile 判断）
  kinds: [build, unit-test, type-check, lint, e2e]
  scripts:                      # 脚本名映射；null 表示这个项目不做这项检查
    build: build
    unit-test: test
    type-check: typecheck
    lint: lint
    e2e: e2e

llm:
  provider: openai              # none 时 M3 的 planner 只用规则库
  model: gpt-4o-mini
  maxCostUsd: 2

memory:
  driver: sqlite
  url: .perfpilot/memory.db
```

> 完整可复制的示例见仓库根目录的 `.perfpilot.yml.example`（含逐字段注释与默认值说明）。
> 配置采用 zod `.strict()`：写错键名（如 `minGain` 而非 `min_gain`）会在启动时以退出码 2 报错，
> 而不是被静默忽略后用默认值跑完一整轮 CI。

---

## 12. CLI 命令

```bash
perfpilot init       # 生成 .perfpilot.yml（检测项目状态，只问测量地址）
perfpilot run        # 跑完整闭环：采集→诊断→方案→决策→执行→验证→保留/回滚→报告
perfpilot diagnose   # 只诊断，产报告，不改任何代码
perfpilot fix        # 基于最近一次诊断执行修复（可 --dry-run 只出 patch）
perfpilot serve      # 启动只读报告服务（API + Web 报告页）
perfpilot history    # 查看历史记录（诊断趋势 / 方案成功率 / 失败记忆）
```

常用参数：

```bash
perfpilot init --url https://staging.example.com   # 不交互，直接生成
perfpilot init --yes                               # 全用检测值与建议值
perfpilot init --llm deepseek                      # 同时接上 LLM（key 只从环境变量读）
perfpilot init --ci github                         # 同时生成性能门禁流水线
perfpilot init --force                             # 覆盖已存在的配置
perfpilot run --url https://staging.example.com --routes /,/dashboard
perfpilot run --dry-run                  # 只产出 patch，不改工作区
perfpilot run --ci                       # CI 模式：门禁未通过返回退出码 1
perfpilot run --ci --max-regression 5    # 临时放宽抖动阈值
perfpilot diagnose --baseline main --compare
perfpilot fix                            # 落地最近一次 run 里 apply/confirm 的候选
perfpilot fix --dry-run                  # 只生成 patch，不落盘
perfpilot fix --only A                   # 只落地 A 类
perfpilot fix --candidate cand_8f2a      # 指定单个候选
perfpilot fix --run run_20260117T142530  # 指定某一轮 run
perfpilot serve --port 3080              # 只读报告服务（默认只监听 127.0.0.1）
perfpilot history --project my-web-app --limit 20
perfpilot history --show-failures        # 只看失败记忆
```

退出码约定：`0` 通过 · `1` 门禁未通过 · `2` 配置错误 · `3` 采集失败 · `4` 内部错误。

`fix` 的一个刻意约定：**回滚不算失败**。一次回滚意味着门禁把不合格的改动拦下来了，
那正是这个工具存在的意义；把它变成非零退出码会让 CI 因为"守住了底线"而变红，
于是很快就没人再看这个信号了。真正返回 `1` 的只有一种情况：
该应用的改动**一个都没能应用**（没有 git 仓库、工作区不干净、补丁全部冲突），
此时必须让人知道这次 `fix` 实际上什么都没做。

---

## 13. 开发约束（硬规则）

> 违反以下任意一条的 PR 不予合并。前 13 条由工具强制，后 7 条由评审强制。

| # | 规则 | 强制手段 |
| --- | --- | --- |
| 1 | pnpm workspaces Monorepo，包结构固定为 shared / core / adapters / cli / server / web | `pnpm-workspace.yaml` |
| 2 | 依赖方向严格单向：`shared ← adapters ← core ← cli/server`，`web` 只依赖 shared 类型 | ESLint `import/no-restricted-paths` |
| 3 | 禁止反向依赖与循环依赖 | `import/no-cycle` + `madge --circular` |
| 4 | `core` 不许 import 具体 adapter，只依赖 adapter 接口（type-only） | ESLint 白名单 |
| 5 | 所有外部工具调用必须经过 adapter | 禁止 core 内出现 `child_process` / 裸 `fetch` |
| 6 | 所有 LLM 调用必须经过 `core/llm` | 仅 `core/llm` 可 import LLM SDK |
| 7 | 所有决策必须经过 `core/decision` | decision 模块禁 LLM（lint + 单测） |
| 8 | 所有优化必须经过验证才能保留 | verifier 单测：无验证不得 `kept` |
| 9 | 失败必须回滚；Git 即记忆 | 回滚路径必须有测试覆盖 |
| 10 | 所有类型必须来自 `@yuki-byte18/shared` | 禁止在 core/adapters/cli/web 定义跨包类型 |
| 11 | 所有外部输入用 zod 校验 | 入口函数必过 `parseExternal()` |
| 12 | 统一 pino 日志 | 禁止 `console.log`（lint 报错，CLI 用户输出走 reporter） |
| 13 | 测试覆盖率 ≥ 70% | Vitest coverage threshold，排除项见 `vitest.config.ts` |
| 14 | 不做过度设计：不用 DAG、不用拓扑调度、最多 1 主 Agent + 1 诊断 Agent | 评审 |
| 15 | 并行只用 `Promise.all`，不引入任务调度器 | 评审 |
| 16 | 不做通用 Agent 框架 | 评审 |
| 17 | 不做完整监控平台 | 评审 |
| 18 | 不做后端性能诊断、不做生产环境压测 | 评审 |
| 19 | 不引入 Kafka / Redis / 分布式组件 | 评审 |
| 20 | 不为复杂而复杂 | 评审 |

### 为什么不用 DAG / 拓扑调度 / 多 Agent这是本项目最重要的技术判断，写在最显眼的位置：

**不用 DAG 引擎。** 流水线的八段是**固定依赖链**，没有任何一步的依赖关系需要在运行时解析。DAG 引擎的价值在于"依赖关系动态、节点数量不可预知"，而这里两者都不成立。引入 DAG 意味着：多一套节点定义 DSL、多一层调度抽象、多一个调试对象、多一份新人理解成本 —— 换来的是零收益。**用 DAG 解决线性问题，是把复杂度当成了深度。**

**不用拓扑调度。** 唯一真实的并行需求是"采集阶段同时跑 Lighthouse、Playwright、bundle 分析"，这是**同层 fan-out**，`Promise.all` 一行解决。拓扑排序要解决的是"跨层乱序依赖"，而我们没有跨层乱序依赖。**并行度是一个数组的长度，不是一个调度器。**

**不用多 Agent（最多 1 主 Agent + 1 诊断 Agent）。** 多 Agent 架构的收益来自"角色分工带来的上下文隔离与协商"，代价是指数级上升的不确定性与 token 成本。在性能优化这个场景里，**价值来自可复现的测量与可回滚的补丁，而不是来自 Agent 之间的对话**。所以我们把 LLM 压缩到最小的两个位置：诊断解释与方案生成。决策交给确定性模型，执行交给 AST 工具，验证交给测试 —— 这些都不需要一个会说话的 Agent。

一句话总结：**这个项目的竞争力在"敢在 CI 里自动改代码并回滚"，而不在"用了多少 Agent"。**

---

## 14. 里程碑

每个里程碑都有明确验收标准，**做完验收再进下一个**。

### M1 — 采集 + Markdown 报告 ✅ 已完成
- 交付：`shared`（Metric/Config 类型与 schema）、`adapters/{lighthouse,web-vitals,bundle-analyzer}`、`core/{collector,reporter,pipeline}`、`cli` 的 `run` / `diagnose` 骨架。
- 验收：
  1. `perfpilot diagnose --url <url>` 能从 ≥ 2 个 adapter 采到指标并合并为 `Metric[]`。
  2. 产出 `.perfpilot/runs/<runId>/run.json` 与 `report.md`，report 含指标表 + 基线对比。
  3. 全部外部输入经 zod 校验，非法输入给出明确错误码。
  4. 单 adapter 失败时链路降级继续，日志有 warning。
  5. 用录制的 fixture 跑集成测试，全链路无需真实网络。
  6. 覆盖率 ≥ 70%。

**验收结果**：13 个测试文件 / 210 个用例全绿；覆盖率 93.5% 行 / 86.4% 分支；
`lint` + `madge --circular` + `typecheck` 全部通过；真实 CLI 在「Lighthouse 未安装」
的环境下跑通并如实标出 `partial` 与缺失指标。

### M2 — 诊断归因 ✅ 已完成
- 交付：`core/diagnoser`（规则引擎 + 归因下钻）、`adapters/{source-map,har,trace}`。
- 验收：
  1. 内置 ≥ 8 条诊断规则，每条规则有独立单测（含正例/反例/边界）。
  2. `bottlenecks` 按 severity 降序，同根因合并（`occurrences` 正确）。
  3. `attribution` 能落到 resource / dependency / source(file:line) / component / config 五类中的至少四类。
  4. source-map 能把压缩后的 bundle 位置还原到源码 file:line（fixture 验证）。
  5. `Diagnosis` 通过 schema 校验，快照测试稳定（同输入同输出）。

**验收结果**：13 条内置规则（要求 ≥8），每条都有正/反/边界三档单测；
归因 **五类全覆盖**；真实 CLI 跑出的诊断里
`renderList 阻塞主线程 220ms → source src/VirtualList.tsx:88:0`（置信度 90%）；
同一份输入两次诊断产出的 JSON 完全一致。

#### 三个关键设计取舍

**严重度要显式给出「确实很糟」的参照点。** 最初用 `实测 / 阈值` 取对数打分，
结果真实场景里 15 个瓶颈有 6 个并列 100 分 —— 严重度失去了区分能力。
根因是阈值的语义各不相同：`文本资源至少 10KB 才值得压缩` 里的 10KB 是**最低可讨论线**，
`单 chunk 超过 250KB 该拆` 里的 250KB 是**决策线**；拿前者当分母，
一个 180KB 的文档算出 ratio=18、直接顶满。现在每条规则显式声明
`threshold` 与 `severe` 两个点，分数反映的是「离最坏情况还有多远」。

**component 级归因允许 `file`/`line` 为 null。** 来自 Web Vitals 的 DOM 归因
只能给出选择器（`img.hero`），拿不到源码位置。这仍然可操作 —— 开发者可以搜选择器 ——
但**不能编造**一个 source map 给不出的行号，那会把人指向无关的代码。
给不出来的就标 null，报告里如实显示为 `component img.hero`。

**同根因合并按「可操作主体」而不是按资源逐条列。** 12 张超标图片合成一条
`occurrences: 12`（一次改完），而不是 12 条各占一行的噪音。
合并后的影响量按指标类型区分：体积类求和（每张图的体积确实独立），
时间类取最大值（修好 12 张图不会让 LCP 减少 12 倍）。

#### 适配器的两种形态

`source-map` 不是 `CollectorPort`，而是 `SourceMapPort`：采集器是「跑工具产出产物」，
source map 是「拿产物位置换源码位置」的**按需服务**，调用次数取决于命中多少条规则。
硬塞进采集阶段只会白读一堆用不到的 map。CLI 的组合根把两者分别注入 core。

它还必须处理一个容易被忽略的路径问题：trace / HAR 记录的是**部署后的 URL**
（`https://host/assets/index.js`），而 .map 通常躺在**构建产物目录**
（`dist/assets/index.js.map`）。因此适配器支持多个搜索根，
并且记住 map 的**实际所在目录** —— source 字段是相对它解析的，不是相对项目根。

### M3 — 方案生成 ✅ 已完成
- 交付：`core/planner`、`core/llm`、规则库首版。
- 验收：
  1. 每个可修瓶颈至少产出 1 个候选；不可修瓶颈不产出。
  2. 候选同时来自规则库与 LLM（测试中 LLM 用 mock），每个候选都有 `bottleneckIds` 回链。
  3. 每个候选带 `class`（A/B/C）、`expectedGain`、`confidence`、`risk`、`reversible`。
  4. LLM 输出经 schema 校验；校验失败自动降级为仅规则库，链路不中断。
  5. Prompt 版本化，`promptVersion` 写入候选，可追溯。
  6. LLM 成本记账，超 `maxCostUsd` 时停止并在报告中告警。

**验收结果**：18 条规划规则覆盖**全部 18 种瓶颈种类**；真实 CLI 跑出的 13 个瓶颈
**全部拿到候选**（验收 1 零遗漏），候选分布 A 类 9 / B 类 3 / C 类 1。
`core/planner` + `core/llm` 共 43 个单测（25 + 18），全链路 351 个测试全绿。

#### 三个关键设计取舍

**LLM SDK 是可选依赖，不是编译期依赖。** `core/llm` 用**变量 specifier** 做动态 import
（`const s = 'ai'; await import(s)`）。写成字面量 `import('ai')` 时 TypeScript 会去解析
那个包的类型，没装就报 TS2307、整包编译不过 —— 可选依赖就悄悄变成了硬依赖。
代价是失去 SDK 的类型安全，由本地声明的 `AiSdkSurface` 契约补回来。
这样「没装 SDK」也能 build / typecheck / 跑测试，运行时才降级。

**`unmatchedKinds` 的语义是「没产出候选」而不是「没有规则」。**
这条区别很重要：一条规则存在、但因为归因拿不到可操作主体而拒绝产出（例如
`UNUSED_DEPENDENCY` 规则要求归因到 dependency，而瓶颈只归因到 resource），
此时瓶颈确实没有建议。把它算作「已覆盖」会让报告显示一切正常，
而用户手里其实什么都没有。

**字体闪烁与字体阻塞共用同一条修复。** `font-display: swap` 同时解决
`WEBFONT_BLOCKING` 与 `FONT_FLASH`，因此两个规则条目共用同一个实现体。
拆成两份代码迟早会改漏一边。

### M4 — 决策层 ✅ 已完成
- 交付：`core/decision`。
- 验收：
  1. 决策模块为纯函数：同输入同输出，快照测试覆盖。
  2. `utility` 四项分量（expectedGain / confidence / cost / risk）分别可测，各有权重边界测试。
  3. 工具路由表覆盖 5 种 `ToolRoute`，各有测试。
  4. A/B/C 与 `apply/confirm/suggest` 映射正确，阈值来自配置。
  5. **决策路径不含 LLM**：依赖图断言 test 通过。
  6. `thresholds` 快照写入 `Decision`，历史决策可复现。

**验收结果**：45 个单测覆盖六条标准；真实 CLI 上 12 个候选得到
`apply 2 / confirm 6 / suggest 1 / reject 3`，**5 种 ToolRoute 全部出现**。
决策目录的依赖图断言确认不含任何 LLM import。

#### 一次真实的量纲事故（值得记下来）

第一次跑真实数据，**12 个候选全部被 reject，utility 全为负**：

```
⛔ reject | 将 assets/hero.png 转为 WebP | utility -25.7 | 收益×置信 0×0.90 | 成本 15 | 风险 11
```

单元测试全绿，却得出一个「什么都别做」的决策层。原因有两层：

1. **`expectedGain = Σ w_m × gainNorm_m` 把权重用错了地方。**
   图片体积权重 0.04，一张 900KB 的图转 WebP 省 80KB 只值 `0.04 × 8 ≈ 0.3` 分；
   而成本 15 + 风险 11 = 26。权重本该回答「哪个指标的改进更值钱」、
   用于**跨候选排序**，却变成了「只影响次要指标的候选整体缩水」——
   一个只优化图片的候选不该因为没有顺带优化 LCP 就被判成不值得做。
   改为**加权平均**：`Σ w_m × gainNorm_m / Σ w_m`。
2. **cost / risk 的 0-100 刻度与收益的实际量纲不匹配。**
   日常改动的归一化收益本就在个位数到几十之间，
   成本却按 0-100 铺开，一个改单文件的简单改动就扣 15 分。
   已把成本刻度压到「单文件简单改动 = 3」，风险分档同步调整为 2/6/12 基准。

**教训**：单元测试只验证了公式本身，没验证「这套模型在真实数据上能否得出
非 reject 的结论」。分量各自正确，组合起来量纲错了 —— 这类问题只有端到端跑才会暴露。
所以 M4 的验收里要有一条是**看真实裁决分布**，而不只是看断言。

#### 已知的标定遗留

`配置静态资源长缓存`（收益 8）与 `开启 Brotli 压缩`（收益 4）被判 reject。
这不是决策层的问题，而是 **planner 对这两条规则的 `expectedGain` 估得太保守**
（用 `TRANSFER_SIZE × 0.6` 去乘一个本就很小的 impact）。
决策层如实反映「收益 4 分、成本 3 分、风险 2 分，不值得自动化」是对的；
要改应该在 M5 用真实验证收益反哺 planner，而不是在这里把阈值调松到全部通过。

### M5 — 执行 + 验证 + 回滚 ✅ 已完成
- 交付：`core/executor`（ast-rewriter / asset-processor / config-editor / dependency-editor）、`core/verifier`、`core/memory`（失败记忆写入）、`adapters/{git,asset,executor,check-runner}`、流水线的 `execute` / `verify` 两段、`perfpilot fix` 命令。
- 验收：
  1. executor 产出标准 unified diff（`.patch`），不直接改工作区。
  2. 四类执行器各有 fixture 输入 → patch 输出的测试。
  3. verifier 跑通 单测 + E2E + 重采集 + 收益对比，四项结果写入 `checks`。
  4. 门禁公式落地：`gain ≥ min_gain && regressions ≤ max_regression && newErrors ≤ max_new_errors`。
  5. **每条保留路径都有对应的回滚测试**：构造回归场景，断言 `status === 'rolled_back'` 且 git 工作区干净。
  6. 失败原因写入 `failure_memory`。

**验收结果**：6 条全部落地。`pnpm check` 全绿，**23 个测试文件 / 500 个用例**，覆盖率 86.1% 行 / 80.4% 分支
（远超硬约束 13 的 70%）。其中：

- 四类执行器的 fixture → patch：25 个用例，每一条文本补丁都用**真实 `git apply --check`** 验过
  （图片转码走真实 `sharp`，不是替身）。
- verifier：35 个用例，其中 5 条按否决条件逐条覆盖回滚路径，
  断言的是"**真的调用了 `resetHard` 且没有留下 commit**"，而不只是 status 字段。
- 真实 git 仓库上的闭环：**5 个用例**（`packages/cli/src/m5-loop.test.ts`）——
  建真仓库、跑真 `git` adapter、断言保留后 `git isClean() === true` 且文件内容确实变了、
  回滚后文件**回到原样**且工作区干净。这一组是验收 5 里"git 工作区干净"那半句的唯一证据来源，
  用假的 GitPort 断不出来。
- `perfpilot fix` 命令走真实组合根（含真实 git adapter），退出码与输出都验过。

#### 四个真实缺陷（都是接流水线时才暴露的）

**1. 门禁会把「无法判断」当成「没有新错误」。** `failedChecks` 在
「重新采集」之前就算完了，于是 `recollect` 与 `error-scan` 这两项的结果根本进不了门禁：
Sentry 没配、扫描抛异常时 `newErrors` 是空的，门禁照样放行。
验证是自动化改代码的最后一道闸，**「不知道」必须按「不通过」处理**。
已把汇总移到全部检查跑完之后，并留了回归用例。

**2. `patch === ''` 混淆了「二进制已写入」与「只做评估」。** 见 [ADR 006](./docs/decisions/006-why-patch-first.md)。

**3. `.perfpilot/` 不被 gitignore 就会永久锁死自动改动。** 流水线把 run 产物写在项目目录里，
若它们不被忽略，第一次运行就把工作区弄脏，此后「工作区不干净」的保护会拦住所有改动 ——
表现为"这个工具从来不动手，也不说为什么"。快速开始里已写明要先把这个目录加进 `.gitignore`。

**4. 回滚用的是 `reset --hard`，所以动手之前必须先确认工作区干净。**
不干净就一个补丁都不应用（补丁照常产出，人可以手动用）。
这条保护本身也需要测试，否则它只是个注释。

#### 三个关键设计取舍

**补丁的应用放在 verify 阶段，而不是 execute 阶段。**
四类执行器只产出 patch（ADR 006），所以"应用补丁"必须紧挨着它的验证。
如果先应用 N 份补丁再统一验证，重采集拿到的是 N 个改动**叠加**后的结果，
收益无法归因到任何一个候选：门禁通过时不知道该保留谁，不通过时不知道该回滚谁。
于是验证是**串行**的 —— 一个候选走完 apply → verify → keep/rollback 再处理下一个，
保留成功则回滚目标前移到自己产生的 commit，下一个候选失败时只回滚它自己。

**「项目里没有这个脚本」是第三种状态，不是失败也不是通过。**
很多前端项目没有 E2E。当成失败会让每次优化都回滚；当成通过会在验证记录里留下一条假证据。
`CheckRunResult.skipped` 让它可区分，报告里也如实显示为 `e2e(跳过)`。
顺带说明：判断"有没有这个脚本"必须自己读 `package.json` ——
`pnpm run --if-present` 在脚本缺失时返回 0，退出码看不出区别。

**跳过不能等于放行，但没通过必须给出"差在哪"。**
`failedRules` 里写的是 `收益 0.4 < min_gain 5` 这种可执行的话，
而不是 `rolled_back`。这份文本同时进报告、进日志、进失败记忆 ——
失败记忆里存一句"没通过"是没用的，下一轮 planner 需要知道是"收益不够"还是"引入了错误"。

#### 已知遗留

- ~~资产写入通道默认关闭~~ → **已在全量审计中打开**（回滚覆盖新增文件这一点在 M5 的真仓库测试里验过；
  另外只有 `apply` 裁决的候选能拿到写文件能力，B 类候选不会留下无人管的文件）。
- ~~planner 的两条 `expectedGain` 偏保守~~ → **已接上"用真实收益反哺标定"的闭环**
  （见 M8 之后的「全量审计与修复」）。


### M6 — Memory ✅ 已完成
- 交付：`core/memory`（画像推断 / 召回与置信度调整 / 失败记忆写入）、`adapters/memory`（SQLite 实现 + Postgres 骨架）、`perfpilot history --show-failures`。
- 验收：
  1. 四张表建成，迁移脚本可重复执行（幂等）。
  2. 按项目 / 问题类型 / 技术栈三种召回路径各有测试。
  3. planner 消费召回结果调整 `confidence`，调整逻辑有确定性测试。
  4. 失败记忆生效：同上下文下曾失败的候选不再被提案。
  5. 用内存实现跑单测，无需真实数据库。

**验收结果**：5 条全部落地，`pnpm check` 全绿，**26 个测试文件 / 525 个用例**，覆盖率 85.0% 行 / 80.5% 分支。
Memory 相关 20 个用例（SQLite 11 + 召回 8 + 画像 6 中的 5，另有 1 条落在 cli 的持久化闭环）。

#### 一处与本文档原措辞不同的实现选择

本节原写「`core/memory`（SQLite 实现）」。实际把 **SQLite 实现放在 `adapters/memory`**，
`core/memory` 只留纯逻辑（画像推断、召回编排、失败记忆的构造规则）。理由：

- 硬约束 4/5 要求 core 不得依赖具体实现、不得直接调用外部工具。数据库驱动就是外部依赖，
  放进 core 会让「core 只依赖 shared」这条线当场作废 —— 而那正是这个仓库能被单独测试的原因。
- 与 `MemoryPort` 的设计意图一致：ADR 007 的原话是「`MemoryPort` 让存储成为实现细节」。
  实现细节放在 adapters，才真的成为细节。

验收标准的**意图**（记忆可跨 run 持久化、迁移幂等、三条召回路径可用）没有打折，只是落点换了位置。

#### 三个刻意的取舍

**用 `node:sqlite`，不加原生依赖。** CI 里多一个原生扩展就多一类"在我机器上能跑"的问题：
编译工具链、Node ABI 匹配、Windows 上尤其麻烦。代价是它仍标记为 experimental，
因此驱动被包在 `adapters/memory/sqlite.ts` 后面，并走 `process.getBuiltinModule('node:sqlite')`
取值（顺带解决一个真实问题：静态 `import 'node:sqlite'` 会被 Vite 当成普通包去解析，
报 `Failed to load url sqlite`）。换驱动改这一个文件。

**推断不出项目画像时返回 `null`，而不是造一个 `'unknown'` 存进库。**
M6 之前 `techStack` 恒为 `'unknown'`，于是「按技术栈召回」这条路径**写了、测了、但永远是死的**。
现在画像从 `bundle-analyzer` 采集到的 package.json 快照里推断（框架 + 构建工具），
拿不到就什么都不写 —— 一条错误的画像会让召回在错误维度上匹配，比没有画像更糟。

**Postgres 只写骨架，且不假装能用。** 四张表的 SQL、九个方法、占位符编号都写完了，
但驱动不装、连接池不做。`createPostgresMemory` 要求调用方注入已连好的 client，
注入不了就抛错。写一个从未跑过的完整实现，比写一个明确标注未验证的骨架更危险。

#### 一个真实的 Windows 资源泄漏

接完 CLI 之后 `pnpm check` 出现 7 条 `EBUSY: resource busy or locked, unlink ...\memory.db`：
SQLite 打开的文件句柄谁都没关。进程退出时操作系统会回收，所以**本地跑完全看不出来**；
但测试与 CI 的清理步骤会撞上它，而错误信息完全不指向真正的原因。

修法是让组合根显式交出释放能力：`CliContext.dispose()`，
命令层在 `finally` 里调用。谁打开的资源谁负责关 —— 这条在"短命进程"里最容易被跳过，
而它恰恰是自动化环境里最容易咬人的地方。

#### 已知遗留

三条都在「全量审计与修复」里解决了，保留在这里是为了记住当时的判断错在哪：

- ~~`project_profiles.baselineMetrics` 只写不读~~ → 现在读出来做**基线漂移检测**
  （`BASELINE_DRIFT`，info 级）。当时写"还不知道该怎么用"是错的：
  门禁判的是相对上次的差值，项目整体缓慢劣化时每次都在阈值内 ——
  基线自己会漂，这件事必须被说出来。
- ~~Postgres 路径没有任何测试~~ → 用**注入假 client、断言发出去的 SQL** 的方式覆盖了。
  补测试的当天就抓出一个真 bug：布尔列被塞了 SQLite 风格的 0/1。
- ~~失败记忆没有撤销入口~~ → 加了 `history --forget <指纹>` / `--forget-all`。

### M7 — CI 接入 ✅ 已完成
- 交付：`server`（只读报告 API）、`.github/workflows/perfpilot.yml`、`ci/gitlab-perfpilot.yml`、`core/gate`（CI 门禁）、`core/ci`（MR 评论 + 自动 PR）、`adapters/scm`（GitHub / GitLab）、`perfpilot serve`、`run --ci`。
- 验收：
  1. `perfpilot run --ci` 门禁失败返回退出码 1，通过返回 0。
  2. GitHub Action 与 GitLab CI 模板各一份，含缓存与 artifact 上传。
  3. `comment_mr: true` 时在 MR 上发布结构化评论（指标表 + 瓶颈 top3 + 决策摘要 + 报告链接）。
  4. `auto_pr: true` 时创建 PR，含 patch 与验证结论。
  5. 门禁结果本地可复现（同一 commit 跑两次结论一致）。

**验收结果**：5 条全部落地，`pnpm check` 全绿，**30 个测试文件 / 566 个用例**，覆盖率 84.3% 行 / 80.4% 分支。
M7 相关新增 38 个用例（门禁 12 / MR 评论与发布 7 / SCM 适配器 10 / 报告服务 9）。

#### 一处与本文档原措辞不同的实现选择

本节原写「`server` 最小 API」并默认用 Fastify。实际用了 **`node:http`**：

- 这个服务是**只读的四个端点**（列 run、读 run、读报告、健康检查）。框架提供的路由树、
  插件、校验、序列化在此一个都用不上，而代价是真实的：多一棵依赖树、
  多一套升级节奏、多一种"CI 里装不上"的失败模式。
- 这次落地时 npm registry 连续超时，`pnpm add fastify` 直接失败 —— 而零依赖的服务
  在这种情况下照常可用。对一个要在别人 CI 里跑的工具，这不是小事。
- 端点少到能用一张路由表说清楚时，框架是负收益。等需要插件生态（鉴权、限流、OpenAPI）再换，
  换的也只是 `packages/server/src/index.ts` 一个文件。

#### 两个真实缺陷（都是接门禁时才暴露的）

**1. 绝大多数项目永远拿不到基线，于是回归门禁永远不响。**
`resolveBaseline` 原先只接受 `status === 'success'` 的运行。但 `partial` 的含义只是
**有来源没参与**（项目没有 HAR、没有 trace、没有 web-vitals 上报文件），
并不说明拿到的数字不可信 —— 而真实项目几乎都有可选来源缺失。
结果就是：基线永远为空 → 没有差值 → 门禁永远绿灯。

这个 bug 从 M1 就在，单测看不出来是因为**测试里每个来源都齐全**。
修法不是放宽告警级别，而是把"能不能比"的判据从整次运行收到**单个指标**：
`isComparable` 早就按指标比较测量来源，来源变了就置空 `scoreDelta`。
只有 `failed`（一个指标都没采到）才不能当基线。

**2. 第一版门禁是「有任何 degraded 告警就失败」，于是每个项目都永久红灯。**
可选来源缺失会记 `ADAPTER_UNAVAILABLE`（降级级），一个没接 HAR 的项目因此永远过不了门禁。
**一个永远红的门禁等于没有门禁** —— 团队会学会忽略它。现在只把
`COLLECT_FAILED` / `ADAPTER_FAILED` / `ADAPTER_OUTPUT_INVALID` 这三类
「探活通过、跑起来却失败了」当门禁失败：那才是数据不完整且不可预期的情况。

#### 三个关键设计取舍

**门禁判的是回归，不是绝对值。** 按绝对值判（LCP < 2.5s 才算过）会让一个本来就不达标的
项目永远红着。按回归判则永远有明确含义：这次提交让哪一项变差了多少。
需要卡底线的团队可以在 `baseline.metrics` 里显式配 `error` 阈值 —— 那一条只在显式配置时生效，
由团队自己决定，而不是工具替他们决定。

**发布失败不能让门禁变红。** 评论发不出去是平台问题（token 过期、权限不足、网络抖动），
与"这次改动的性能过不过关"无关。算进去的话，一个真正绿灯的提交会因为 GitHub API 500 而失败，
于是大家学会"重跑 CI 直到绿"—— 门禁就此失去意义。所有发布失败都变成 note 与 warning。

**门禁结论落盘成 `gate.json`。** 验收 5 要求"同一 commit 跑两次结论一致"。
可复现不是靠重跑一次碰巧一样，而是结构上不可能不一样：`evaluateCiGate` 是纯函数，
不看时间、不看环境变量、不看随机数。落盘之后，重跑一次直接 diff 两个文件就行，
不需要人去比对两份 Markdown 报告的措辞。

#### 已知遗留

- **`auto_pr` 仍然没有真实跑过。** 代码路径完整（推分支 → 建 PR，含 patch 与验证结论），
  但没有可用的 token 与远端仓库来验证。GitHub / GitLab 的字段名差异已经用
  断言请求体的方式钉住（`head`/`base` vs `source_branch`/`target_branch`），
  真正的联调要等有人真的开 `auto_pr: true`。**这一条无法靠写代码解决**，
  它缺的是一次真实的联调。
- ~~MR 评论总是新增一条~~ → 现在是 **upsert**（找到带 `<!-- perfpilot-report -->`
  标记的旧评论就更新它）。反复推送的 MR 不会再攒评论。
- ~~报告服务没有鉴权~~ → 加了可选 `--token`（也接受环境变量 `PERFPILOT_TOKEN`）。
  监听非本机地址却没设令牌时会**明确警告**并给出具体命令 ——
  不阻止启动（有人就是要在内网共享），但必须说出来。

### M8 — Web 报告页 ✅ 已完成
- 交付：`web`（React + Vite）、`server` 静态托管、`perfpilot serve` 一条命令起服务。
- 验收：
  1. 展示指标趋势（跨 run）、瓶颈下钻、候选→决策→验证时间线、回滚记录。
  2. `web` 只 `import type` from `@yuki-byte18/shared`，ESLint 边界检查通过。
  3. 报告页自身性能达标（LCP < 2.5s，无布局抖动）。
  4. `perfpilot serve` 一条命令起服务并可访问报告页。
  5. 空数据 / 加载中 / 错误三态处理完整。

**验收结果**：5 条落地，`pnpm check` 全绿，**32 个测试文件 / 590 个用例**，覆盖率 81.9% 行 / 80.4% 分支。
Web 相关新增 29 个用例（数据层 12 / 三态渲染 9 / 性能护栏 9，另有服务端静态托管 5 个）。

- **验收 1**：趋势按时间升序、单个数据点显式标记 `enoughData: false`、测量来源变化时不给变化量；
  瓶颈表按严重度排列并显示归因；时间线**以候选为主体**（没有决策的"半截记录"也会出现）；
  回滚记录带上未通过原因。
- **验收 2**：ESLint 的 `allowTypeImports` 把「只 `import type`」变成构建期检查 ——
  任何值导入都会报错。顺带修了个真问题：`files: ['**/*.ts']` 让 `.tsx` **一条规则都不生效**。
- **验收 3**：见下，**这一条只做到一半，如实说明**。
- **验收 4**：真实构建产物端到端验过 —— `GET /` 返回 200 的 HTML（含挂载点与两个资源引用），
  `GET /assets/index-*.js` 返回 155KB 的 `text/javascript`，`GET /api/runs` 返回 JSON。
- **验收 5**：三态各有独立渲染分支，四种状态是判别联合而不是"默认空"；
  404（"换一个 run"）与其它错误（"重试"）文案不同。

#### 验收 3 只做到一半

原文是「LCP < 2.5s，无布局抖动」。**这个数字没有被真实测量过** ——
它需要在真实 Chrome 里跑 Lighthouse，而本环境没有 Chrome（M1 的验收记录里
Lighthouse 就是不可用的，链路一直靠降级跑）。**不编一个数字交差**。

做到的是「决定 LCP 与 CLS 的那些结构」的**回归护栏**（`packages/web/src/perf.test.ts`，9 个用例）：

| 检查 | 为什么它决定 LCP / CLS |
| --- | --- |
| 关键样式内联、无外链样式表 | 外链 CSS 是渲染阻塞资源，多一次往返首帧就晚一次往返 |
| 无 web font | 字体是 LCP 与 CLS 最常见的两个元凶 |
| 无 `@import` / 远程 `url()` | 同样引入额外往返 |
| 声明 `color-scheme` | 深色模式下不闪白（一次可见跳动） |
| 挂载点在 HTML 里、不由 JS 创建 | JS 建挂载点 = 首帧空白 + 内容一次性出现 |
| 骨架屏有固定高度 | 0 高的骨架会在加载完成时把下方内容整体顶下去 |
| 无图片 / 视频 | 不加载就没有"加载后才发现要占位" |
| 运行时依赖只有 React | 体积预算的执行手段 |
| 构建产物 < 300KB | 实测 155KB JS（gzip 51KB）+ 3.2KB CSS |

也就是说：**如果这一页将来变慢，护栏会红；但"现在有多快"仍然没有数字**。
补上它的办法是在有 Chrome 的机器上跑一次 `perfpilot diagnose --url <报告页地址>`
—— 用这个工具自己量自己。

#### 一处与规格不同的实现选择

规格写的是 `web`（React + Vite），实际**没有引 `@vitejs/plugin-react`**：

- 那个插件提供 Fast Refresh（开发期热更新）与自动 JSX 运行时。后者 esbuild 原生支持，
  在 `vite.config.ts` 里写一行 `jsx: 'automatic'` 就够，而生产构建完全不需要热更新。
- 代价是 `pnpm dev` 下改组件会整页刷新；换来的是少一条 babel 依赖链
  （`@vitejs/plugin-react` → `@babel/core` → `browserslist` → `caniuse-lite`，
  这条链在本环境里恰好装不上，也说明它不该是必需品）。

#### 报告页的第二次改版（用户反馈："看不出提升了啥"）

第一版报告页是**单页信息流**：概览 + 趋势 + 瓶颈 + 时间线。它的失败方式不是崩溃，
而是**读者拿不到结论**：

| 用户的话 | 真实缺口 |
| --- | --- |
| "无法直观看出提升了啥" | 改善/回归/保留/回滚只是几个数字，没有任何一句话把"这一轮到底怎么样"说出来；变化箭头按数值方向画（LCP 从 3.5s 降到 2.0s 画了个下降箭头），读者每次都要在脑子里换算 |
| "数据是咋样的" | 指标表只列当前值，没有基线、变化、分数刻度与评级色；来源混在告警里，看不出"五个来源里挂了三个" |
| "不能直观看到诊断报告" | 瓶颈只有一张表（严重度/归因/影响量），没有证据、没有"这个瓶颈有哪些修法" |
| "做了哪些优化" | 时间线只有一行说明，**看不到补丁正文、决策理由、验证跑了哪些检查** |
| —（新增） | 只能看最近一次运行，**没法翻历史**；三个路由混在一个"最近一次"里 |

改版后的结构（每个区块只回答一个问题，结论写在最上面）：

| 标签 | 回答的问题 | 关键内容 |
| --- | --- | --- |
| 总览 | 这一轮怎么样，我要不要做点什么 | 一句话结论（按语气着色）+ 9 个统计 + 八段流水线（**skipped 的原因原样带出**）+ 数据来源表 + 采集告警 |
| 指标 | 具体是哪些数字、差在哪儿 | 当前值 / 基线 / 变化徽标（**按好坏画箭头**）/ 0-100 分数条 / 评级 / 来源；劣化行置顶并带左侧色条 |
| 诊断 | 为什么会这样 | 每个瓶颈一张卡：严重度、kind、置信度、归因、影响量、**证据（可展开）**、关联候选；**没有候选时明确说"规则库没有修法"** |
| 优化 | 工具做了什么 / 建议做什么 | 候选 → 决策 → 执行 → 验证全链路；可展开看**决策理由、要改什么、补丁正文、验证检查表** |
| 趋势 | 方向，而不是某一轮 | 每个指标一张卡：最新值、变化、手写 SVG 折线、最低/最高、数据点数 |

三条不变量没有让步：

1. **只读**。页面只读已经落盘的记录，不触发采集、不执行改动（`server` 的用例断言了这一点）。
2. **不加运行时依赖**。仍然是 React + 手写 SVG，没有图表库、没有路由库 ——
   标签页用 `location.hash`（顺带得到可分享链接），`perf.test.ts` 的依赖白名单守着它。
3. **"不知道"不说成"没问题"**。零指标时结论句明说"没测到"；来源不可用时单独成表；
   `skipped` 的阶段照原样解释为什么没做。

体积：174.75 kB JS（gzip 58.2 kB）+ 8.87 kB CSS，仍在 300 kB 预算内。
- 要热更新时把它加回来即可，改的只有 `vite.config.ts` 一个文件。

#### 两个真实缺陷

**1. 请求处理里抛异常 = 请求挂死，而不是 500。**
静态托管那段最初漏传了 `res`，`serveStatic` 里抛 `ReferenceError`。
因为请求是用 `void handler(req, res)` 发起的，异常变成一个未处理的 Promise 拒绝：
Node 打一行日志，**响应永远不发**，客户端一直转到超时。
排查时看到的是"页面转圈"，跟真正的原因隔着十万八千里。
现在静态托管整段自己兜异常 → 500 JSON。

**2. ESLint 的 `files: ['**/*.ts']` 让整个 `.tsx` 文件不受任何规则约束。**
报告页是 React 组件，加进仓库的第一天起就没有 lint。
验收 2 要求的"边界检查通过"当时是**假通过** —— 检查根本没跑。
已把 `tsconfig` 与 eslint 的 `files` 一并补上 `.tsx`。

#### 已知遗留

- ~~趋势只画本次一个数据点~~ → 加了 `GET /api/metrics`（跨 run 指标序列），
  聚合逻辑在 `core/trends`（服务端算、前端画，避免前端重新实现"来源变了就不比"）。
  **验收 1 的"跨 run"这一半现在是真的了。**
- **`perfpilot serve` 每次都要重新构建前端。** 目前 `web/dist` 不随 CLI 分发，
  发布形态（把 dist 打进 CLI 包、或用 CDN）留到真正要发布时再定 ——
  在那之前 `serve` 会在没构建时说清该跑哪条命令。
- ~~报告页没有鉴权~~ → 与 `serve --token` 共用同一层（页面本身不需要额外处理）。

### 里程碑状态汇总

| 里程碑 | 状态 | 测试文件 | 用例 |
| --- | --- | --- | --- |
| M1 采集 + 报告 | ✅ | 13 | 210 |
| M2 诊断归因 | ✅ | — | — |
| M3 方案生成 | ✅ | — | — |
| M4 决策层 | ✅ | — | 45 |
| M5 执行 + 验证 + 回滚 | ✅ | 26 | 526 |
| M6 Memory | ✅ | 28 | 546 |
| M7 CI 接入 | ✅ | 30 | 566 |
| M8 Web 报告页 | ✅ | 32 | 590 |
| **全量审计与修复** | ✅ | **39** | **688** |

（M2/M3 的用例数含在累计值里，未单独拆分；数字来自各里程碑验收时的 `pnpm check`。）

---

## 16. 全量审计与修复

M8 之后对整个项目做了一次通盘审计，目标是**消灭"说了没做"**：
声明了却不生效的配置、文档里承诺但没实现的能力、以及写了却没人读的数据。
`pnpm check` 全绿（39 个测试文件 / 688 个用例 / 83.6% 行覆盖）。

### 16.1 用户会直接踩到的三个坑

| 问题 | 后果 | 修法 |
| --- | --- | --- |
| `.perfpilot.yml.example` 的裁决刻度是 **M4 事故前的旧值**（`apply_score: 60` / `confirm_score: 35`，实际默认 30/10） | 照示例复制配置 → **12 个候选全被判 reject**，工具从此"什么都不做"且看不出哪里错 | 改成与 schema 一致的值，并在注释里写清"这两个数与真实候选的量纲对齐，别随手调大" |
| 规划器传 `quality: 0.8`，sharp 要 **0-100** | 被夹到 **1**：图片体积确实降了、门禁确实过了、**图确实糊了**，而报告里完全看不出来 | 规则改传 80；适配器同时接受两种写法（`0<q≤1` 视为比例），越界值夹到合法区间 |
| `convert-webp` 标成 A 类（全自动）却**改不出任何收益** | 产物是新文件，而引用它的 HTML/CSS/JS 仍指向旧文件 → 重新采集测到 0 → 门禁必然回滚，白跑一轮 | 降为 **B 类**并在标题里写明"需同步更新引用"：这一步无法可靠自动化，由人确认 |

### 16.2 死配置：声明了却不生效的开关

**比没有更糟** —— 用户会以为改了它有用。

| 字段 | 处理 |
| --- | --- |
| `ci.trigger` / `ci.baseline` | **删除整个 `ci` 段**。触发方式只由 CI 平台的 YAML 决定；基线策略在 `baseline.ref`。旧配置里写了 `ci:` 会在启动时被 `.strict()` 明确拒绝 |
| `collect.runs` | **实现**（逐指标取中位数降噪）。性能指标天然有抖动，而门禁判的正是差值 —— 单轮抖动会被读成"回归"。轮次之间**串行**：并发跑 Lighthouse 会争抢 CPU，取中位数也救不回来 |
| `target.repo` / `target.branch` | **接通**：不在 CI 里时作为 SCM 的兜底（PR 的 base 分支、仓库标识）。顺带处理了 `https://github.com/org/app` 与 `org/app` 两种写法 |
| `report.format: html` | **实现** HTML 报告（此前静默跳过）。归档场景需要它：CI artifact 下载下来双击就能看 |

### 16.3 数据与顺序缺陷

- **改动守卫的位置错了。** 注释写着"必须抓在 execute 之前"，调用点却在 execute 之后。
  打开资产写入后，`isClean()` 看到的会是自己刚弄脏的工作区 → 拒绝一切补丁，
  而二进制改动已经落盘，既没验证也没回滚。已挪到 execute 之前。
- **B 类候选会写盘。** 图片转码没有文本补丁，执行器直接写文件；而 B 类补丁**不进验证**，
  于是它写下的文件既没人验也没人回滚。现在只有 `apply` 裁决的候选能拿到 `writeFile` ——
  拿掉能力，而不是给它一个"你该不该写"的标志位。
- **Postgres 的布尔列被塞了 0/1。** 列声明是 `boolean`，塞整数会报类型错。
  这是"补 Postgres 测试"当天抓出来的：`candidateParams` 是两种方言共用的，
  而 0/1 只是 SQLite 的需要。现在按方言分开，并用重载让编译器盯着。
- **读回来的布尔只认数字。** Postgres 给 `true`，只认 `1`/`1n` 会把"成功过的方案"记成失败的 ——
  而记忆层的全部判断都建立在这个字段上。
- **资产执行器的摘要与事实不符。** 上下文没给 `writeFile` 时，摘要仍写"已写入工作区"。
  摘要是给人看的（报告、PR、人工确认），它必须说真话。

### 16.4 数据只写不读

- **`project_profiles.baselineMetrics`** → 现在用来做**基线漂移检测**：门禁判的是相对上次的差值，
  项目整体缓慢劣化时每次都在阈值内、门禁一路绿灯，三个月后 LCP 翻倍。
  漂移以 `BASELINE_DRIFT`（info 级）报出来，并明确写"这与本次改动的收益无关"。
- **真实验证收益** → 接上 **planner 估计的校准闭环**（M4 的标定遗留）：
  方案库存下每次验证的**逐指标原始收益**（不是归一化分数 —— 两者刻度不同），
  同一指纹累计 ≥3 次成功后按中位数校准 `expectedGain`。
  三条克制：样本不够不动、混合而不是替换、缩放系数夹在 0.25x-4x
  （20 倍偏差更像单位错误，不该写进估计）。

### 16.5 补上的能力

- **跨 run 指标趋势**（M8 验收 1 的"跨 run"那一半）：`GET /api/metrics`，
  聚合在 `core/trends`。放服务端而不是前端，是因为 `web` 只能 type-only 引用 shared，
  而"来源变了就不给变化量"属于测量正确性，只能有一份实现。
- **MR 评论改成 upsert**：找到带标记的旧评论就更新，反复推送的 MR 不再攒评论。
- **失败记忆的撤销入口**：`history --forget <指纹>` / `--forget-all`。
  失败记忆是一票否决，一次误判（当时环境坏了、阈值调紧过）会让一类改动永久消失 ——
  没有出口的话用户只能删库，而删库会连带上所有别的好记忆。
- **报告服务的可选鉴权**：`--token` / `PERFPILOT_TOKEN`，
  接受 `Authorization: Bearer` 与 `?token=`（浏览器要打开页面就得有这条路）；
  用常数时间比较。监听非本机地址却没设令牌时明确警告。

### 16.6 这轮审计的教训

**"测试全绿"和"功能可用"是两件事。** 这一轮找到的 15 个问题里，
绝大多数在单测里都是绿的 —— 因为测试只覆盖了"代码写了的那条路"，
而问题出在"配置说的和代码做的不一致"、"数据写了没人读"、
"两个模块对同一个量纲的理解不同"这些**跨模块的接缝**上。

因此这一轮的检查方式不是加断言，而是**逐个字段问一句**：
这个配置有代码读它吗？这张表有代码读它吗？文档里这句话今天还成立吗？
—— `.perfpilot.yml.example` 里那个旧刻度，就是这么问出来的。

### 16.7 真实试跑暴露的问题（第二轮）

第一轮审计靠"逐个字段问一句"，第二轮靠**真的拿一个前端项目跑一遍**。
后者才暴露得出来的是"平台相关"与"环境相关"的失效 —— 它们在单测里一律是绿的。

| 问题 | 症状 | 根因 | 修法 |
| --- | --- | --- | --- |
| Windows 上 Lighthouse 永远不可用 | 机器上装了 Lighthouse 13.5.0、`lighthouse --version` 正常，报告里仍写"lighthouse 不可用" | npm 全局装出来的可执行文件在 Windows 上是 `.cmd` 垫片：`execFile('lighthouse')` 得到 ENOENT（`execFile` 不做 PATHEXT 解析），写全 `lighthouse.cmd` 又得到 EINVAL（Node 20 起禁止脱离 shell spawn `.cmd`）。两种写法都表现为"探活失败" | Windows 上补 `.cmd` 并开 `shell`（与 check-runner 同一处理）；探活与真实采集共用 `resolveLighthouseBin` |
| YAML 留空直接校验失败 | 照注释把 `repo:` 留空 → `target.repo: Expected string, received null` | YAML 的空值是 `null`，而 zod 的 `.default()` 只对 `undefined` 生效 | 进 zod 之前 `dropNullValues`：只摘对象属性上的 null，数组里的 null 照旧报错 |
| `run --dry-run` 一份补丁都不产 | `--help` 写着"只生成 patch，不修改工作区"，实际等同于 `diagnose` | `apply` 一个变量同时承担了"进入变更闭环"与"是否写盘"两件事 | 拆开：`apply` 只管闭环，写盘由 pipeline 的 `dryRun` 决定 `allowWrite` |
| 只读诊断照样打印门禁结论 | 逐路由打印 `⛔ 门禁未通过`，退出码却是 0 | 门禁无条件评估，而退出码只在 `--ci` 时看它 | 只在 `apply` 或 `--ci` 时评估门禁，否则明说"未评估" |
| "1 条路由：1 条成功"配满屏 failed | 采集全线失败（零指标）被汇总成"成功"，退出码 0 | `ok` 只表示"流水线没抛异常"；探活没过的 adapter 连"失败"都不算 | 汇总区分 `ok` 与 `collected`；零指标按 `COLLECT_FAILED`（3）退出 |
| 一条候选都没有却警告"补丁已落盘" | 只读诊断 + 工作区脏 → 警告声称补丁已落盘、可手动应用 | 改动守卫无条件执行，且把"不应用"与"补丁已在盘上"写进同一句话 | 只在真可能落盘时取守卫；"补丁已落盘"挪到确实产出补丁之后才说 |
| `m5-loop` 用例依赖"这台机器没装 Lighthouse" | 装了 Lighthouse 的机器上 `fix` 用例超时，报出来的却是 SQLite 文件锁 | 用例靠环境碰巧成立，而非显式声明"没有采集来源" | 用例显式注入"五个来源都不可用" |

**教训：** "装好依赖就能用"这句话必须在**每一个**目标平台上被真的执行一次。
这一轮 7 个问题里有 5 个在 Linux 单测里根本不可能出现；剩下 2 个
（`--dry-run`、成功/失败汇总）是**文档承诺与实现不一致** ——
它们不会让任何测试变红，只会让用户得出"这工具在骗我"。

### 16.8 真实项目第二轮：闭环为什么永远保留不了东西

拿一个真实的 Vue + Vite 项目（`vite.config.js`、npm 安装）跑完整 `run` 之后，
又暴露出三个问题。前两个已修，第三个是这一轮最重要的发现。

| 问题 | 症状 | 根因 | 修法 |
| --- | --- | --- | --- |
| 候选里的文件名写死扩展名 | 预期省 436KB 的 `manualChunks` 候选一条补丁都没产出，报告只写"1 条无改动" | 诊断器归因与方案库都写死 `vite.config.ts`，而项目里是 `vite.config.js`；执行器读不到文件就跳过 | `resolveExistingFile`：精确匹配不中时试同名其它扩展名，**不猜目录** |
| 跳过原因只活在内存里 | "1 条无改动"之外什么都没有，用户只能猜 | `skippedExecutions[].reason` 从未进入阶段备注或任何落盘产物 | 阶段备注里写明原因（`describeSkipped`） |
| **验证阶段不重新构建** | 改动只落在源码/配置上，而重采集读的是 `dist/` 与部署地址 —— 不重建就等于用改动前的产物评估改动后的代码，收益恒为 0、候选必然被回滚，而报告给的理由是"收益不足" | 检查项只有 `unit-test / type-check / lint / e2e`，没有任何一步产出构建产物 | 新增 `build` 检查项，排在检查列表**最前**（重采集之前）；项目没有 `build` 脚本时记为 skipped，不误伤 |

**教训：** "验证"这件事的隐含前提是**被测对象已经反映了改动**。
在一个有构建步骤的前端项目里，这个前提不会自动成立 ——
工具必须自己把构建跑出来，否则整套"执行 → 验证 → 回滚"是一个永远回滚的闭环，
而且它给出的理由（收益不足）听起来完全合理。

### 16.9 规则库的"自信的错误"（第三轮）

接着上一条继续查"这条候选为什么产不出补丁"，结果发现问题不在执行器，
而在**规则库编造了它不掌握的事实**。这一轮的四条：三条是"说了假话"，
一条是"能自动做的事被关着"。

| 问题 | 症状 | 根因 | 修法 |
| --- | --- | --- | --- |
| `manualChunks` 承诺的收益不可能兑现 | 报告写着"预期节省 436KB"，排在最前面 | `expectedGain` 直接抄了瓶颈的 `impact.JS_SIZE`（= 该 chunk **超出预算**的部分）。拆 chunk 前后 JS_SIZE（全部 JS 之和）**完全相等** —— 它改善的是缓存与并行加载，而这两件事本项目一个都不测量 | 降为 C 类只出建议、`expectedGain` 留空；关键限制写进**标题**（报告的方案表只渲染标题，不渲染 description） |
| `manualChunks` 写死别人的依赖 | 在 Vue 项目上生成 `vendor: ['react','react-dom']`、`lib: ['lodash-es','dayjs']` | 规划阶段拿不到项目的依赖清单（`PlannerContext` 里没有），于是"示例值"被当成了真实值 | 同上：改发一条不依赖具体包名的建议 |
| 预加载提示的 `as` 一律是 `fetch` | 用 `as="fetch"` 预加载 JS/CSS/字体 | 规则没看 `attribution.contentType`。猜错的代价是**比不加更慢**：浏览器按 fetch 预取一份，解析到 `<script type="module">` 时发现目的地不符，会丢掉重下 | `preloadAs()` 按 contentType（扩展名兜底）推导；**判断不出来就不发候选**；字体补 `crossorigin` |
| `before: null` + 非 JSON 文件 → 静默失败 | `add-preload` 是 **A 类**（会真的自动执行），却从来没产出过补丁 | 配置执行器只会"精确替换已有文本"，不会"插入新内容"；`index.html` 不是 JSON，于是每次都返回"需要 before 提供可定位的原文" | HTML：把片段插到 `</head>` 前，缩进对齐 head 里的子元素；**JS/TS 配置文件里的插入刻意不做** —— 往用户配置里插代码需要解析对象结构、判重、猜缩进，改错的代价高于不做，如实拒绝 |

**教训：** 规则库是"确定性"的，于是它的错误也**确定地**出现 ——
不会偶发、不会自愈，每跑一轮就重复一次。单测覆盖的是"规则有没有输出"，
而这类问题问的是另一个问题：**这条规则的输出，是它真的知道的事实吗？**

关于"要不要支持在 JS/TS 配置里新建键"：查完之后发现它唯一的消费者就是
上面那条编造收益的候选。候选改成建议之后，这个能力**没有使用者**，
因此按硬约束 10（不为复杂度而复杂度）没有实现。等哪天有一条真正需要它
且收益可测量的规则（例如 `build.target`），再补。

### 16.10 发布形态审计（`npm publish` 之前）

打包成 npm 包**换了一整套运行环境**：从"仓库里跑源码，`node_modules` 里什么都有"，
变成"用户在任意目录 `npm i -D`，只有 `package.json` 里声明过的东西"。
所以这一轮的验法是：真的打出 tarball、装进一个空项目、把命令跑一遍 ——
下面每一条在仓库里都跑得通，只有装成包之后才暴露。

| 问题 | 后果 | 修法 |
| --- | --- | --- |
| `asset` 适配器顶层 `import sharp from 'sharp'` | sharp 带平台原生二进制，musl / 非常见架构 / `--no-optional` 的机器上装不上；而本模块被 `executor/registry` 间接引用 → **每个命令一启动就崩**，连 `init`、`history` 都跑不了 | 移到 `optionalDependencies`，首次真要处理图片时才 `await import()`（specifier 用变量，避免 TS / 打包器把它当硬依赖）。装不上时该图片跳过，且执行器能认出"处理器没改动字节"并如实写进摘要；启动时再 warn 一句该装什么 |
| `serve` 数 `../` 层数找报告页（"往上两层就是 `packages/`"） | npm 装下来是 `node_modules/@yuki-byte18/cli/dist/commands/` —— 从那儿往上数**永远数不到** `packages/web/dist`。报告页 404、只剩 API，而源码树里一切正常 | 用 `createRequire(import.meta.url).resolve('@yuki-byte18/web/package.json')` 顺着 Node 的解析规则找，源码树布局作兜底。同时把 `@yuki-byte18/web` 加进 `cli` 的依赖 —— 否则装完根本没有报告页产物可托管 |
| 报告页把 React 放在 `dependencies` | 消费者为了一个**已经构建好的静态页**白装一份 React；而"体积预算"守卫盯的是 `dependencies`，一个塞进 `devDependencies` 的图表库它根本看不见 | React 移到 `devDependencies`；守卫改成"运行时依赖必须为空 + 构建期依赖必须命中白名单"，比原来更严 |
| 根 `engines.node` 写 `>=20` | `node:sqlite` 在 **22.5** 才出现，且在 **22.13**（22.x）/ **23.4**（23.x）之前还在 `--experimental-sqlite` 后面 → Node 20 上 `run` / `history` 直接失败 | 六个包统一 `>=22.13.0`，并写清这个数字是"**不需要 flag**"的下限（不是"有 node:sqlite"的下限） |
| `init` 无条件打印"包管理器 pnpm（由 lockfile 判断）" | 项目根没有 lockfile 时它是**回落默认值**，不是判断结果 —— 报告里凭空出现了一个工具并不知道的"事实" | 文案改成 `（项目根有对应 lockfile；没有则回落 pnpm）` |
| LLM 装不上时提示写死 `npm add ai @ai-sdk/openai` | 配的是 anthropic 却让你装 openai，看起来像是配置写错了 | 按 `provider` 拼出对应的 provider 包名；`ai` 本身缺失时也给同一句话，而不是把 Node 的 `ERR_MODULE_NOT_FOUND` 抛给用户 |

**顺带把"幽灵依赖"查了一遍。** 写了个一次性脚本对六个包的 `src` 做静态扫描，
把每个裸导入与 `package.json` 的声明对照。结论是**没有幽灵依赖**：
`pg`（`memory/postgres`）是**注入**的、`ai`（`core/llm`）是**按需动态加载**的，
两者都刻意不作为依赖存在；`web` 对 `@yuki-byte18/shared` 全部是 `import type`
（硬约束 3 仍然成立）。审计脚本用完即删 —— 这类一次性检查不值得留成一个常驻工具。

**发布形态本身是验过的**，不是推断：`pnpm -r pack` 打出六个 tarball，
装进一个空项目后 `perfpilot --help` / `init` / `serve` 全部跑通，
报告页 `GET /` 返回 200 且两个 asset 都取得到；tarball 里没有 `src`、
没有测试文件，`workspace:*` 被替换成真实版本号，`bin` 的 shebang 保留。

**LLM 的可选 SDK 仍是"用户自己装"。** 一开始把 `ai` / `@ai-sdk/*` 声明成
`optionalPeerDependencies`，结果实测 pnpm 11 **连可选 peer 也会自动装**
（一次装进来 12 个包）—— 那等于让每个只想跑规则库的用户替一个默认关闭的功能付安装成本。
### 16.11 推上 GitHub 之前的整理

这一轮的判据很朴素：**别人 clone 下来能不能跑、CI 是不是真的绿、文档有没有在说假话。**

| 问题 | 后果 | 修法 |
| --- | --- | --- |
| `init` 生成 CI 文件时，没有把 CI 检出 PerfPilot 的目录写进 `.gitignore` | 模板把 PerfPilot 检出到 `tools/perfpilot`，而**它就在被测仓库里面** → `git status` 永远是脏的 → 改动守卫永远拒绝应用补丁。症状极具误导性：报告写"工作区不干净"，指向的是用户自己的改动 | `init` 在生成 CI 文件之后追加这一条，理由写进 `.gitignore` 的注释里；判"已忽略"改成逐条比对，并且认上层目录（写了 `tools/` 就不重复追加） |
| 根目录那份 `.github/workflows/perfpilot.yml` 是"给 PerfPilot 自己跑性能门禁" | 它**永远不可能通过**：本仓库没有 `.perfpilot.yml`，也没有可测量的网页（这是个工具，不是网站）。一份永远红的流水线比没有流水线更糟 —— 它会让真正的红色也被忽略 | 删掉，换成 `.github/workflows/ci.yml`：风格 → 循环依赖 → 类型 → 构建 → 测试（含覆盖率门禁）。**GitHub 版的门禁模板本来就不该落盘**：它由 `perfpilot init --ci github` 生成到使用者仓库里 |
| `ci.ts` 与 `.gitignore` 各写一遍 `tools/perfpilot` | 模板改了路径、忽略规则没跟着改 → 又回到上面那条自锁，而且没人会发现 | 路径收进 `PERFPILOT_CHECKOUT_DIR` 一个常量；测试从**生成的 workflow 里抠出**这个路径再跟 `.gitignore` 比对，两边不一致就红 |
| `scripts/syntax-check.mjs` / `verify-pure-logic.mjs` 里写死了 `D:/user/deepseek-harness/...` | 它们是"依赖装不上那段时期"的最低限度检查。现在依赖齐全，两个脚本既跑不了别处、也没人调用 —— 却带着作者机器的绝对路径进公开仓库 | 连同 `pnpm syntax` / `pnpm verify:logic` 一起删掉。它们的职责已由 `pnpm typecheck` 与 `pnpm test` 覆盖 |
| 缺 README、缺 `.gitattributes` | 仓库首页是空的；Windows 开发 + Linux 跑 CI，两边换行不一致会产生大量 diff 噪声，真实改动反而被淹没 | 补 `README.md`（定位 / **不做什么** / 用法 / 门禁判据 / 退出码 / 架构 / 文档索引）、`CONTRIBUTING.md`（环境、两条硬规则、怎么加一条优化规则、首次推送后要改的三处）、`.gitattributes`（`* text=auto eol=lf` + 二进制标记 + lockfile 折叠） |

**两条新测试**：一条验"生成 CI 文件后 `tools/perfpilot/` 确实进了 `.gitignore`"（路径是从生成的 workflow 里抠出来的，不在测试里抄第二份字面量），一条验"不生成 CI 文件时不写那一行"（不给不用 CI 的项目塞一条它看不懂的规则）。

**验证方式**：不是只看单测绿。用构建好的 CLI 在一个临时项目里真跑了一遍 `init --yes --ci github`，逐行核对生成的 `.gitignore`（两条规则 + 各自的理由注释）与 workflow 里的检出路径是否一致。

---

---

## 15. ADR 列表

`docs/decisions/`：

| 编号 | 标题 | 核心结论 |
| --- | --- | --- |
| [001](./docs/decisions/001-why-monorepo.md) | 为什么用 Monorepo | 六个包共享类型契约，靠依赖边界规则而非仓库边界来约束架构 |
| [002](./docs/decisions/002-why-not-dag.md) | 为什么不用 DAG 引擎 | 依赖关系静态，唯一并行是同层 fan-out；DAG 的复杂度换不来收益 |
| [003](./docs/decisions/003-why-jev.md) | 决策为什么用期望值模型（以及为什么不用托管 Jev） | 优化取舍是不确定性下的期望值问题；但托管 Jev 是神经决策模型，会抽掉「决策可复现」这个地基 |
| [004](./docs/decisions/004-why-no-multi-agent.md) | 为什么不用多 Agent | 价值在可复现的测量与可回滚的补丁；实测规则库已覆盖全部瓶颈，LLM 只是兜底 |
| [005](./docs/decisions/005-why-linear-pipeline.md) | 为什么用线性流水线 | 八段顺序由因果决定，产物独立落盘，`stages` 让进度自描述 |
| [006](./docs/decisions/006-why-patch-first.md) | 为什么执行器只产出 patch | 补丁是唯一同时可审计、可回滚、可人工确认的产物 |
| [007](./docs/decisions/007-why-sqlite-first.md) | 为什么先 SQLite 后 Postgres | CI 里不该为了记录历史而依赖外部数据库；`MemoryPort` 让存储成为实现细节 |
| [008](./docs/decisions/008-why-llm-only-diagnosis.md) | 为什么 LLM 只能主导诊断、不能主导决策 | 诊断错得起（给人看、带证据、可复核），决策错不起（要机器执行，必须可复现） |
每个 ADR 记录四段：**背景 / 决策 / 理由 / 取舍**。

---

## 快速开始

```bash
pnpm install
pnpm build
cp .perfpilot.yml.example .perfpilot.yml   # 或者用 `perfpilot init` 自动生成
echo '.perfpilot/' >> .gitignore           # 必须做，原因见下
pnpm perfpilot diagnose --url https://example.com   # 先只诊断，不改代码
pnpm perfpilot run                                  # 完整闭环：会真的改代码
```

**`.perfpilot/` 必须先进 `.gitignore`。** 不是洁癖：`run` 与 `fix` 在动手之前会检查
`git status`，工作区不干净就拒绝应用任何补丁（因为回滚是 `reset --hard`，
会连带丢掉未提交的改动）。而 run 产物正是写在这个目录里的 ——
不忽略它，第一次运行就把工作区弄脏，之后每一次自动改动都会被自己的保护拦住。

想先看看能改什么、又不想让工具碰工作区：

```bash
pnpm perfpilot run --dry-run               # 只产出 patch
pnpm perfpilot fix --only A                # 只落地 A 类（全自动那类）
pnpm perfpilot fix --candidate cand_8f2a   # 只落地指定候选
```

开发：

```bash
pnpm dev          # turbo watch
pnpm dev:web      # 只起报告页的 Vite 开发服务器
pnpm test         # vitest
pnpm test:cov     # 覆盖率（门禁 70%）
pnpm lint         # eslint（含依赖边界检查）
pnpm typecheck    # tsc --noEmit
pnpm check        # lint + 循环依赖 + typecheck + 覆盖率，提交前跑这个
```

报告页要先构建，`perfpilot serve` 才能托管它：

```bash
pnpm --filter @yuki-byte18/web build   # 产物在 packages/web/dist
pnpm perfpilot serve --port 3099     # 打开 http://127.0.0.1:3099
```

没构建时 `serve` 只提供 API，并在访问 `/` 时直接告诉你上面那条构建命令 ——
而不是给一个裸 404。

---

## 17. 打包与发布（npm）

六个包都发到 npm 的 `@yuki-byte18` scope 下，但**用户只需要装 `@yuki-byte18/cli`**，
其余五个由它带进去。

### 发布（维护者视角）

```bash
npm login                 # 账号要能写 @yuki-byte18 scope（没有就先在 npm 上建 org）
pnpm release:dry          # clean + 全量重建 + 打包预览（不上传）
pnpm release              # clean + 全量重建 + 测试 + pnpm -r publish --access public
```

- **构建用 `turbo run clean && turbo run build --force`，不是 `pnpm build`。** 这一轮发布踩到的坑：
  `tsc` 不会删除"源码已经删掉"的旧产物，而 turbo 的缓存会把**旧的整个 `dist/`** 原样 replay 回来 ——
  于是刚删掉的文件又进了包里（实测：删掉 `commands/pending.ts` 后，`dist/commands/pending.js`
  依然被打进 tarball）。所以发布这条路上必须先 clean、再用 `--force` 重新构建，
  不复用任何缓存产物。
- `pnpm -r publish` 会把 `workspace:*` 自动换成真实版本号，并按拓扑序发布
  （`shared → adapters → web → core → server → cli`）。
- `--no-git-checks` 是因为**本仓库目前没有 git 仓库**。一旦 `git init` 并推上远端，
  建议去掉它：那个检查拦的正是"工作区有未提交改动却要发布"。
- 版本号目前靠手改六个 `package.json`（没有引入 changesets —— 六个包的版本本来就一起动）。
- `repository` 字段暂时留空：仓库还没有远端地址，填一个猜的 URL 比留空更糟。

### 安装（使用者视角）

```bash
npm i -D @yuki-byte18/cli       # 或 pnpm add -D / yarn add -D
npx perfpilot init            # 生成 .perfpilot.yml（+ 可选 CI 文件）
npx perfpilot run             # 完整闭环
npx perfpilot serve --port 3099
```

Node 要求 **≥ 22.13**：`node:sqlite` 在 22.5 才出现，且在 22.13（22.x）/ 23.4（23.x）
之前还在 `--experimental-sqlite` 后面 —— 这个下限写的是"**不需要 flag**"的版本（§16.10）。

### 六个包分别是什么

| 包 | 内容 | 值得注意的地方 |
| --- | --- | --- |
| `@yuki-byte18/cli` | 命令行入口 | 用户唯一要装的包；`bin.perfpilot` |
| `@yuki-byte18/shared` | 类型 / zod schema / 端口 | 全项目唯一类型来源 |
| `@yuki-byte18/adapters` | lighthouse / ts-morph / sharp / git 的适配 | `sharp` 在 `optionalDependencies`：装不上也能用，只是跳过图片优化 |
| `@yuki-byte18/core` | 流水线 / 决策 / 报告 | `ai` 与 `@ai-sdk/*` **不在依赖里**（见下） |
| `@yuki-byte18/server` | 只读报告 API | |
| `@yuki-byte18/web` | 报告页静态产物 | 只有 `dist/`，且**故意没有 `exports`/`main`** —— 这样 `cli` 能解析到它的 `package.json` 来定位目录 |

### 为什么 LLM SDK 既不是 dependency 也不是 peer

`llm.provider` 默认 `none`，绝大多数用户根本不会开启它。声明成
`optionalPeerDependencies` 试过：pnpm 11 **连可选 peer 也会自动装**（实测一次装进来 12 个包），
那等于让所有人替一个默认关闭的功能付安装成本。因此 `ai` / `@ai-sdk/openai`
只放在 `core` 的 `devDependencies`（我们自己测试用），消费者要用时自己装
（`npm i -D ai @ai-sdk/openai`），装不上时自动降级为仅规则库。

---

## License

MIT
