# @yuki-byte18/shared

PerfPilot 的**唯一类型来源**：全项目用到的类型、`zod` schema、错误码、端口（interface）定义与纯函数工具。

## 为什么单独成包

六个包共享同一套类型契约。类型定义重复一份就会漂移 —— 而这里漂移的代价是"报告里说的字段"和"数据库里存的字段"对不上。依赖方向也因此必须是单向的：`shared ← adapters ← core ← cli/server`（由 ESLint 的 `no-restricted-imports` 强制）。

## 安装

一般**不需要**单独安装：它是 `@yuki-byte18/cli` 的依赖。只有在自己写采集器 / 执行器时才需要：

```bash
npm i -D @yuki-byte18/shared
```

```ts
import { MetricNameSchema, type Metric, type CollectorPort } from '@yuki-byte18/shared';
```

新实现一个端口（例如换一个测量来源）时，只要满足 `CollectorPort`，`core` 不需要任何改动。

## 两个约定

- **schema 是唯一事实来源。** 能由 `zod` 推断出来的对象类型就不要手写 interface：手写的那份会和 schema 悄悄漂移。
- **报告页对本包只有 `import type` 依赖。** 一个值导入就会让报告页的产物体积跟着后端类型走（硬约束 3）。

## 许可

MIT
