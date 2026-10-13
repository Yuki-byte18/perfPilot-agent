# @yuki-byte18/adapters

把外部工具的原始输出翻译成 `@yuki-byte18/shared` 类型的那一层。

硬约束：**所有外部工具调用都在 adapter 里** —— `core` 不认识 lighthouse、ts-morph 或 git，它只认识端口。

| 目录 | 做什么 |
| --- | --- |
| `lighthouse/` | 跑 Lighthouse 并解析结果（Windows 上要补 `.cmd` 并用 `shell`，否则 `execFile` 会报 ENOENT / EINVAL） |
| `har/` `trace/` `web-vitals/` | 解析 HAR、长任务 trace、web-vitals 归因 |
| `bundle-analyzer/` | 分析构建产物的体积与依赖构成 |
| `executor/` | 四类改动的执行器：AST 改写、配置编辑、依赖编辑、二进制资产 |
| `check-runner/` | 跑 `build` / `unit-test` / `type-check` / `lint` / `e2e` |
| `git/` `scm/` | git 操作（脏检查、diff、回滚）与 GitHub / GitLab 集成 |
| `memory/` | SQLite（默认）与 Postgres 两种实现，共用同一套行映射 |

## 可选依赖：sharp

`sharp` 带平台相关的原生二进制，在 musl、非常见架构或 `--no-optional` 的机器上装不上。因此它位于 `optionalDependencies`，并且是**懒加载**的：只有真的要处理图片时才 `await import()`。装不上时图片类候选会被跳过（执行摘要会写明"处理器未改动字节"），其它功能完全不受影响 —— 一个只想跑 `init` / `history` 的用户不该因为装不上 sharp 而用不了整个工具。

## 安装

一般不需要单独安装：它是 `@yuki-byte18/cli` 的依赖。

## 许可

MIT
