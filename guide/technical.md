# dsh-agents-toml 技术文档

> 本文档面向**维护者与深入使用者**，描述当前已实现的机制、规则与边界，与 `src/` 代码一一对应。
>
> **面向使用者的内容在 [README](../README.md)**：安装步骤、四个设置项的作用、TOML 完整示例与逐字段参考表。
> 本文不重复那些内容，只讲"为什么这样、内部如何判定、出错时的确切原因"。

## 1. 定位

用 TOML 文件为 DeepSeek Harness 声明**具名子代理**，把它们作为**一个工具 + `agent_type` 参数**暴露给模型，委派走 DSH 自身的 `ctx.subagents` 提供方。插件是普通 bundle，不修改 DSH 源码。

## 2. 功能清单

| 能力 | 实现状态 | 说明 |
|---|---|---|
| 用户级定义 | ✅ | `$DSH_HOME/agents/*.toml`，始终加载 |
| 项目级定义 | ✅ | `<projectRoot>/.dsh/agents/*.toml`，**默认关闭**，需 `trustProjectAgents: true`（开启方式见 [README](../README.md#开启项目级子代理)） |
| 项目根判定 | ✅ | 会话 cwd 向上最近的含 `.git` 目录；找不到则用 cwd 本身 |
| 同名优先级 | ✅ | 项目覆盖用户；**同一目录内重名 → 两个都判失败** |
| 单工具 + `agent_type` | ✅ | 一个工具，`agent_type` 枚举按该 Agent 的定义集生成，省 schema token |
| 定义热生效 | ✅ | 每次调用重新读取文件，改完下一次委派即生效 |
| 目录监听 | ✅ | `watchDefinitions`（默认开）→ 文件增删改后重装工具，刷新 `agent_type` 枚举 |
| 按 Agent 安装 | ✅ | 每个 Agent 装进自己的作用域（`agent.ctx`），不同项目看到不同定义集 |
| 能力校验 | ✅ | 定义用了 provider 不支持的能力 → 该定义判失败并给出原因 |
| 失败隔离 | ✅ | 单文件失败不影响其他定义，**绝不影响 Agent 创建** |
| 计划任务/结构化返回 | ✅ | `output_schema`（仅 `one-shot`）→ 子代理返回结构化结果 |
| 可继续子代理 | ✅ | `mode = "continuable"` → `ctx.subagents.startContinuable()`，在入队被接受时返回 `{childId}`；收尾时续接管理器投递**带最终文本的结算通知**给父会话（无文本时说明 `It left no closing message.`），续聊靠官方 `send_message`（本插件不注册该工具） |
| persona | ✅ | 只作用于该子代理，遮蔽部署 persona |
| 工具过滤 | ✅ | `[tools] allow/deny`：从子代理提示词移除 **且** 拒绝执行 |
| 深度上限 | ✅ | `max_depth`（绝对值，最小 1） |
| 子代理模型路由 | ✅ | `llm_provider` / `model` / `reasoning_effort` / `max_tokens` |
| 只读子代理 | ⚠️ 近似 | 只能用 `[tools] deny` 限制工具；**权限预设/沙箱/审批不可按定义设置**（见第 11 节） |
| 失败可视 | ✅ | 日志 warn + 工具描述列出不可用定义 + 调用时明确报错 |
| 插件页配置 | ✅ | 挂在**本插件自己的插件页**上（插件 → 已安装 → dsh-agents-toml），改 4 个 volatile 字段，保存即生效（见 §3） |
| 内置 Skill | ✅ | 包内 `assets/skill/SKILL.md` 经 `ctx.skills` 发布，模型在技能目录里看到 `dsh-agents-toml` 并据此代写定义（见 §17） |

## 3. 插件行配置

**该行由本 bundle 的 `cordis.patch.yml` 在安装时自动插入**（`id: dsh-agents-toml`），7 个配置键全部有 schema 默认值，因此 `config` 整段可以完全不写。使用者要改配置时优先用插件页设置项（见 [README](../README.md#插件设置项)）；本文只说明每个键的确切语义。

| 键 | 默认值 | 读取方式 | 语义 |
|---|---|---|---|
| `trustProjectAgents` | `false` | 每次发现定义时读取 | 是否让 `<projectRoot>/<projectAgentsDir>` 参与发现 |
| `toolName` | `subagent_custom` | 每次安装工具时读取 | 注册到 `ctx.tools.register` 的工具名 |
| `watchDefinitions` | `true` | 每次打开目录监听前读取 | 关闭后不再开 `fs.watch`，`agent_type` 列表停止自动刷新 |
| `reportFailuresToModel` | `true` | 每次安装工具时读取 | 是否把失败定义写进工具描述 |
| `defaultProvider` | `spawn` | 每次调用时读取 | 定义未写 `provider` 时使用的传输名 |
| `projectAgentsDir` | `.dsh/agents` | 每次发现定义时读取 | 项目根下的相对目录 |
| `userAgentsDir` | 未设置 | 每次发现定义时读取 | 覆盖用户级目录（绝对路径） |

前四项声明为 **`.volatile()`**，因此有两个后果：

1. **只有 volatile 字段能做进 Host 的设置表单**（`dsh-settings` 的规则），这也是设置项恰好是这四项的原因；后三项属于部署布局，只能在补丁里改。
2. **Host 对每个 volatile 字段只维护一个稳定引用并原地更新**，写入设置项时不会重挂载该行。因此 `src/plugin.ts` 不缓存取值，而是每次需要时调用 `config.<key>.get()`；任何在 apply 时快照取值的写法都会在该行不重载的情况下读到过期值（真机实测过这个缺陷）。

`$DSH_HOME` 解析：环境变量 `DSH_HOME`（去空白后非空）优先，否则 `~/.dsh`。

### 配置写入后的生效路径

| 路径 | 机制 | 结果 |
|---|---|---|
| 插件页设置项 | 写入 profile 的 Cordis 补丁 + 原地更新 volatile 引用 | 下一次委派即按新值执行；`agent_type` 列表在下一次安装时刷新 |
| 手改 `cordis.patch.yml` | DSH 监听补丁文件并重载该行（开启 HMR 的 profile） | 同上，但需要一次重载 |
| `--patch` 覆盖层 | 每次启动生效，不改 profile | 适合临时验证 |

验证（无需启动服务）：

```powershell
dsh --profile web --dump-config > $env:TEMP\dump.txt
Select-String -Path $env:TEMP\dump.txt -Pattern 'dsh-agents-toml' -Context 0,8
```

若输出里出现 `patch: entry "dsh-agents-toml" not found`，说明该 profile 没有安装本插件，补丁里的 `- id:` 指向了不存在的行。

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

字段清单、类型、可选项、默认值与"所需能力"的对照表在 [README · TOML 字段参考](../README.md#toml-字段参考)；本节只讲**校验与解析**这一侧的实现。

键名先做 `-` → `_` 归一化（`llm-provider` ≡ `llm_provider`），再与已知键集合比对；任何未列出的键都判失败。

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
| `prompt` | string | 自包含任务说明（子代理默认在自己的上下文里工作；`fork` 这类继承父级已完成轮次的传输除外，工具描述会区分） |

工具描述包含：用途说明 + 传输是否继承上下文的说明 + `Configured subagents: a, b.` + 可选的 continuable 提示与 `Unavailable definitions: name (原因).`。「是否继承上下文」由安装期读取 provider 的 `inheritsParentContext` 决定（provider 尚未注册时按不继承计），因此同一次安装里的两类传输不会被一句笼统的措辞覆盖。

### 5.2 调用语义

1. 校验参数（`agent_type`/`description`/`prompt` 非空）。
2. **重新读取定义**（热生效）→ 按名查找启用的定义；找不到时给出可用名单，命中失败定义时给出原因。
3. 选 provider（定义的 `provider` 或 `defaultProvider`）→ 未注册则列出已注册 provider。
4. 能力位校验（见第 9 节）→ 不匹配则报明确原因。
5. 解析深度策略（`depthFor`）：定义写了 `max_depth` 就原样下发；否则**仅当 provider 具备 `depthLimit`** 时才下发 Host 的 `subagent.maxDepth`，否则不下发并记一条 warn（原因见第 9 节末）。
6. 检查取消信号 → 分派：
   - `one-shot`：`ctx.subagents.start(provider, request)` → 等 `result` → **总是 dispose**；
   - `continuable`：`ctx.subagents.startContinuable({provider, label, request, signal})` → 返回 `started subagent <childId>`。该 Promise 在**入队被接受**时就 resolve（不等待子代理开跑或落盘），措辞与官方 `subagent` 工具在 continuable 下逐字一致 —— **结论不在本次返回值里**。子代理结算时由 `dsh-subagent` 的续接管理器 `notifySettlement()` 向父会话投递一条 user 消息：开头是结局句（`Background subagent <id> finished and will do no further work unless you send it more.`，另有 stopped / ran out of room / declined / failed 四种），随后是子代理**最终 assistant 输出中的非空文本块**（无非空文本时写 `It left no closing message.`）；该投递是**无条件**的（只要调用方拿到过 id），父会话空闲会被唤醒，且**不受 Agent Teams 影响**。不回传的是中间过程（工具输出、推理、中途文本），那些靠 `send_message` 往返；续聊（steer / wake / 冷启动）属于官方 `dsh-tool-subagent-control`，本插件不重复实现。
7. 结果映射（`describeResult`）：捕获到结构化值 → 返回该值的 JSON 文本（子代理同时留了文本时附在其后，中间空一行）；否则 `completed` → 返回最终文本（无文本时给占位句）；非 `completed` → 工具报错，内容是 `the subagent did not complete: <stopReason>` + 提供方诊断 + 部分输出。定义配了 `output_schema` 却没拿到值时，错误里补一句 `the child did not produce a value for output_schema`（Harness 会把这类"跑完但没交值"改写成 `stopReason: error`，不补这句会看起来像模型崩了）。

委派不修改父会话，因此声明为并发安全（`isConcurrencySafe: () => true`）。

## 6. 生命周期与安装模型

```text
插件激活
  ├─ 订阅 agent/created  → 为每个新 Agent 安装工具
  ├─ 读取 ctx.get('agents').list() → 为"激活前已存在"的 Agent 补装
  └─ 订阅 agent/disposed → 释放该 Agent 的工具
安装 = agent.ctx.inject(['tools','subagents'], ctx => ctx.tools.register(tool))
卸载 = ctx.effect(...) 关闭 watcher + 释放全部注册
```

- **每个 Agent 的安装串行化**（`src/installation.ts`）：`agent/created`、目录 watcher、激活期补装三处都可能同时为同一个 Agent 触安装。安装链保证前一步结束才开始下一步，且**卸载后落地的安装不再注册**。没有这层顺序时，两次重叠安装会先后注册同名工具，第二次被注册表按"already registered in this scope"拒绝，第一次的注册则泄漏。
- **watcher 随需求增减**：期望集合 = 所有存活安装当前需要的目录之并，每次安装/释放后重新对齐。因此关掉 `watchDefinitions` 会**关闭已打开的监听**；目录当时不存在（`fs.watch` 抛 `ENOENT`）**不会被记成"已监听"**，下一次安装会重试。
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
| 关闭 `watchDefinitions` | **立即**关闭已打开的目录监听；此后新名字要等该 Agent 下次创建才进枚举，但直接调用新名字仍即时生效 |
| 插件页设置项写入 | **不需要**：写入落到 profile 补丁。只改 volatile 字段时 Loader **不重挂该行**，而是原地更新引用并发出 `loader/volatile-update`，插件在该事件里重新对齐目录监听——因此 `watchDefinitions` 立即生效；`trustProjectAgents` 每次发现定义时读取（下一次委派即生效）；`toolName` 与 `reportFailuresToModel` 在下一次安装（新任务/新会话）时读取。改到非 volatile 字段（`defaultProvider` / `projectAgentsDir` / `userAgentsDir`）则会重挂该行 |
| 手改 `cordis.patch.yml` | 开启 HMR 的 profile 会重载该行；关闭 HMR 的 profile 需要重启 |
| 安装/卸载插件 bundle | web profile（默认开 HMR）不需要重启；HMR 关闭的 profile 需要 |
| 升级插件自身代码 | 已加载模块不热替换，建议重启；刷新浏览器会重新拉取 `lib/client.js` |

## 9. 能力位映射

字段与能力的对照表在 [README · 生效条件](../README.md#生效条件能力位)。本节给出 `src/mapping.ts#CAPABILITY_RULES` 的**判定顺序与报错原文**——它是唯一的判据来源，`tests/mapping.spec.ts` 断言这张表的 id 顺序，因此文档不会与代码漂移：

| 顺序 | 规则 id | 触发条件 | 报错原文 |
|---|---|---|---|
| 1 | `agentOptions` | 定义了 `llm_provider`/`model`/`reasoning_effort`/`max_tokens` 任一，但 provider 无 `agentOptions` | `child LLM routing is unsupported by this provider` |
| 2 | `persona` | 定义了 `persona`，但无 `persona` | `persona is unsupported by this provider` |
| 3 | `toolFilter` | 定义了 `tools`，但无 `toolFilter` | `tool filtering is unsupported by this provider` |
| 4 | `depthLimit` | 定义了 `max_depth`，但无 `depthLimit` | `an explicit depth cap is unsupported by this provider` |
| 5 | `outputSchema` | 定义了 `output_schema`，但无 `outputSchema` | `a structured output schema is unsupported by this provider` |
| 6 | `outputSchemaOneShot` | 同时有 `output_schema` 与 `mode = "continuable"` | `a structured output schema applies to one-shot runs only` |
| 7 | `continuable` | `mode = "continuable"` 且 provider 未实现 `prepareContinuable` | `continuable mode is unsupported by this provider` |

这些检查在**调用期**执行（provider 的注册情况是运行时事实，安装期无法判定），报错统一包成：

```
subagent "x" cannot run on provider "codex": child LLM routing is unsupported by this provider
```

`acp` / `codex` / `claude-code` 声明 `NO_START_CAPABILITIES`（五项能力全无），因此在它们身上使用上述任一字段都会让该定义在调用时不可用；`dsh-sdk` 只有 `agentOptions`。

**隐含深度上限为什么不能无条件下发**：Harness 的服务端在 `start()` 里断言「请求带 `maxDepth` → provider 必须有 `depthLimit`」，而官方工具在挂载期就以 `maxDepth: 'provider-managed'` 明确放弃下发。本插件照同一取舍处理：`max_depth` 是定义作者显式要求的上限（provider 不支持就是该定义的失败）；**没写时不下发隐式上限**给不支持该能力的 provider，否则 `acp`/`codex` 上哪怕一个能力字段都没写也会在调用期整体失败。想让这类 provider 一定有深度上限，就在定义里写 `max_depth`（那时它会明确报"不支持"）。

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
- **插件页配置已提供，但不通用**：web GUI 里本插件的配置显示在它自己的插件页上，通过 `plugins.bundle.config`（键 = bundle 包名）注册。它**不是**通用的 schema 驱动表单：Host 的 `dsh-settings` 只把 `.volatile()` 字段做成可编辑表单，而每个配置页都是插件自带的客户端包（`ctx.configForms.whileServed` + 插件页插槽）——通用页面目前没有客户端实现，所以任何插件想要 UI 都得自带半边；想放在官方栏就用 `plugins.item`，想放在自己的 bundle 页就用 `plugins.bundle.config`。
- **`defaultProvider` / `projectAgentsDir` / `userAgentsDir` 不在设置页**：这些是部署布局，不是每用户偏好，只能在插件行 config 里改（因此它们也不是 volatile）。
- **工具名写错只能在调用期发现**：DSH 未暴露可枚举的全局工具名清单，因此无法在安装期预检 `[tools]` 名字。
- **`continuable` 不支持 `output_schema`**：该能力只适用于一次性运行。

## 12. 实现结构

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 插件契约：`name` / `inject` / `Config`(Schemastery) / `apply` |
| `src/plugin.ts` | 按 Agent 安装与释放、补装、失败上报、目录 watcher、`ctx.effect` 清理 |
| `src/installation.ts` | 每个 Agent 的安装账本：串行化、卸载后不落地、watcher 期望目录集合 |
| `src/harness.ts` | **唯一**的宿主能力探测点：可选服务（Agent 注册表 / 共享深度策略）与缺失时的明确降级日志 |
| `src/discovery.ts` | 用户/项目目录、项目根回溯、优先级、重名处理 |
| `src/definitions.ts` | TOML 解析与字段校验、null-prototype 归一化 |
| `src/mapping.ts` | 能力位规则表（`CAPABILITY_RULES`）、深度策略（`depthFor`）、启动请求构造、结果映射 |
| `src/tool.ts` | 工具 schema、入参校验、委派执行 |
| `src/host.ts` | 宿主 ctx 的结构性类型声明（**不 import 任何 `@deepseek-ai/dsh-*`**） |
| `src/skill.ts` | 包内 `assets/skill/SKILL.md` 的读取与技能 provider |
| `src/client/index.tsx` | 客户端半边：插件自身页面上的配置区（`configForms.whileServed` + `plugins.bundle.config`，键 = bundle 包名），单文件以便 `tsc` 直出 |
| `src/client/shell-modules.d.ts` | 浏览器模块表的契约声明（jsx-runtime、ui-primitives、client/store） |
| `scripts/build-client.mjs` | 把 CJS 产物包装成 `window.__ModuleLoader__.load({id, factory})` 并校验自洽 |
| `scripts/check-harness-shape.mjs` | 用已安装的 DSH 校验本插件依赖的声明是否还在（`npm run check:harness`） |

宿主契约：`ctx.tools.register`、`ctx.subagents.{getProvider,list,start,startContinuable,resolveMaxDepth?}`、`ctx.on('agent/created'|'agent/disposed'|'loader/volatile-update')`、`ctx.inject`、`ctx.get('agents')`、`ctx.logger`、`ctx.effect`。
客户端契约：`ctx.slots.{inject,register}`、`ctx.locale.register`、`ctx.configForms.{get,whileServed}`、`ctx.effect`。
运行时依赖仅 `@deepseek-ai/schemastery`（Config schema）与 `smol-toml`；构建用 `tsc` 产出 ESM + `.d.ts`，客户端半边用 `tsc`（CJS）+ `scripts/build-client.mjs` 产出 `lib/client.js`，**不需要打包器**（客户端半边必须是单文件：shell 每个包只服务一个产物，factory 不能同步 require 兄弟 chunk）。

## 12b. 宿主契约的校验方式（应对 DSH 演进）

本插件不 import `@deepseek-ai/dsh-*`，换来的是"发布包版本可以落后于运行时"；代价是编译器看不到声明变化。因此有两道守卫：

| 守卫 | 位置 | 检查什么 |
|---|---|---|
| 架构单测 | `tests/architecture.spec.ts` | 宿主半边不得 import 任何 `@deepseek-ai/dsh-*`；客户端半边只能用 shell 模块表里的名字且不得把它列为依赖；manifest 名 = 补丁行名 = 客户端 `BUNDLE_NAME` = `ENTRY_ID`；`.volatile()` 字段恰好是卡片渲染的四个 |
| 运行时声明检查 | `npm run check:harness` | 逐条核对已安装 DSH 的声明：`subagents.start` / `startContinuable` / `getProvider` / `resolveMaxDepth`、`SubagentResult.structured`、`depthLimit`、`inheritsParentContext`、`prepareContinuable`、`loader/volatile-update`、`skills.registerProvider`、`plugin-manager/changed`、`remote.<namespace>`、`listBundles` / `listPlugins`、两个团队包。缺一条即 `DRIFT` + 非零退出，并指出要改的模块 |

`check:harness` 刻意**不进 `npm test`**（单测不依赖 DSH 安装）；它在本地与发布前手动运行，且可用 `DSH_SHAPE_ROOT` 指向别的安装位置。

## 13. 测试与构建

```sh
npm run check          # typecheck:host + typecheck:client + check:docs + test
npm run check:harness  # 用已安装的 DSH 校验宿主声明（§12b；不在 check 内，因为它需要 DSH 环境）
npm run build          # build:host（tsc → lib/*.js、lib/types/*.d.ts）+ build:client（tsc CJS → 包装成 lib/client.js）
npm run test           # 只跑测试；pretest 会先重建 lib/client.js
```

- **两个编译面**：宿主用 `tsconfig.json` / `tsconfig.build.json`（ESM + 声明），客户端用 `tsconfig.client.json`（CJS，`removeComments`，输出到临时目录后由 `scripts/build-client.mjs` 包装）。两者互不包含对方的源文件（根配置 `exclude: ["src/client"]`）。
- **`pretest` 会先构建客户端产物**：产物级测试读取真实的 `lib/client.js`，不先重建就会测到旧产物（这个坑真的踩过）。
- **单测**（`npm test`）覆盖：TOML 解析与全部校验分支、目录优先级与重名（含"坏文件不得吞掉同名合法定义"）、目录不可读时上报而非当成空目录、项目根定位失败时仍加载用户定义、能力位规则表顺序、深度策略（显式 / Host / 不支持时不发）、结构化结果与失败诊断、工具 schema 与入参校验、委派成功/失败/取消、按 Agent 安装与释放、重叠安装串行化、卸载后不落地、watcher 重装/关闭/目录后出现、卸载清理、激活前已存在 Agent 的补装、volatile 惰性读取与 `$DSH_HOME` 解析。
- **架构单测**（`tests/architecture.spec.ts`）覆盖面见 §12b。
- **产物级测试**（`tests/client-artifact.spec.ts`）在 Node 里用桩模块表执行真实的 `lib/client.js`，断言：加载器握手格式、导出契约（`apply`/`inject`/`NS`/`ENTRY_ID`/`BUNDLE_NAME`）、**只注册 `plugins.bundle.config` 一个插槽且键为 bundle 包名**（不得出现 `plugins.item`）、卡片渲染与开关暂存。产物缺失时该测试自跳过。
- 测试使用假 `ctx` 与内存文件系统，**不启动 DSH、不读写真实 `$DSH_HOME`**。
- 发布注意：`publishConfig.access: public` 是 scoped 包公开发布所必需的（默认 restricted）；`files` 需要覆盖运行时会用到的全部相对产物与文档（`lib`、`assets`、`cordis.patch.yml`、`README.md`、`guide`）；`prepublishOnly` 会在发布前跑完整 `check`。

## 14. 安装路径与构建脚本放行

| 路径 | 行为 |
|---|---|
| `dsh plugin add <本地目录>` | 以 link 方式加入 profile；改代码后重启该进程即可生效 |
| `dsh plugin add @heluojiang/dsh-agents-toml` | 走 npm 注册表，装的是已构建产物。pnpm 11 的 `minimumReleaseAge` 会让**裸包名解析到上一个够老的版本**（实测：新版本发布 20 分钟后装到的仍是上一版），并把解析到的 `包@版本` 追加进 `pnpm-workspace.yaml` 的 `minimumReleaseAgeExclude`；要装最新版须显式写 `@<版本>` |
| `dsh plugin add github:<you>/dsh-agents-toml#<sha>` | 克隆源码后在包内执行 `prepare`（= `npm run build`），因此安装副本自带 `lib/`（含客户端半边） |

pnpm ≥10 默认拦截依赖的构建脚本：第一次 `add` 会以 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` 失败，并打印放行所需的**完整 key**（被规范化成 codeload tarball URL 且带提交 SHA）。把它追加到 `$DSH_HOME/profiles/<profile>/pnpm-workspace.yaml` 的 `allowBuilds:` 下再重跑。只写裸包名不足以放行；SHA 随提交变化，更新提交后要补新 key。放行构建脚本等同于允许该包以你的权限执行代码，因此只放行自己信任的仓库并固定提交。

## 15. 客户端半边

- **发现方式**：`dsh-client-modules` 扫描 Host Loader 的**行**，对每行解析到的包读取 `package.json` 的 `dsh.client` 声明；本插件复用已有的宿主行（`dsh-agents-toml`），因此不需要额外的客户端行。声明要求存在 `./client` 导出，否则扫描直接抛错。
- **产物契约**：`lib/client.js` 必须是**一个** CommonJS 文件，被 `window.__ModuleLoader__.load({ id, factory })` 包住；factory 的参数 `require` 就是模块表——只有基线模块可用（`react`、`react/jsx-runtime`、`react-dom`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`）。**不能有同步的相对 `require`**（运行时不会加载同包的兄弟 chunk），因此整个客户端半边写成一个文件。
- **构建方式**：`tsc -p tsconfig.client.json` 产出 CJS → `scripts/build-client.mjs` 加 wrapper，并断言没有相对 require、没有重复注册，最后删掉临时目录。不需要打包器（本包没有 esbuild/rolldown 依赖）。
- **类型来源**：npm 上发布的 `@deepseek-ai/dsh-client-*` 版本落后于运行时（`0.0.1-rc.1` vs 运行时的 `0.2.x`），因此本包不依赖它们，而用 `src/client/shell-modules.d.ts` 声明**模块表契约**（只声明用到的 API），宿主侧同理用结构性类型（`src/host.ts`）。
- **注册**：`ctx.configForms.whileServed([ENTRY_ID], …)` + `ctx.slots.inject('plugins.bundle.config', …)`，键为 bundle 包名。`plugins.item` 属于官方设置页，用它会出现在"官方"栏；bundle 自己的配置按插槽契约走 `plugins.bundle.config`，渲染在插件自身页面上。

## 16. 隔离式端到端验证步骤

真机验证请使用一次性 Harness home 与一次性 profile，别碰正在使用的 profile：

```powershell
$env:DSH_HOME = 'D:\temp\dsh-plugin-e2e\home'
dsh --profile plugin-dev --from-default-profile web
dsh plugin --profile plugin-dev add D:\Work\Codes\Others\dsh-agents-toml
dsh --profile plugin-dev --dump-config | Select-String dsh-agents-toml
dsh --profile plugin-dev --port 3099 --no-open     # 控制台会打印带 token 的 URL
```

验证要点：`--dump-config` 里出现插件行与 `config`；启动后新任务里能看到该工具与 `agent_type` 列表；真机委派后检查会话日志（`sessions/.../session.v4.jsonl.zstd`，多帧 zstd）里的 `tool/call`、`subagent/catalog` 与子会话文件。设置项的写入可以直接观察 profile 的 `cordis.patch.yml` 是否被更新。

## 17. 内置 Skill
包内 `assets/skill/SKILL.md` 是**模型可见**的定义撰写指南（英文，与工具描述一致），让用户在装完插件后用自然语言就能得到一份合法定义。

**注册方式**（`src/skill.ts` + `src/index.ts` 的 `contributeSkill`）：提供方实现 `ctx.skills.registerProvider((control) => provider)`，候选形状为

```ts
{ name: 'dsh-agents-toml', description, whenToUse?, invocation: { modelInvocable: true, userInvocable: true },
  source: 'bundled', provider: 'dsh-agents-toml', resourceBase: { kind: 'directory', path: <包根> }, rank: 600 }
```

- `rank: 600` 与上游 `BUNDLED_SKILL_RANK` 一致：包内技能排在本地技能之后，重名时由本地技能胜出。
- `resourceBase` 指向**包根**，因此技能正文里的 `guide/technical.md`、`guide/*.toml` 相对路径可直接被模型读取，不必在包内再复制一份模板。
- 与 `src/host.ts` 的既有立场一致，这里同样**不 import `@deepseek-ai/dsh-skill`**：类型是结构性的，rank 是协议常量。

**为什么用可选子 fiber**：`skills` 不在插件的 `inject` 导出里——否则没有技能服务的组合会让整行无法激活，委派功能一起失效。`contributeSkill` 用 `ctx.inject(['skills'], …)` 单独等待该服务，父行不受影响。

**降级策略**：资产缺失或 frontmatter 不合法时记一条 `error` 日志并**不注册**技能，插件其余功能照常。资产里的 `name` 若与注册名不一致也按失败处理，避免"目录里显示的名字"与"文件自称的名字"漂移。

**发现与刷新**：`tool-skill` 把技能目录作为持久会话目录注入（`<available_skills>` 块），并订阅 `skills/change`——因此注册发生在**运行中的会话**里也会推送一份替换目录，无需重启会话。

## 18. 与 Agent Teams 的互斥关系（检测实现）

用户文档只保留结论与后果（README 的「与智能体团队不支持组合使用」），这里记录实现。

**为什么是客户端检测**：要提示的是"用户在插件页看到的那个开关"，权威数据源就是插件页自己读的那份清单，因此客户端半边直接用**同一个远程命名空间**：

```text
ctx.remote.pluginManager.listBundles()   // 网关应答 RemoteResult<BundleInfo[]>
ctx.remote.pluginManager.listPlugins()   // BundleInfo{ name, enabled, rows[{rowId,moduleName}], overrides[] }
```

判定式（任一成立即视为团队在运行）：

```text
bundle.enabled && /(^|[/@-])agent-team(-profile)?$/u.test(name)
plugin.enabled && moduleName ∈ { '@deepseek-ai/dsh-experimental-agent-team', '@deepseek-ai/dsh-experimental-tool-agent-team' }
```

名称正则同时匹配官方包名 `@deepseek-ai/dsh-experimental-agent-team-profile`（因此不需要再单独比较该常量）；第二条覆盖"没装组合包但把团队行挂进 profile"的情形；正则覆盖第三方同名组合包——它们造成的冲突与官方一致，报出来才是对的。**host 半边不做任何检测**：多一条真相源只会让"提示"与"实际组合"漂移。

**注入与取数**（两处实测踩点）：

1. 网关把每个命名空间装成**独立服务** `remote.<namespace>`（`remoteServiceKey`），所以 `inject` 必须写成 `['slots','locale','configForms','remote','remote.pluginManager']`——只注入基服务 `remote` 时 `ctx.remote.pluginManager` 是 `undefined`，提示会静默消失。
2. 网关以 `RemoteResult<T>` 作答：`{ ok: true, value }` 或 `{ ok: false, error }`（`@deepseek-ai/dsh-typert-protocol`）。**必须拆信封**：直接当数组用会抛 `bundles.some is not a function`，而且抛在异步链上会变成未处理的 rejection（本次实测即如此）。

**关闭语义**：这里有两个不同的"关闭"，不要混淆：

- **关闭提示框**（本插件实现）：点提示右上角 `×`，状态存进浏览器 `localStorage`（键 `dsh-agents-toml.agent-team-warning.v1`，与本仓库客户端既有做法一致），不写入 profile 配置；存储不可用时只对本次访问生效。
- **关闭智能体团队**（用户自行操作）：提示只是提醒，本插件**不调用** `pluginManager/setBundleEnabled`，也不会改写 profile——关闭动作始终发生在插件页「官方」栏或 `dsh plugin remove`。

**失败语义**：任一读取失败、返回 `ok:false` 或答非所问时，保持上一次状态——不误报冲突，也不误清"已忽略"标记；只有**观察到 bundles 且无冲突**才重置该标记（"关掉团队再开启"因此会重新提示）。整个读取包在 try 内，任何异常都不会冒泡成未处理 rejection。

**订阅**：`ctx.remote.$on('plugin-manager/changed', refresh)`——开关一改就重读；事件缺失时退化为"打开页面检测一次"。

**已知限制**：本插件行被禁用时没有卡片，也就没有提示——README 是持久警示渠道；换浏览器会重新提示一次。
