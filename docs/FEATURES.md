# dsh-agents-toml 功能说明

> 本文档描述**当前已实现**的功能与边界，与 `src/` 代码一一对应。安装步骤见 [README](../README.md)，真机验证结论见第 10 节。

## 1. 定位

用 TOML 文件为 DeepSeek Harness 声明**具名子代理**，把它们作为**一个工具 + `agent_type` 参数**暴露给模型，委派走 DSH 自身的 `ctx.subagents` 提供方。插件是普通 bundle，不修改 DSH 源码。

## 2. 功能清单

| 能力 | 实现状态 | 说明 |
|---|---|---|
| 用户级定义 | ✅ | `$DSH_HOME/agents/*.toml`，始终加载 |
| 项目级定义 | ✅ | `<projectRoot>/.dsh/agents/*.toml`，**默认关闭**，需 `trustProjectAgents: true` |
| 项目根判定 | ✅ | 会话 cwd 向上最近的含 `.git` 目录；找不到则用 cwd 本身 |
| 同名优先级 | ✅ | 项目覆盖用户；**同一目录内重名 → 两个都判失败** |
| 单工具 + `agent_type` | ✅ | 一个工具，`agent_type` 枚举按该 Agent 的定义集生成，省 schema token |
| 定义热生效 | ✅ | 每次调用重新读取文件，改完下一次委派即生效 |
| 目录监听 | ✅ | `watchDefinitions`（默认开）→ 文件增删改后重装工具，刷新 `agent_type` 枚举 |
| 按 Agent 安装 | ✅ | 每个 Agent 装进自己的作用域（`agent.ctx`），不同项目看到不同定义集 |
| 能力校验 | ✅ | 定义用了 provider 不支持的能力 → 该定义判失败并给出原因 |
| 失败隔离 | ✅ | 单文件失败不影响其他定义，**绝不影响 Agent 创建** |
| 计划任务/结构化返回 | ✅ | `output_schema`（仅 `one-shot`）→ 子代理返回结构化结果 |
| 可继续子代理 | ✅ | `mode = "continuable"` → 返回子代理 id，可用 `send_message` 继续 |
| persona | ✅ | 只作用于该子代理，遮蔽部署 persona |
| 工具过滤 | ✅ | `[tools] allow/deny`：从子代理提示词移除 **且** 拒绝执行 |
| 深度上限 | ✅ | `max_depth`（绝对值，最小 1） |
| 子代理模型路由 | ✅ | `llm_provider` / `model` / `reasoning_effort` / `max_tokens` |
| 只读子代理 | ⚠️ 近似 | 只能用 `[tools] deny` 限制工具；**权限预设/沙箱/审批不可按定义设置**（见第 11 节） |
| 失败可视 | ✅ | 日志 warn + 工具描述列出不可用定义 + 调用时明确报错 |

## 3. 插件行配置

写进 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`（或插件页）：

```yaml
- id: dsh-agents-toml
  config:
    trustProjectAgents: false      # 是否允许项目目录的定义（默认 false）
    toolName: subagent_custom      # 模型看到的工具名（默认 subagent_custom）
    defaultProvider: spawn         # 定义未指定 provider 时用的传输（默认 spawn）
    projectAgentsDir: .dsh/agents  # 项目内相对目录（默认 .dsh/agents）
    watchDefinitions: true         # 监听定义目录并热重装（默认 true）
    reportFailuresToModel: true    # 在工具描述里列出不可用定义（默认 true）
    userAgentsDir: 'D:/my/agents'  # 可选：覆盖用户目录（默认 $DSH_HOME/agents）
```

注意：patch 是整段替换 `config`，但未写的字段由 schema 默认值补齐，所以只写要改的项即可。

`$DSH_HOME` 解析：环境变量 `DSH_HOME`（去空白后非空）优先，否则 `~/.dsh`。

## 4. 定义文件规范

### 4.1 目录与优先级

| 目录 | 作用域 | 默认加载 |
|---|---|---|
| `$DSH_HOME/agents/*.toml` | 用户级（整机） | 是 |
| `<projectRoot>/.dsh/agents/*.toml` | 项目级（随仓库） | 否，需信任开关 |

- 只读扩展名为 `.toml` 的文件，按文件名排序；非 `.toml` 忽略。
- 项目根 = 会话工作目录向上最近的含 `.git` 目录；无 `.git` 时用工作目录本身。
- 同名：项目定义覆盖用户定义；**同一目录内重名 → 两个都判为失败**（不猜赢家）。
- 会话没有工作目录时只加载用户级定义。

### 4.2 字段

```toml
name = "reviewer"                    # 必填，唯一；模型用它填 agent_type
description = "只读代码审查"           # 必填；模型据此选择该子代理
enabled = true                        # 默认 true；false 时不进枚举，调用会报 "is disabled"
mode = "one-shot"                     # "one-shot"（默认，等结果）| "continuable"（后台持久子代理）
provider = "spawn"                    # 传输名；省略则用 defaultProvider
llm_provider = "deepseek-official"    # 子代理 LLM 路由 provider
model = "deepseek-v4-flash"
reasoning_effort = "high"
max_tokens = 4096                     # 正整数
persona = """对子代理的系统提示补充"""
max_depth = 1                         # 被创建子代理的绝对深度上限；最小 1
output_schema = { type = "object", properties = { summary = { type = "string" } }, required = ["summary"] }

[tools]
allow = ["read", "grep"]              # 可选
deny = ["write", "edit"]              # 可选
```

键名允许用 `-` 代替 `_`（`llm-provider` ≡ `llm_provider`）。

### 4.3 校验规则（全部 fail loud）

| 规则 | 行为 |
|---|---|
| 未知键 | 定义失败，报出未知键名 |
| `name` 缺失/非法 | 失败；须匹配 `[a-z0-9][a-z0-9_-]{0,63}`（大小写不敏感） |
| `description` 缺失/空 | 失败 |
| `mode` 非 `one-shot`/`continuable` | 失败 |
| `max_depth` 为 0 | **失败**：该上限约束被创建子代理的深度（≥1），0 会让委派本身被拒 |
| `max_depth` 为负/非整数 | 失败 |
| `max_tokens` 非正整数 | 失败 |
| `output_schema` 不是 TOML 表 | 失败（须是对象根 JSON Schema） |
| `[tools]` 出现非 allow/deny 键 | 失败 |
| TOML 语法错误 | 失败，附解析错误信息 |

解析层会把 TOML 的 null-prototype 对象归一化为普通对象（`output_schema` 会交给 Harness 做 lossless-JSON 校验）。

## 5. 工具面

### 5.1 schema

工具名 = `toolName`（默认 `subagent_custom`），参数三个且都必填：

| 参数 | 类型 | 说明 |
|---|---|---|
| `agent_type` | string（枚举 = 当前可用定义名） | 选哪个子代理 |
| `description` | string | 3–5 词标签；同时作为子代理的 durable label |
| `prompt` | string | 自包含任务说明（子代理不共享本会话上下文） |

工具描述包含：用途说明 + `Configured subagents: a, b.` + 可选 `Unavailable definitions: name (原因).`

### 5.2 调用语义

1. 校验参数（`agent_type`/`description`/`prompt` 非空）。
2. **重新读取定义**（热生效）→ 按名查找启用的定义；找不到时给出可用名单，命中失败定义时给出原因。
3. 选 provider（定义的 `provider` 或 `defaultProvider`）→ 未注册则列出已注册 provider。
4. 能力位校验（见第 9 节）→ 不匹配则报明确原因。
5. 解析深度：定义 `max_depth` 优先，否则读 Host 设置。
6. 检查取消信号 → 分派：
   - `one-shot`：`ctx.subagents.start(provider, request)` → 等 `result` → **总是 dispose**；
   - `continuable`：`ctx.subagents.startContinuable({provider, label, request, signal})` → 返回 `started subagent <childId>`。
7. 结果映射：`completed` → 返回子代理最终文本（无文本时给占位句）；非 `completed` → 工具报错，内容是 `the subagent did not complete: <stopReason>` + 提供方诊断 + 部分输出。

委派不修改父会话，因此声明为并发安全（`isConcurrencySafe: () => true`）。

## 6. 生命周期与安装模型

```text
插件激活
  ├─ 订阅 agent/created  → 为每个新 Agent 安装工具
  ├─ 读取 ctx.get('agents').list() → 为"激活前已存在"的 Agent 补装
  └─ 订阅 agent/disposed → 释放该 Agent 的工具
安装 = agent.ctx.inject(['tools','subagents'], ctx => ctx.tools.register(tool))
卸载 = ctx.effect(...) 关闭 watcher + 释放全部 fiber
```

- **为什么需要"补装"**：一次性运行（headless）在**插件激活期间**就创建了 Agent，`agent/created` 已经错过；这与官方 `tool-subagent` 的 `reconcileComposedAgents()` 同构。
- **失败隔离**：安装过程中的任何异常都只记 warn，**不会 reject Agent 创建**。
- 不同项目 → 不同 Agent → 不同定义集，互不影响。

## 7. 失败可见性

| 通道 | 内容 |
|---|---|
| 日志 `warn` | `dsh-agents-toml: <file>: <原因>`（同一文件+原因只报一次） |
| 日志 `info` | 安装成功：`installed N subagent definition(s) for <cwd> as "<tool>"` |
| 日志 `info` | 信任关闭时提示：`ignoring project definitions in <dir>; set trustProjectAgents: true ...` |
| 工具描述 | `Unavailable definitions: <name> (<原因>)`，`reportFailuresToModel: false` 可关 |
| 调用报错 | 未知名 → 列可用名单；失败定义 → 给原因与文件；provider 缺失 → 列已注册名 |

## 8. 热更新与生效时机

| 变更 | 是否需要重启 |
|---|---|
| 增删改 `*.toml` | **不需要**：调用时重读；`watchDefinitions` 开启时枚举同步刷新（防抖 200ms） |
| 关闭 `watchDefinitions` | 新名字要等该 Agent 下次创建才进枚举，但直接调用新名字仍即时生效 |
| 插件行 `config` 变更 | 走 DSH 的配置 HMR（开启 HMR 的 profile） |
| 安装/卸载插件 bundle | web profile（默认开 HMR）不需要重启；HMR 关闭的 profile 需要 |
| 升级插件自身代码 | 已加载模块不热替换，建议重启 |

## 9. 能力位映射

| 定义字段 | 需要的提供方能力 | 实际支持者 |
|---|---|---|
| `llm_provider` / `model` / `reasoning_effort` / `max_tokens` | `agentOptions` | `spawn`、`fork`、`dsh-sdk` |
| `persona` | `persona` | `spawn`、`fork` |
| `tools.allow` / `tools.deny` | `toolFilter` | `spawn`、`fork` |
| `max_depth` | `depthLimit` | `spawn`、`fork` |
| `output_schema` | `outputSchema` | `spawn`、`fork`（且仅 `one-shot`） |
| `mode = "continuable"` | `prepareContinuable` | `spawn`、`fork` |

`acp` / `codex` / `claude-code` 不声明任何启动能力，因此这些字段用在它们身上会让**该定义**判失败（不会静默忽略）。

## 10. 真机验证结论

已在隔离环境（独立 `$DSH_HOME`、一次性 profile、独立端口）完成验证：

| 平面 | 方式 | 结论 |
|---|---|---|
| 组合与加载 | `--dump-config`、`--dump-config-schema` | ✅ 出现插件层/行与 Config schema |
| headless | 离线 Messages 协议 stub（脚本化 tool_use） | ✅ 完整委派链路，父子会话各持久化 |
| headless | **真实模型** | ✅ 36s；项目级定义；persona 命中；工具过滤 25 → 23（`write`/`edit` 消失） |
| **web GUI** | **真实模型 + CDP 驱动真实点击** | ✅ 模型调用 `subagent_custom`（`agent_type=gui-reviewer`）；子会话 persona 命中、`write/edit=false`；`subagent/catalog` 记录子代理；父子两会话持久化 |
| **GitHub 安装路径** | 本地 git 克隆模拟 + **真实仓库 `github:Heluojiang/dsh-agents-toml`** | ✅ 干净检出无 `lib/`；pnpm 先拦截 `prepare`，按 pnpm 打印的完整 key（codeload tarball URL + SHA）放行后重跑成功；安装副本由 `prepare` 构建出 `lib/`，且该构建产物能被 Harness 装载（Config schema 被采集、行进入组合） |

验证期间发现并修复的三个缺陷（均由真机暴露）：

1. **一次性运行漏装工具** —— Agent 在插件激活期间创建，`agent/created` 已被错过 → 增加激活时对已存在 Agent 的补装。
2. **`max_depth = 0` 永远不可用** —— 该上限约束被创建子代理的深度，0 会让委派本身被拒 → 解析期判失败并解释。
3. **工具名是部署相关的** —— 示例里的 `bash`/`terminal` 在 Windows headless 不存在，触发 `tools.restrict() names unknown global tools ...` → 示例改为可移植的 `write`/`edit`。

## 11. 明确不支持的能力

- **权限预设 / 沙箱 / 审批策略不可按定义设置**：委派时由父会话快照继承（Auto/Full 让子级获得相同权限预设；Read Only / Workspace Write 保留继承的沙箱覆盖与 `approval: never`）。"只读子代理"只能用 `[tools] deny` 近似，且需一并 deny shell 类工具。
- **provider 实例级设置不可按定义设置**：如 `claude-code` 的 `permissionMode`、`acp` 的 `command/args/env`、`dsh-sdk` 的 `profile/dshHome` —— 这些属于 profile 里的插件行；定义只能按名选择已注册的 provider。
- **子代理工作目录不可按定义设置**：继承父会话 cwd（`acp`/`dsh-sdk` 的 provider 行可整体覆盖）。
- **不能给子代理增加工具**：`[tools]` 只能做减法。
- **未暴露 `run_in_background`**：后台语义由定义的 `mode` 决定。
- **无设置页开关**：项目级信任只能通过插件行 config 显式开启。
- **工具名写错只能在调用期发现**：DSH 未暴露可枚举的全局工具名清单，因此无法在安装期预检 `[tools]` 名字。
- **`continuable` 不支持 `output_schema`**：该能力只适用于一次性运行。

## 12. 实现结构

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 插件契约：`name` / `inject` / `Config`(Schemastery) / `apply` |
| `src/plugin.ts` | 按 Agent 安装与释放、补装、失败上报、目录 watcher、`ctx.effect` 清理 |
| `src/discovery.ts` | 用户/项目目录、项目根回溯、优先级、重名处理 |
| `src/definitions.ts` | TOML 解析与字段校验、null-prototype 归一化 |
| `src/mapping.ts` | 能力位校验、启动请求构造、结果映射 |
| `src/tool.ts` | 工具 schema、入参校验、委派执行 |
| `src/host.ts` | 宿主 ctx 的结构性类型声明（**不 import 任何 `@deepseek-ai/dsh-*`**） |

宿主契约：`ctx.tools.register`、`ctx.subagents.{getProvider,list,start,startContinuable,resolveMaxDepth?}`、`ctx.on('agent/created'|'agent/disposed')`、`ctx.inject`、`ctx.get('agents')`、`ctx.logger`、`ctx.effect`。
运行时依赖仅 `@deepseek-ai/schemastery`（Config schema）与 `smol-toml`；构建用 `tsc` 产出 ESM + `.d.ts`。

## 13. 测试

```sh
npm run check   # tsc 类型检查 + node --test
```

61 个单测覆盖：TOML 解析与全部校验分支、目录优先级与重名、能力位矩阵、请求映射（含 continuable 字段裁剪）、工具 schema 与入参校验、委派成功/失败/取消、按 Agent 安装与释放、watcher 重装、卸载清理、激活前已存在 Agent 的补装。

测试使用假 `ctx` 与内存文件系统，**不启动 DSH、不读写真实 `$DSH_HOME`**。
