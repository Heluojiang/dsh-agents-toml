# 配置开关说明（配合场景理解）

本插件在插件页上的四个控件分别做什么。配套的定义示例在本目录：
[`explorer.toml`](explorer.toml)（轻量探索、可继续）、[`reviewer.toml`](reviewer.toml)（只读审查、拒绝写入）。

## 先分清一条界线：安装时 vs 调用时

| 阶段 | 何时发生 | 决定什么 | 受哪个开关影响 |
|---|---|---|---|
| **安装工具** | Agent（新任务/新会话）创建时；定义文件变化时（监听开着） | 模型**看到的**工具名、`agent_type` 取值列表、工具描述 | 工具名、监听定义目录、失败上报 |
| **调用工具** | 模型真的发起一次委派 | 委派能否成功、按哪个定义执行 | **不受任何开关影响**：每次都重读磁盘上的 TOML |

一句话：**定义能不能用，永远以"调用那一刻"的文件为准**；开关只决定模型"事先看到什么"。

## 一、信任项目级定义（`trustProjectAgents`）

- **作用**：是否加载 `<项目根>/.dsh/agents/*.toml`（随仓库分发的定义）。默认关。
- **例子**：你在仓库里放了 `.dsh/agents/reviewer.toml` 并提交。关着时，模型只看得到 `$DSH_HOME/agents` 里的定义，项目里那份不生效（Host 日志会记一行 "ignoring project definitions"）。打开后，工作目录在该仓库下的任务就能用 `agent_type = "reviewer"`，且**同名时项目定义覆盖用户级定义**。
- **为什么默认关**：这些文件跟着 `git clone` 一起来，等同于"仓库决定你能调用什么"。
- **注意**：项目根 = 会话工作目录向上最近的含 `.git` 目录。

## 二、工具名（`toolName`，默认 `subagent_custom`）

- **作用**：模型调用的那把**工具**叫什么。
- **关键区分**：模型一次委派里有两个名字，别混淆——

  ```json
  { "agent_type": "reviewer", "description": "审查 demo.js", "prompt": "..." }
  ```

  - **工具名**（本开关）= 上面这个调用走的工具，默认 `subagent_custom`；
  - **`agent_type`** = 委派给哪个定义（`reviewer` / `explorer`），由 TOML 的 `name` 决定，**不受本开关影响**。

  改成本开关为 `delegate_to_reviewer` 后，模型调用的就变成 `delegate_to_reviewer(agent_type = "reviewer")`，TOML 一个字都不用改。
- **例子 A（避冲突）**：另装了一个也注册 `subagent_custom` 的插件，Harness 会拒绝第二个注册：
  `tool "subagent_custom" is already registered in this scope`。改成 `project_subagent` 即可共存。
- **例子 B（让模型更好选）**：同一次请求里通常还有官方 `subagent`、`subagent_fork`；语义明确的名字能减少选错。
- **例子 C（审计）**：会话日志里 `tool/call` 记录的 name 就是这个值，不同 profile 用不同名字便于一眼区分。
- **生效时机**：下一次安装（新任务/新会话）；已在跑的会话沿用旧名字直到该 Agent 重装。

## 三、监听定义目录（`watchDefinitions`，默认开）

- **作用**：定义文件变化后，是否立刻重装工具 → 刷新**模型看到的** `agent_type` 列表与工具描述。
- **例子（开着）**：长会话进行到一半，你把 `reviewer.toml` 复制成 `security-audit.toml` 并改好内容。约 200ms 后清单刷新，下一次模型请求里 `agent_type` 已含 `security-audit`，你可以直接说"委派给 security-audit"。
- **例子（关掉）**：同样改动，模型手里的列表**还是旧的**，它很可能回答"没有这个子代理"。但**调用期是真读文件的**：你明确指名（或让它试一次）依然能成功，只是它事先不知道。
- **关掉的好处**：不再打开文件监听（少几个句柄）。定义目录在网络盘/超大目录上时更稳妥；只在两次会话之间改定义的人，关掉完全够用。
- **建议**：会话里边改边用 → 保持打开；改动只发生在部署阶段 → 可以关。

## 四、在工具描述里列出不可用定义（`reportFailuresToModel`，默认开）

- **作用**：把**失败的定义及原因**写进工具描述，让模型知道"哪些定义被跳过了、为什么"。失败本身永远不影响其他定义。
- **例子（开着）**：把 `reviewer.toml` 的 `max_depth = 1` 误改成 `0`（或把 `[tools] deny` 里写成不存在的工具名）。该定义被跳过，其余照常，工具描述里会多出：

  ```
  Unavailable definitions: reviewer (max_depth must be at least 1).
  ```

  于是你问"为什么用不了 reviewer？"，模型能直接讲出真实原因。
- **例子（关掉）**：描述里只有 `Configured subagents: explorer, gui-reviewer.` → 模型多半回答"没有 reviewer 这个子代理"，真正原因只留在 Host 日志（`logger.warn`，运维视角）。
- **不受本开关影响的部分**：真去调用一个失败定义时，错误信息照样带原因与文件名：

  ```
  subagent "reviewer" is unavailable: max_depth must be at least 1 (…\.dsh\agents\reviewer.toml)
  ```

  本开关只影响"事前告知"。
- **代价**：工具描述随每次模型请求发送；失败条目多、理由长时会持续占 token。

## 组合场景

你在长会话中新增 `.dsh/agents/security-audit.toml`，但里面把 `[tools] deny` 写成了不存在的工具名：

| 配置 | 现象 |
|---|---|
| 监听开 + 失败上报开 | 约 200ms 后描述刷新；`security-audit` 因失败**不在** `agent_type` 列表里，但描述带着原因 → 你一问，模型说得出"deny 里的名字不存在" |
| 监听开 + 失败上报关 | 描述刷新了，但**只有**可用名单；模型不知道 security-audit 的存在与原因，你得自己看日志 |
| 监听关 | 模型手里的清单仍是会话开始时的样子，要等新任务才刷新（调用期依然读最新文件） |
| 两个都关 | 完全静默：模型看到的与磁盘可能长期不一致 |

## 该动哪一项？速查

| 你的情况 | 建议动作 |
|---|---|
| 想让某个仓库里的定义生效 | 打开**信任项目级定义** |
| 与别的插件重名报 "already registered" | 改**工具名** |
| 同时装着官方 `subagent`，模型选错工具 | 把**工具名**改成语义明确的（如 `delegate_to_reviewer`） |
| 会话里边加/改定义边用 | 保持**监听定义目录**打开 |
| 定义目录在网络盘、或只在部署时固定 | 关掉**监听定义目录** |
| 失败定义很多、理由很长，想省 token | 关掉**在工具描述里列出不可用定义**（原因仍写入 Host 日志） |
| 希望模型能解释"某个子代理为什么不可用" | 保持**失败上报**打开 |

## 相关文档

- 安装与开启步骤：[`README.md`](../README.md)
- 技术文档（机制、校验规则、能力位、限制）：[`technical.md`](technical.md)
- 定义文件字段参考：[`README.md` · TOML 字段参考](../README.md#toml-字段参考)
- 逐键注释的完整示例：[`explorer.toml`](explorer.toml)、[`reviewer.toml`](reviewer.toml)
