# 从 0.3.x 升级到 0.4.0（适配 dsh-v0.2.1-rc.2）

## 一句话

**0.4.0 只支持 `dsh-v0.2.1-rc.2` 及以上。** DSH 0.2.1 从"启动子代理"的请求里删掉了**逐子代理 persona** 与**逐子代理工具过滤**两个字段，0.4.0 因此把对应的 TOML 键 `persona` 与 `[tools]` 一并移除，并把它们的位置交给 **Agent Preset**（`agent_preset`）。

| 插件版本 | 支持的 DSH |
|---|---|
| `v0.3.4` | `dsh-v0.2.0-rc.2` |
| `v0.4.0` | `dsh-v0.2.1-rc.2` 及以上 |

在 `dsh-v0.2.0-rc.2` 上安装 0.4.0 会被**拒绝**（`engines.dsh` 与 `peerDependencies` 都声明了 `>=0.2.1-rc.2`）。确实要试，用 `dsh plugin allow-version` 放行 —— 但**不要这么做**：0.4.0 调用的 `ctx.subagents.startActivation` 在 0.2.0 上不存在，第一次委派就会抛 `startActivation is not a function`。拒绝安装是刻意设计，比运行时才炸好。

## 一、被移除的两个字段

### 1. `persona` → preset 里的 `dsh-persona` 行

```toml
# 0.3.x
persona = """
你是资深代码审查者。只报告问题与依据，不修改文件。
"""
```

```toml
# 0.4.0
agent_preset = "reviewer"      # 人设搬到这个 preset 里
```

人设文本搬到那个 preset 的插件行里（`config.prefix`）：

```yaml
# $DSH_HOME/profiles/<profile>/cordis.patch.yml
- id: agent-presets
  config:
    presets:
      reviewer:
        name: 只读代码审查
        description: 只报告问题与依据，不修改文件。
        plugins:
          - id: persona
            module: '@deepseek-ai/dsh-persona'
            config:
              prefix: |
                你是资深代码审查者。只报告问题与依据，不修改文件；需要改动时在结论里说明建议。
```

（上面是示意结构。preset 的声明方式以你所用版本的官方文档为准 —— 关键是：**一段人设 = 一个 persona 行 = 一个 preset**。preset 是"一套插件组合"，人设只是其中之一。）

**为什么不能保留 `persona`**：不是本插件懒，而是 0.2.1 的启动请求类型里已经没有这个字段了；继续接受它只会得到一个"写进去但不生效"的静默失败，比报错更糟。

### 2. `[tools] allow/deny` → 没有等价字段，只能用 preset 选工具集

```toml
# 0.3.x
[tools]
deny = ["write", "edit"]
```

```toml
# 0.4.0：没有对应写法
agent_preset = "reviewer"      # 让那个 preset 只挂读工具
```

官方在 0.2.1 **没有**提供"按名字允许/拒绝某个子代理的工具"的替代字段（preset 选择的是**插件组合**，不是工具名列表）。所以"只读子代理"的做法变了：

> **一个工具集合一个 preset。** 想要"只读"，就做一个 `plugins` 里**只挂读类工具行**（`read`/`grep`/`glob`/…）、**不挂** `write`/`edit`/shell 行的 preset，然后让定义 `agent_preset` 指向它。

这条路径确实能得到只读子代理：preset 行自己挂载的工具**不受该行自己的 `tools.restrict()` 约束**，也就是说 preset 挂什么，子代理就能用什么 —— 加法在 preset 里做，而不是在定义里做减法。

**能迁移吗？** 分三种情况：

| 你原来的写法 | 0.4.0 怎么办 |
|---|---|
| 只 deny 了 `write`/`edit`（最常见的"只读"） | 建一个只挂读工具的 preset，定义里 `agent_preset` 指过去。**可以完全等价** |
| deny 了一长串具体工具名，且要按部署微调 | 只能靠 preset 的工具组合近似。**无法逐名字表达** |
| allow 白名单 | 同上：preset 里只挂白名单里的工具，多余的不挂 |

## 二、新增字段：`agent_preset`

```toml
name = "reviewer"
description = "只读代码审查：只报告问题与依据，不修改任何文件。"
provider = "spawn"
agent_preset = "reviewer"
max_depth = 1
```

生效需要**三个条件同时成立**，缺一都会在委派时报明确原因：

| 条件 | 检查时机 | 不满足时的报错 |
|---|---|---|
| provider 具备 `agentPreset` 能力 | 调用期 | `independent agent preset selection is unsupported by this provider`（`acp`/`codex`/`claude-code`/`dsh-sdk` 都没有） |
| provider **不继承父上下文** | 调用期 | 同上（`fork` 继承，因此不能选独立 preset；`spawn` 可以） |
| 该 profile 挂载了 `agent-presets` 服务 | 调用期（并在**加载期**记一条 `info`） | `sets agent_preset = "x", but this composition mounts no agent-presets service; the packaged web bundle mounts it and the headless bundle does not` |
| 该 id 确实已声明 | 调用期 | `names agent preset "x", which is not registered; available agent presets: a, b` |

**headless 组合默认没有 preset 服务**（`base`/`headless`/`acp-app`/`sdk-app` 都不挂，只有 web-app 挂）。要在 headless profile 里用 `agent_preset`，得自己把那行加进 profile 补丁。不加也没关系：插件会在加载时记一条 `info` 说明这件事，而不是等到第一次委派才失败。

## 三、升级后会发生什么（按真实行为逐条）

1. **含 `persona` 或 `[tools]` 的文件被判失败**，时机是**下一次读盘**：插件激活时，或下一次委派前的重装。失败原因是**定向迁移文案**，例如：

   ```
   persona was removed in 0.4.0: the Harness dropped per-child persona in 0.2.1, so a child's persona
   now comes from an Agent Preset — write agent_preset = "<preset id>" instead, and declare the persona
   there (see guide/migrating-to-0.4.md)
   ```

2. **插件照常加载，其它定义不受影响。** 失败只落在那个文件上（这是本插件一贯的失败隔离）。
3. **日志里是一行 `warn`**：`dsh-agents-toml: <file>: <原因>`（同一文件 + 同一原因只报一次）。
4. **还有别的可用定义时**，工具描述会多一句 `Unavailable definitions: <name> (<原因>)`；模型硬点那个名字会得到 `subagent "<name>" is unavailable: <原因> (<file>)`。
5. **如果那是你唯一的定义，`subagent_custom` 工具会整体消失**（没有可用定义时插件不注册工具）。此时**唯一的信号就是那条日志 warn** —— 现象是"工具不见了、`agent_type` 也没了"，很容易误判成插件坏了。升级前请先按本文改好定义，或升级后第一时间看日志。
6. **`persona` 与 `agent_preset` 同写时仍然判失败。** 迁移动作是**删掉旧的那一行**，不是两者并存 —— 否则"我明明写了新的"会变成新的困惑来源。

## 四、逐字段改写对照（用 `guide/reviewer.toml` 举例）

**升级前（0.3.x）**

```toml
name = "reviewer"
description = "只读代码审查：只报告问题与依据，不修改任何文件，不再向下委派。"
enabled = true
mode = "one-shot"
provider = "spawn"

persona = """
你是资深代码审查者。只报告问题与依据，不修改文件；需要改动时在结论里说明建议。
"""

max_depth = 1
output_schema = { type = "object", properties = { summary = { type = "string" } }, required = ["summary"] }

[tools]
deny = ["write", "edit"]
```

**升级后（0.4.0）**

```toml
name = "reviewer"
description = "只读代码审查：只报告问题与依据，不修改任何文件，不再向下委派。"
enabled = true
mode = "one-shot"
provider = "spawn"
agent_preset = "reviewer"       # ← persona 与 [tools] 的落点

max_depth = 1
output_schema = { type = "object", properties = { summary = { type = "string" } }, required = ["summary"] }
```

配套的 preset（示意）：

```yaml
- id: agent-presets
  config:
    presets:
      reviewer:
        name: 只读代码审查
        plugins:
          - id: persona
            module: '@deepseek-ai/dsh-persona'
            config:
              prefix: |
                你是资深代码审查者。只报告问题与依据，不修改文件；需要改动时在结论里说明建议。
          # 只挂读类工具行；不挂 write / edit / shell —— 这就是"只读"
```

**要点的三条**：

- **人设随 preset 走**：`continuable` 定义要求"结论写在收尾消息里"这句话，现在写在 preset 的 persona 里，不再写在定义里；
- **`output_schema` 与 preset 无关**，它是本插件自己的字段，照旧只配 `one-shot`；
- **`agent_preset` 与 `max_depth`/模型路由可以同时用**，它们不冲突（前者是子代理的组成，后者是本插件对启动请求的设置）。

## 五、要不要升级？

| 你的情况 | 建议 |
|---|---|
| 已在 `dsh-v0.2.1-rc.2` 或更新 | **必须**用 0.4.0：0.3.4 调用的 `start()` / `startContinuable()` 已被删除，任何委派都会失败 |
| 还在 `dsh-v0.2.0-rc.2` | 留在 0.3.4；等 DSH 升级后再升 0.4.0。0.4.0 也装不上（会被拒绝） |
| 定义里用了 `persona` 或 `[tools]` | 先按本文改写，再升级。否则升级那一刻定义就失效，唯一信号是日志 |

升级 DSH 本身之后，建议对新装的那棵树跑一次声明检查（它核对的是**已编译产物**的字面量）：

```sh
DSH_SHAPE_ROOT=<新安装>/node_modules/@deepseek-ai npm run check:harness
```

## 相关文档

- 字段参考与能力位表：[`README.md` · TOML 字段参考](../README.md#toml-字段参考)
- 版本对应与声明方式：[`README.md` · 支持的 Harness 版本](../README.md#支持的-harness-版本)
- 内部判定顺序、报错原文、宿主契约：[`technical.md`](technical.md)
- 逐键注释的两个示例：[`explorer.toml`](explorer.toml)、[`reviewer.toml`](reviewer.toml)
- 设置开关的场景讲解与排障对照表：[`settings-explained.md`](settings-explained.md)
