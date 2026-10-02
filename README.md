# dsh-agents-toml

用 TOML 文件给 DeepSeek Harness 声明**具名子代理**的插件。它不修改 DSH 源码，作为普通 bundle 通过 `dsh plugin add` 安装。

- **一个工具 + `agent_type` 参数**：模型只看到 `subagent_custom`（名字可配）这一个委派工具，用 `agent_type` 选择委派给谁，而不是每个定义多一份工具 schema。
- **两层目录**：`$DSH_HOME/agents/*.toml`（全局，始终加载）与 `<projectRoot>/.dsh/agents/*.toml`（项目级，**默认关闭**，需显式信任）。同名时项目定义覆盖全局定义。
- **失败互不牵连**：某个定义写错或用了当前 provider 不支持的能力时，只有该定义不可用（日志 + 工具描述说明原因），其余照常，且**绝不会导致 Agent 创建失败**。
- **热生效**：定义文件在每次委派时重新读取；目录 watcher 让模型看到的 `agent_type` 列表同步刷新。

**文档导航**：[安装](#安装) · [插件设置项](#插件设置项) · [用自然语言创建定义](#用自然语言创建定义内置-skill) · [插件行配置](#插件行配置通常无需手改) · [TOML 字段参考](#toml-字段参考) · [示例定义](guide/explorer.toml) · [技术文档](guide/technical.md) · [开关场景讲解](guide/settings-explained.md)

## 安装

### 本地目录（开发/试用）

```sh
dsh plugin --profile web add D:\Work\Codes\Others\dsh-agents-toml
```

### npm（发布后）

```sh
dsh plugin --profile web add dsh-agents-toml
```

> `package.json` 里保留了 `private: true`（开发态防误发布）。要发布到 npm，删掉该字段后 `npm publish`；`prepare` 脚本会先构建（宿主 + 客户端两个面）。

安装后，**web profile 会自动加载本插件的客户端半边**（`dsh.client` 清单 + `./client` 导出，产物 `lib/client.js`），无需额外步骤；`headless` / `sdk` / `acp` 等没有 GUI 的 profile 会忽略它。

### GitHub

```sh
dsh plugin --profile web add github:<you>/dsh-agents-toml
```

git 安装拿到的是源码，包内自带 `prepare` 脚本。pnpm ≥10 默认拦截依赖的构建脚本，第一次 `add` 会失败并打印放行所需的**完整 key**：

```
ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED  The git-hosted package "dsh-agents-toml@<版本>" needs to execute build scripts but is not in the "allowBuilds" allowlist.
allowBuilds:
  dsh-agents-toml@https://codeload.github.com/<you>/dsh-agents-toml/tar.gz/<sha>: true
```

把 **`allowBuilds:` 下面那一整行**追加到 `$DSH_HOME/profiles/<profile>/pnpm-workspace.yaml`（该文件已存在，**追加，不要覆盖**），然后重跑 `add`。两个坑：只写裸包名 `dsh-agents-toml: true` **不足以**放行（pnpm 按完整 spec 匹配）；key 里的 SHA 随提交变化，更新到新提交后要把新打印的 key 也加进去。

**放行构建脚本等于允许该包以你的权限执行代码**：只放行你信任的仓库，并用 `github:<you>/dsh-agents-toml#<sha>` 固定提交。

### 不改 profile 的临时试用

用 `--patch` 覆盖层，行名写成**绝对路径**（裸包名只在已安装到 profile 时才能解析）：

```yaml
# dev.patch.yml
- insert:
    - id: dsh-agents-toml
      name: 'D:/Work/Codes/Others/dsh-agents-toml/lib/index.js'
```

```sh
dsh web --patch ./dev.patch.yml
```

### 生效时机（是否需要重启）

| 动作 | 开启 HMR 的 profile（`web` 默认） | 关闭 HMR 的 profile（`headless` / `sdk` / `acp` / `sdk-minimal`） |
|---|---|---|
| 安装/卸载本插件 bundle | 不需要重启（DSH 监听 profile 的 `package.json` 与 patch 文件） | 需要重启 |
| 新增/修改 `*.toml` 定义 | 不需要重启（下次调用即生效；watcher 刷新工具 schema） | 同左 |
| 在**插件设置项**里改配置 | 不需要重启：volatile 引用原地更新，下一次委派即生效（仅 `agent_type` 列表要等下一次安装） | 不适用（无 GUI） |
| 手改 `cordis.patch.yml` | 不需要重启（补丁文件被监听，该行重载） | 需要重启 |
| 升级本插件版本（含客户端半边） | Host 模块不热替换，建议重启；刷新浏览器会重新拉取 `lib/client.js` | 需要重启 |

## 插件设置项

安装后在插件页里可以看到本插件**自己的配置区**：打开「插件」→「已安装」→ 点击 `dsh-agents-toml`。

| 设置项 | 配置键 | 作用（一句话） |
|---|---|---|
| 信任项目级定义 | `trustProjectAgents` | 是否加载 `<项目根>/.dsh/agents/*.toml`（安全开关，默认关） |
| 工具名 | `toolName` | 模型调用的**那把工具**叫什么（默认 `subagent_custom`） |
| 监听定义目录 | `watchDefinitions` | 定义文件变化后是否立刻刷新模型看到的 `agent_type` 列表 |
| 在工具描述里列出不可用定义 | `reportFailuresToModel` | 是否把失败定义及原因写给模型看 |

每个开关的具体场景（含"开着/关掉分别是什么现象"、以及"模型看到什么"与"调用时读什么"的区别）见 **[guide/settings-explained.md](guide/settings-explained.md)**。保存会写入当前 profile 的 Cordis 补丁，**无需重启**。

> 注意区分两个名字：**工具名**是模型调用的工具（`subagent_custom`）；**`agent_type`** 是委派给哪个定义（`reviewer`、`explorer`，由 TOML 的 `name` 决定）。改工具名不需要动任何 TOML。

### 开启项目级子代理

项目级定义默认关闭，因为 `<projectRoot>/.dsh/agents/*.toml` 会随 `git clone` 一起到来（忽略时日志会记一行说明）。

**方式一（推荐）**：上面的设置项里打开「信任项目级定义」。

**方式二（无 GUI / 脚本化）**：把下面这段追加到 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`。脚本是幂等的，并会处理"补丁还是默认空序列 `[]`"的情况：

```powershell
$profileName = 'web'                                                    # 你的 profile 名
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$patch    = Join-Path $dshHome "profiles\$profileName\cordis.patch.yml"
$manifest = Join-Path $dshHome "profiles\$profileName\package.json"
$block = @(
  ''
  '# 允许 <projectRoot>/.dsh/agents/*.toml 的定义（dsh-agents-toml）'
  '- id: dsh-agents-toml'
  '  config:'
  '    trustProjectAgents: true'
)

if (-not (Test-Path $manifest)) {
  "profile 不存在：$manifest —— 先用 dsh --profile $profileName ... 初始化它"
} elseif (-not ((Get-Content $manifest -Raw | ConvertFrom-Json).dsh.profile.bundles -contains 'dsh-agents-toml')) {
  "该 profile 还没安装本插件，先运行：dsh plugin --profile $profileName add github:<you>/dsh-agents-toml"
} elseif ((Get-Content $patch -Raw) -match 'trustProjectAgents') {
  "已存在 trustProjectAgents 配置，未修改：$patch"
} else {
  $lines = @(Get-Content $patch)
  $code = @($lines | Where-Object { $_.Trim() -ne '' -and -not $_.TrimStart().StartsWith('#') })
  if ($code.Count -eq 1 -and $code[0].Trim() -eq '[]') {
    # 默认补丁就是一个流式空序列 []，必须替换它：在它后面追加块序列会让 YAML 解析失败
    Set-Content -Path $patch -Encoding utf8 -Value (@($lines | Where-Object { $_.Trim() -ne '[]' }) + $block)
  } else {
    Add-Content -Path $patch -Encoding utf8 -Value $block
  }
  "已写入 $patch"
}
```

验证与其余方式（`--patch` 临时启用、让 agent 代改）见 [技术文档 · 插件行配置](guide/technical.md#3-插件行配置)。

## 用自然语言创建定义（内置 Skill）

装完插件后，会话的**技能目录**里会多出一条本插件自带的技能 `dsh-agents-toml`。你不需要记字段，直接说需求即可：

> 帮我加一个只读的 SQL 审查子代理，不许改文件。
>
> 再给我一个便宜的探索助手，能反复追问的那种。

模型会加载该技能，然后：

1. **问清三件事**：用途与边界、能不能改文件/跑命令、定义放在哪个目录；
2. **按规范写文件**：把它写到 `$DSH_HOME/agents/`（默认，始终加载），或在你明确要求"随仓库分发"时写到 `<项目根>/.dsh/agents/`；
3. **提醒你信任开关**：写入项目目录时它会告诉你，需要先在插件设置里打开「信任项目级定义」，否则该文件不会加载；
4. **告诉你结果**：定义的 `name` 就是调用时的 `agent_type`，写完**下一次委派即生效**（模型看到的列表在下一次安装刷新）。

技能正文里带着字段规范与常见坑（`max_depth = 0` 必然失败、`output_schema` 只能配 `one-shot`、`[tools]` 工具名是部署相关的、哪些 provider 支持模型路由/persona），所以模型不需要你解释这些；需要更深的细节时它会读包内的 `guide/technical.md` 与 `guide/*.toml` 模板。

**边界**：技能是**指令**而不是强制——模型仍然需要 `write` 权限才能落盘；如果某个精简组合没有挂载技能服务，插件照常工作，只是没有这条技能。技能与实现的细节见 [技术文档 · 内置 Skill](guide/technical.md#17-内置-skill)。

## 插件行配置（通常无需手改）

本插件的 bundle 自带 `cordis.patch.yml`，**安装时已经自动插入了这一行**；它的 7 个配置键**全部有默认值**，所以：

- **一个键都不写也能正常工作**——`config` 整段可以完全不存在；
- 需要改时，优先用上面的**插件设置项**（4 个键有 UI，保存会替你写进 profile 补丁）；
- 另外 3 个键是"部署布局"，没有 UI，需要时手写进 `$DSH_HOME/profiles/<profile>/cordis.patch.yml`。

| 键 | 默认值 | 作用 | 有设置项？ |
|---|---|---|---|
| `trustProjectAgents` | `false` | 是否加载项目目录的定义 | ✅ |
| `toolName` | `subagent_custom` | 模型看到的工具名 | ✅ |
| `watchDefinitions` | `true` | 定义目录变化后重装工具、刷新 `agent_type` 列表 | ✅ |
| `reportFailuresToModel` | `true` | 在工具描述里列出不可用定义及原因 | ✅ |
| `defaultProvider` | `spawn` | 定义未写 `provider` 时使用的传输 | ❌ 手改 |
| `projectAgentsDir` | `.dsh/agents` | 项目内的相对目录 | ❌ 手改 |
| `userAgentsDir` | 未设置（`$DSH_HOME/agents`） | 覆盖用户级定义目录（绝对路径） | ❌ 手改 |

手改时的完整写法（patch 是整段替换 `config`，但没写的键会由 schema 默认值补齐，所以只写要改的项即可）：

```yaml
- id: dsh-agents-toml
  config:
    trustProjectAgents: true          # 打开项目级定义
    defaultProvider: spawn            # 例：部署级默认传输
    projectAgentsDir: .dsh/agents     # 例：项目内目录改名
    # userAgentsDir: 'D:/my/agents'   # 例：把用户目录放到别处
```

`$DSH_HOME` 解析：环境变量 `DSH_HOME`（去空白后非空）优先，否则 `~/.dsh`。

## TOML 完整示例

把文件放进 `$DSH_HOME/agents/`（或已信任的项目 `<项目根>/.dsh/agents/`），文件名随意，定义名由 `name` 决定。下面这份带全部键的注释说明，可直接作为模板：

```toml
name = "reviewer"                # 必填：agent_type 取值，须匹配 [A-Za-z0-9][A-Za-z0-9_-]{0,63}
description = "只读代码审查"      # 必填：模型据此选择该子代理（非空）

enabled = true                   # 可选，默认 true；false 时不出现在 agent_type 列表里
mode = "one-shot"                # 可选，默认 "one-shot"；"continuable" 会立即返回子代理 id
provider = "spawn"               # 可选，默认取插件行 defaultProvider（默认 spawn）

# 以下四项是"子代理走哪个模型"的路由覆盖，需要 provider 支持 agentOptions
llm_provider = "deepseek-official"   # 可选：子代理使用的 LLM provider
model = "deepseek-v4-flash"          # 可选：子代理使用的模型
reasoning_effort = "high"            # 可选：推理档位
max_tokens = 4096                    # 可选：正整数

persona = """                    # 可选：只作用于该子代理，遮蔽部署 persona
你是资深代码审查者，只报告问题与依据，不修改文件。
"""

max_depth = 1                    # 可选，默认取 Host 的 subagent.maxDepth（默认 1）；最小 1
output_schema = { type = "object", properties = { summary = { type = "string" } }, required = ["summary"] }
                                 # 可选：对象根 JSON Schema；只能配 mode = "one-shot"

[tools]                          # 可选：从提示词移除并拒绝执行这些工具（只能做减法）
deny = ["write", "edit"]         # 名字必须是本部署真实注册的工具
```

**完整可运行的两个例子**：[`guide/explorer.toml`](guide/explorer.toml)（`continuable` + 子代理模型路由）、[`guide/reviewer.toml`](guide/reviewer.toml)（`one-shot` + 工具限制）。两者都逐键标注了必填/可选与省略时的行为。

## TOML 字段参考

| 键 | 必填 | 类型 / 可选项 | 默认 | 作用与约束 |
|---|---|---|---|---|
| `name` | **是** | string，`[A-Za-z0-9][A-Za-z0-9_-]{0,63}` | — | `agent_type` 的取值。**同一目录内重名 → 两个定义都失败**；跨目录同名时项目覆盖用户 |
| `description` | **是** | 非空 string | — | 模型选择该子代理的依据 |
| `enabled` | 否 | `true` / `false` | `true` | `false`：不进 `agent_type` 列表与工具描述；显式调用报 `subagent "x" is disabled in <file>` |
| `mode` | 否 | `"one-shot"` / `"continuable"` | `"one-shot"` | `one-shot`：等待子代理完成并返回文本；`continuable`：立即返回 `started subagent <childId>`，可用 `send_message` 继续 |
| `provider` | 否 | 已注册的传输名（随 profile 而定，如 `spawn`/`fork`/`acp`/`codex`/`claude-code`/`dsh-sdk`） | 插件行 `defaultProvider`（`spawn`） | 未注册时调用报错并列出已注册的 provider 名 |
| `llm_provider` | 否 | string | 不覆盖（继承父级路由） | 子代理的 LLM 路由 provider；需要 `agentOptions` |
| `model` | 否 | string | 同上 | 子代理使用的模型；需要 `agentOptions` |
| `reasoning_effort` | 否 | string | 同上 | 推理档位；需要 `agentOptions` |
| `max_tokens` | 否 | 正整数 | 同上 | 生成长度上限；需要 `agentOptions` |
| `persona` | 否 | 非空 string（多行用 `"""`） | 部署 persona | 只作用于该子代理；需要 `persona` |
| `max_depth` | 否 | 整数 ≥ 1 | Host `subagent.maxDepth`（默认 1） | 本定义创建出的子代理的**绝对深度**上限；需要 `depthLimit` |
| `output_schema` | 否 | TOML 表（对象根 JSON Schema） | — | 子代理返回结构化结果；需要 `outputSchema`，**且只能配 `one-shot`** |
| `tools` | 否 | 表，子键 `allow` / `deny`（非空字符串数组） | 不限制 | 从子代理提示词移除**且**拒绝执行；需要 `toolFilter`。名字必须是本部署真实注册的工具 |

键名允许用 `-` 代替 `_`（`llm-provider` ≡ `llm_provider`、`max-depth` ≡ `max_depth`）。**未知键与类型错误一律报错**，不会被静默忽略。

### 生效条件（能力位）

| 字段 | 需要的 provider 能力 | 支持的 provider |
|---|---|---|
| `llm_provider` / `model` / `reasoning_effort` / `max_tokens` | `agentOptions` | `spawn`、`fork`、`dsh-sdk` |
| `persona` | `persona` | `spawn`、`fork` |
| `tools.allow` / `tools.deny` | `toolFilter` | `spawn`、`fork` |
| `max_depth` | `depthLimit` | `spawn`、`fork` |
| `output_schema` | `outputSchema` | `spawn`、`fork`（且仅 `one-shot`） |
| `mode = "continuable"` | `prepareContinuable` | `spawn`、`fork` |

`acp` / `codex` / `claude-code` 不声明任何启动能力，因此把上述字段用在它们身上会让**该定义**失败。两类失败的时机不同，别混淆：

- **解析期失败（文件写错）**：必填缺失、类型错误、未知键、`max_depth = 0`、`[tools]` 出现非 `allow`/`deny` 的键 —— 定义直接判失败并给出原因。
- **调用期失败（能力不匹配）**：provider 是否具备某项能力只有在委派那一刻才能确定，因此报错形如
  `subagent "x" cannot run on provider "codex": child LLM routing is unsupported by this provider`。

### `max_depth` 的语义

它约束的是**本定义创建出来的子代理**的绝对深度（父级为 0，直接子代理为 1），而不是"这个子代理还能不能再往下委派"：

- `max_depth = 1`（推荐）：允许本次委派；子代理若再想委派，其深度 2 > 1 会被拒绝 —— 这才是"它不能再往下委派"。
- `max_depth = 0` **永远无法成立**（子代理深度至少为 1），因此本插件在解析阶段就判该定义失败并说明原因，而不是让模型在运行时撞到 `subagent depth 1 exceeds maxDepth 0`。

### `[tools]` 里的名字是部署相关的

`tools.allow` / `tools.deny` 的名字必须来自**该部署实际注册的工具**：Windows headless profile 只有 `pwsh`，web profile 还可能有 `bash`/`terminal`，其他平台是 `bash`。写错不会静默忽略，而是在委派时明确报错并列出已知工具名：

```
Error: tools.restrict() names unknown global tools "bash", "terminal";
known global tools: create_goal, edit, …, pwsh, read, write
```

所以示例只 deny 每个部署都有的 `write`/`edit`，shell 工具的 deny 行以注释保留，按你的部署取消注释。

### 不能配置的项

- **权限预设 / 沙箱 / 审批策略**：由父会话快照继承，"只读子代理"只能用 `[tools] deny` 近似（并一并 deny shell 类工具）。
- **provider 实例级设置**（如 `claude-code` 的 `permissionMode`、`acp` 的 `command/args/env`）：属于 profile 里的插件行，定义只能按名选择已注册的 provider。
- **子代理工作目录**：继承父会话 cwd。
- **新增工具**：`[tools]` 只能做减法。
- **`run_in_background`**：未暴露；后台语义由 `mode` 决定。

完整清单与原因见 [技术文档 · 不支持的能力](guide/technical.md#11-明确不支持的能力)。

## 失败可见性

1. 日志：每个失败文件一行 `dsh-agents-toml: <file>: <原因>`（同一文件 + 原因只报一次）。
2. 工具描述：列出不可用定义及原因（可关，见设置项）。
3. 调用报错：名字不存在 → 列出当前可用名字；命中失败定义 → 给出原因与文件路径。
4. 任何定义问题**都不会导致 Agent 创建失败**。

## 文档

| 文档 | 内容 |
|---|---|
| [`guide/technical.md`](guide/technical.md) | 技术文档：实现结构、插件行配置语义、解析与校验规则、能力位规则与报错、生命周期、热更新、客户端半边、真机验证结论、开发与测试、限制 |
| [`guide/settings-explained.md`](guide/settings-explained.md) | 四个设置项的场景讲解 |
| [`guide/explorer.toml`](guide/explorer.toml) / [`guide/reviewer.toml`](guide/reviewer.toml) | 逐键注释的完整示例 |

## 开发与测试

```sh
npm install
npm run check     # 两个编译面类型检查 + 文档链接检查 + 单测
npm run build     # 产出 lib/*.js、lib/types/*.d.ts 与 lib/client.js
```

测试完全不依赖 DSH 安装，也不读写真实 `$DSH_HOME`。细节与覆盖范围见 [技术文档 · 测试](guide/technical.md#13-测试与构建)。
