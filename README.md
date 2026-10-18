# dsh-agents-toml

用 TOML 文件给 DeepSeek Harness 声明**具名子代理**的插件。它不修改 DSH 源码，作为普通 bundle 通过 `dsh plugin add` 安装。

- **一个工具 + `agent_type` 参数**：模型只看到 `subagent_custom`（名字可配）这一个委派工具，用 `agent_type` 选择委派给谁，而不是每个定义多一份工具 schema。
- **两层目录**：`$DSH_HOME/agents/*.toml`（全局，始终加载）与 `<projectRoot>/.dsh/agents/*.toml`（项目级，**默认关闭**，需显式信任）。同名时项目定义覆盖全局定义。
- **失败互不牵连**：某个定义写错或用了当前 provider 不支持的能力时，只有该定义不可用（日志 + 工具描述说明原因），其余照常，且**绝不会导致 Agent 创建失败**。
- **热生效**：定义文件在每次委派时重新读取；目录 watcher 让模型看到的 `agent_type` 列表同步刷新。

**文档导航**：[安装](#安装) · [支持的 Harness 版本](#支持的-harness-版本) · [不支持与智能体团队组合](#与智能体团队agent-teams不支持组合使用) · [插件设置项](#插件设置项) · [用自然语言创建定义](#用自然语言创建定义内置-skill) · [插件行配置](#插件行配置通常无需手改) · [TOML 字段参考](#toml-字段参考) · [常见误解](#常见误解) · [子代理的人设与工具集](#子代理的人设与工具集agent-preset040-起) · [DSH 升级时看这里](#边界与演进dsh-升级时看这里) · [示例定义](guide/explorer.toml) · [技术文档](guide/technical.md) · [0.4.0 升级说明](guide/migrating-to-0.4.md) · [开关场景讲解](guide/settings-explained.md)

## 安装

### 本地目录（开发/试用）

```sh
dsh plugin --profile web add <path-to-this-checkout>
```

### npm

```sh
dsh plugin --profile web add @heluojiang/dsh-agents-toml
```

> 包已发布到 npm（scoped 包 `publishConfig.access: public`，因此公开可装）。从 npm 装到的是**构建产物**（`lib/`、`assets/skill/`、`cordis.patch.yml`、文档）；`prepare` 在发布时已构建宿主与客户端两个面。

**npm 安装注意两件事：**

1. **刚发布的版本不会被立刻装上 —— 要装最新版就显式写版本号。** pnpm 11 默认启用"最小发布年龄"（`minimumReleaseAge`）：`dsh plugin add @heluojiang/dsh-agents-toml` 会解析到**上一个够老的版本**（实测：0.2.2 发布约 20 分钟后，裸包名装到的仍是 0.2.1），并把解析到的那个版本追加进 profile 的 `pnpm-workspace.yaml` → `minimumReleaseAgeExclude`。因此：
   - 立刻装最新版：**显式写版本**，例如 `dsh plugin --profile web add @heluojiang/dsh-agents-toml@0.2.2`；
   - 或等过了发布年龄窗口再装（那时裸包名自然取到最新）；
   - `minimumReleaseAgeExclude` 记的是"包@版本"，所以**每个新版本首次安装都要显式指定一次**。
2. **判断"是否发布成功"要看注册表，不要看网页。** npmjs.com 对不存在的包也会渲染一个页面，容易误判；权威判据是：

   ```sh
   npm view @heluojiang/dsh-agents-toml version      # 成功时输出最新已发布版本号
   curl -s -o /dev/null -w '%{http_code}\n' https://registry.npmjs.org/@heluojiang%2Fdsh-agents-toml   # 成功时 200
   ```

   另外 npm **不允许覆盖已发布版本**：改动后必须升版本（`npm version patch`）再 `npm publish`；直接重发同一版本会报 `You cannot publish over the previously published versions` —— 那说明该版本**早已发布成功**，不是失败。

安装后，**web profile 会自动加载本插件的客户端半边**（`dsh.client` 清单 + `./client` 导出，产物 `lib/client.js`），无需额外步骤；`headless` / `sdk` / `acp` 等没有 GUI 的 profile 会忽略它。

## 支持的 Harness 版本

| 插件版本 | 支持的 DSH |
|---|---|
| `v0.3.4` | `dsh-v0.2.0-rc.2` |
| `v0.4.0` | `dsh-v0.2.1-rc.2` 及以上 |

**升级到 0.4.0 之前请先读 [0.4.0 升级说明](guide/migrating-to-0.4.md)**：`persona` 与 `[tools]` 两个字段已被 DSH 0.2.1 移除，0.4.0 因此不再接受它们（沿用旧字段的文件会被判失败，并给出迁移提示）。字段对应关系、Agent Preset 的等价写法、以及"唯一一个定义失败会导致委派工具整体消失"这类现象都在那份文档里。

版本边界是**机器可读并强制执行**的：`package.json` 里同时声明了 `engines.dsh: ">=0.2.1-rc.2"` 与 `peerDependencies: {"@deepseek-ai/dsh": ">=0.2.1-rc.2"}`。

- 在 **DSH 0.2.1 及以后**：兼容性判定**只看** `engines.dsh`（peer 被忽略），不满足就拒绝安装并提示 `dsh plugin allow-version`。
- 在 **DSH 0.2.0-rc.2**（0.2.1 之前的运行时完全不读 `engines` 字段）：回落到读 `peerDependencies`，同样**拒绝安装** 0.4.0。这是刻意的：与其静默装上一个会在第一次委派时抛 `startActivation is not a function` 的包，不如在安装期就拒绝。
- `peerDependenciesMeta` 把该 peer 标成 `optional`，所以 npm/pnpm 不会试图去安装 `@deepseek-ai/dsh` 本体；DSH 自己的兼容性判定**不读** `peerDependenciesMeta`，因此拒绝仍然发生。

### GitHub

```sh
dsh plugin --profile web add github:Heluojiang/dsh-agents-toml
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
      name: '/absolute/path/to/dsh-agents-toml/lib/index.js'
```

```sh
dsh web --patch ./dev.patch.yml
```

### 生效时机（是否需要重启）

| 动作 | 开启 HMR 的 profile（`web` 默认） | 关闭 HMR 的 profile（`headless` / `sdk` / `acp` / `sdk-minimal`） |
|---|---|---|
| 安装/卸载本插件 bundle | 不需要重启（DSH 监听 profile 的 `package.json` 与 patch 文件） | 需要重启 |
| 新增/修改 `*.toml` 定义 | 不需要重启：每次委派都重读文件，**下一个模型请求**就能用新定义（监听开着时 `agent_type` 列表也在此时刷新） | 同左 |
| 在**插件设置项**里改配置 | 不需要重启：四个键保存后**立即**作用于运行中的会话，见下表 | 不适用（无 GUI） |
| 手改 `cordis.patch.yml` | 不需要重启（补丁文件被监听，该行重载） | 需要重启 |
| 升级本插件版本（含客户端半边） | Host 模块不热替换，建议重启；刷新浏览器会重新拉取 `lib/client.js` | 需要重启 |

四个设置项各自的生效方式（这是最容易误判的一处）：

| 设置项 | 写入后什么时候生效 |
|---|---|
| 信任项目级定义 `trustProjectAgents` | **立即**：重新安装每个运行中 Agent 的工具，`agent_type` 列表当场更新，新出现的目录也当场开始监听 |
| 监听定义目录 `watchDefinitions` | 立即：关掉会**关闭已打开的目录监听**，打开会马上重新打开 |
| 工具名 `toolName` | **立即**：每个运行中 Agent 用新名字重新注册（旧注册先释放） |
| 列出不可用定义 `reportFailuresToModel` | **立即**：工具描述重新生成 |

> 换句话说：四项都在保存后**立即**作用于运行中的会话，不需要重启、不需要新会话。保存本身会写入 profile 补丁，因此改动不会丢；**刷新浏览器不影响其中任何一项**（工具表是 Host 侧按 Agent 安装的，浏览器只影响界面）。
>
> 技术细节：只改这四个开关时，Loader 不会重挂本插件行，而是原地更新取值并通知插件（`loader/volatile-update`）。本插件收到通知后对每个运行中 Agent 重新执行一次"发现 + 安装"——因为四项都改变已安装工具的内容（列表、名字、描述），只更新 watcher 不足以让运行中的会话看到。代价是保存设置时每个 Agent 的工具会被替换一次，这与"改一个 `.toml` 文件"走的是同一条路径。

## 与智能体团队（Agent Teams）不支持组合使用

**本插件按"具名子代理"设计，与官方的「智能体团队」组合包不支持组合使用。请先在「插件 → 官方 → 智能体团队」把它关掉，再使用本插件。**

官方对该组合包的说明就是它的设计意图：*Ordinary subagent delegation and overlapping global child controls are disabled*（`@deepseek-ai/dsh-experimental-agent-team-profile` 的 README）。其 `cordis.patch.yml` 会禁用四行——`tool-subagent-control`、`tool-subagent-list-agents`、`tool-subagent`、`tool-subagent-fork`——并改挂 `tool-agent-team`。于是：

| 影响 | 具体表现 |
|---|---|
| **continuable 子代理无法主动追问** | 续聊只能靠官方 `dsh-tool-subagent-control` 的 `send_message(agent_id)`；它被禁用后，拿子代理 id 去调同名工具只会得到 `active teammate "<id>" not found`。（子代理**收尾的最终文本仍会回传**：那条结算通知由 `dsh-subagent` 的续接管理器发出，团队组合包只禁用四个工具行，不触及它） |
| **同名工具不同含义** | 团队工具的 `send_message` 参数是 `target`（队友）、`list_agents` 列的是队友；拿子代理 id 去调只会得到 `active teammate "<id>" not found`，模型与人都容易误用 |
| **官方委派工具消失** | 官方 `subagent` / `subagent_fork`（标准预设里默认 `backgroundMode: continuable`）被换成队友工具 —— 这不是本插件的工具，但会改变模型的默认选择 |
| **模型可能不再选你的定义** | 两套工具同处一个作用域，多智能体任务上模型可能优先用团队工具 |

**仍然照常工作**：`agent_type` 委派、TOML 解析与全部校验、能力位判定、`max_depth`、`agent_preset`、`output_schema`、设置页四个开关、内置 Skill、定义热更新 —— 这些都不经过团队工具。

**自查与关闭**：

- 会话工具列表里出现 `spawn_teammate`，即团队已启用；
- **关闭团队**：插件页「官方」栏关掉「智能体团队」的开关（等价于把它从 profile 的 `dsh.profile.bundles` 移除），或 `dsh plugin --profile <profile> remove @deepseek-ai/dsh-experimental-agent-team-profile`；
- 本插件的**设置页会自动检测**：一旦发现团队已启用，就在配置区顶部显示红色提示，建议你去关掉团队。**这个提示框本身可以关闭**（右上角 `×`）：关掉后不再显示，浏览器里记住该选择，等团队真的关闭后再启用时会重新提示。
- **提示只做提醒：本插件不会替你关闭团队**，也不会改动你的 profile —— 关闭动作始终由你在插件页执行（上一条）。

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
} elseif (-not ((Get-Content $manifest -Raw | ConvertFrom-Json).dsh.profile.bundles -contains '@heluojiang/dsh-agents-toml')) {
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
4. **告诉你结果**：定义的 `name` 就是调用时的 `agent_type`，写完**下一次委派即生效**（模型看到的列表在下一次安装或设置写入时刷新）。

技能正文里带着字段规范与常见坑（`max_depth = 0` 必然失败、`output_schema` 只能配 `one-shot`、`persona` 与 `[tools]` 已在 0.4.0 移除并改用 `agent_preset`、`agent_preset` 需要 profile 挂载 preset 服务且 `fork` 不支持、哪些 provider 支持模型路由），所以模型不需要你解释这些；需要更深的细节时它会读包内的 `guide/technical.md`、`guide/migrating-to-0.4.md` 与 `guide/*.toml` 模板。

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
| `userAgentsDir` | 未设置（`$DSH_HOME/agents`） | 覆盖用户级定义目录（绝对路径）；**仅在该行加载时读取**，改后要重载该行 | ❌ 手改 |

手改时的完整写法（patch 是整段替换 `config`，但没写的键会由 schema 默认值补齐，所以只写要改的项即可）：

```yaml
- id: dsh-agents-toml
  config:
    trustProjectAgents: true          # 打开项目级定义
    defaultProvider: spawn            # 例：部署级默认传输
    projectAgentsDir: .dsh/agents     # 例：项目内目录改名
    # userAgentsDir: 'D:/my/agents'   # 例：把用户目录放到别处
```

`$DSH_HOME` 解析与 Harness 一致：环境变量 `DSH_HOME`（去空白后非空）优先，否则 `~/.dsh`；开头的 `~`、`~/`、`~\` 按操作系统主目录展开，最终解析为绝对路径。

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

agent_preset = "reviewer"        # 可选：让子代理整体套用一个 Agent Preset
                                 # 它的人设（preset 里的 @deepseek-ai/dsh-persona 行）与
                                 # 工具集（preset 挂哪些工具插件行）都由该 preset 决定

max_depth = 1                    # 可选，默认取 Host 的 subagent.maxDepth（默认 1）；最小 1
output_schema = { type = "object", properties = { summary = { type = "string" } }, required = ["summary"] }
                                 # 可选：对象根 JSON Schema；只能配 mode = "one-shot"
```

**0.4.0 移除了 `persona` 与 `[tools]`**（DSH 0.2.1 起官方不再有这两个启动字段）。子代理的人设与工具集改由它选用的 Agent Preset 决定，写法见 [0.4.0 升级说明](guide/migrating-to-0.4.md)。

**完整可运行的两个例子**：[`guide/explorer.toml`](guide/explorer.toml)（`continuable` + 子代理模型路由 + `agent_preset`）、[`guide/reviewer.toml`](guide/reviewer.toml)（`one-shot` + 结构化返回 + `agent_preset`）。两者都逐键标注了必填/可选与省略时的行为。

## TOML 字段参考

| 键 | 必填 | 类型 / 可选项 | 默认 | 作用与约束 |
|---|---|---|---|---|
| `name` | **是** | string，`[A-Za-z0-9][A-Za-z0-9_-]{0,63}` | — | `agent_type` 的取值。**同一目录内重名 → 两个定义都失败**；跨目录同名时项目覆盖用户 |
| `description` | **是** | 非空 string | — | **模型选择该子代理的依据**：会以 `<name> — <description>` 的形式写进 `agent_type` 参数说明（枚举本身只带名字），所以写清"什么时候该用它" |
| `enabled` | 否 | `true` / `false` | `true` | `false`：不进 `agent_type` 列表与工具描述；显式调用报 `subagent "x" is disabled in <file>` |
| `mode` | 否 | `"one-shot"` / `"continuable"` | `"one-shot"` | `one-shot`：等待子代理完成并返回文本；`continuable`：**立即**返回 `started subagent <childId>`——本次调用不带结论，子代理收尾时**会**把它的最终文本作为结算通知投递给父会话（前提是结论写在最后一条消息里，见 [继续一个 continuable 子代理](#继续一个-continuable-子代理依赖官方控制工具)） |
| `provider` | 否 | 已注册的传输名（随 profile 而定，如 `spawn`/`fork`/`acp`/`codex`/`claude-code`/`dsh-sdk`） | 插件行 `defaultProvider`（`spawn`） | 未注册时调用报错并列出已注册的 provider 名 |
| `llm_provider` | 否 | string | 不覆盖（继承父级路由） | 子代理的 LLM 路由 provider；需要 `agentOptions` |
| `model` | 否 | string | 同上 | 子代理使用的模型；需要 `agentOptions` |
| `reasoning_effort` | 否 | string | 同上 | 推理档位；需要 `agentOptions` |
| `max_tokens` | 否 | 正整数 | 同上 | 生成长度上限；需要 `agentOptions` |
| `agent_preset` | 否 | 非空 string（该 profile 已声明的 preset id） | 不指定（沿用父方 preset） | 让子代理整体套用该 Agent Preset：**人设**由 preset 里的 `@deepseek-ai/dsh-persona` 行决定，**工具集**由 preset 挂哪些工具插件行决定。需要 `agentPreset` 能力**且** provider 不继承父上下文（`spawn` 可以，`fork` 不行），并要求该组合挂载了 `agent-presets` 服务（随发行版的 web 组合有、headless 组合没有）。id 不存在或服务缺失时**调用期**报错并列出可用 preset |
| `max_depth` | 否 | 整数 ≥ 1 | Host `subagent.maxDepth`（默认 1） | 本定义创建出的子代理的**绝对深度**上限；需要 `depthLimit`。**不写时：provider 支持 `depthLimit` 才下发 Host 深度，不支持则本次委派不下发上限**（见下） |
| `output_schema` | 否 | TOML 表（对象根 JSON Schema） | — | 子代理返回结构化结果；需要 `outputSchema`，**且只能配 `one-shot`**。成功时父会话收到的是**该 schema 的 JSON 文本** |

键名允许用 `-` 代替 `_`（`llm-provider` ≡ `llm_provider`、`agent-preset` ≡ `agent_preset`、`max-depth` ≡ `max_depth`）。**未知键与类型错误一律报错**，不会被静默忽略。

**0.4.0 起不再接受的键**：`persona` 与 `[tools]`（含 `allow`/`deny`）。写了它们的文件会在解析期失败，报错里直接给出迁移做法并指向 [0.4.0 升级说明](guide/migrating-to-0.4.md)。

### 生效条件（能力位）

| 字段 | 需要的 provider 能力 | 支持的 provider |
|---|---|---|
| `llm_provider` / `model` / `reasoning_effort` / `max_tokens` | `agentOptions` | `spawn`、`fork`、`dsh-sdk` |
| `agent_preset` | `agentPreset`（且 provider 不继承父上下文） | `spawn` |
| `max_depth` | `depthLimit` | `spawn`、`fork` |
| `output_schema` | `outputSchema` | `spawn`、`fork`（且仅 `one-shot`） |
| `mode = "continuable"` | provider 实现 `prepareContinuable` | `spawn`、`fork` |

`acp` / `codex` / `claude-code` 不声明任何启动能力。**只要定义里没写上表任何能力字段，这些 provider 照常可用**；一旦写了，失败时机分两类：

- **解析期失败（文件写错）**：必填缺失、类型错误、未知键（含已移除的 `persona` / `[tools]`）、`max_depth = 0`、`agent_preset` 为空串 —— 定义直接判失败并给出原因。
- **调用期失败（运行时事实）**：provider 是否具备某项能力、该 profile 有没有挂载 preset 服务、preset id 是否存在，只有委派那一刻才能确定，因此报错形如
  `subagent "x" cannot run on provider "codex": child LLM routing is unsupported by this provider`。

### `max_depth` 不写时会发生什么（容易踩的一处）

Host 的深度是**绝对深度上限**，而 Harness 规定：请求里带 `maxDepth` 就必须由具备 `depthLimit` 的 provider 执行，否则整次调用被拒（官方工具为此提供了 `maxDepth: 'provider-managed'`）。因此本插件的规则是：

| 定义 | provider 有 `depthLimit` | 结果 |
|---|---|---|
| 写了 `max_depth` | 有 | 按该值下发 |
| 写了 `max_depth` | 无 | **调用期报错**（`an explicit depth cap is unsupported by this provider`），与上表一致 |
| 没写 `max_depth` | 有 | 下发 Host 的 `subagent.maxDepth`（默认 1） |
| 没写 `max_depth` | 无 | **不下发上限**，本次委派没有深度限制；Host 日志会为该 provider 记一条 warn |

也就是说：想让某个 provider 上**一定**有上限，就在定义里写 `max_depth`（代价是该 provider 必须支持 `depthLimit`）。

### 继续一个 continuable 子代理（依赖官方控制工具）

`mode = "continuable"` 是 **Harness 自带能力**（0.2.1 起统一走 `ctx.subagents.startActivation({ …, delivery: 'parent' })`；0.2.0 的 `startContinuable()` 已被删除），本插件只把 TOML 字段映射过去，不自己实现回传与续聊。于是有四条必须分清的事实：

1. **工具返回值只是"已启动"**：`started subagent <childId>`（与官方 `subagent` 工具在 continuable 下的措辞逐字相同）。初始 prompt 在**入队被接受**时就返回，这就是这次调用的全部返回值 —— **结论不在里面**。
2. **收尾会回传，但只回传最终文本**：子代理那一轮结束时，`dsh-subagent` 的续接管理器会向父会话投递一条**结算通知**（官方措辞：`you are notified when the run settles`）：

   ```
   Background subagent <id> finished and will do no further work unless you send it more.
   Its closing message:
   <子代理最后的文本>
   ```

   父会话空闲时会被它唤醒；挂掉/超限/拒绝/失败的收尾也各有对应句式（`was stopped before it finished` / `ran out of room` / `declined the task` / `failed before it finished`），没有文本时写 `It left no closing message.`。**不回传**的是中间过程：工具输出、推理、以及中途说过但不在收尾文本里的话 —— 这些要靠消息往返。

   **两种投递形态不要混判**：子代理**运行中**主动 `send_message(agent_id = 父代理 id)` 时，父会话看到的形态是 `Agent <子代理id> sent a message:` + 正文 —— 它只表示"还在跑，先报一件事"；只有**这一轮结束**后由宿主自动投递的 `Background subagent <id> finished …` + `Its closing message:` 才表示"已收尾，以下是结论"。发送方会同步拿到投递确认（`message delivered to agent <父会话id>`），失败时返回错误、可见且可重发；这条确认是**送达**而非答复。
3. **父会话必须在它收尾时仍然存在**：结算通知由续接管理器投递给**当时仍活着的直接父 Agent** —— 服务没有持久化父邮箱，父会话若已结束（典型是 `dsh … "任务"` 这类一次性 headless 运行，父轮次先 `turn/end`），通知无处投递、**静默丢弃且不重放**。注意这与模型侧 `send_message` 不同：那条失败会返回错误，而结算通知这一路不会报错。因此**需要当场拿到结论的一次性任务请用 `one-shot` 定义**（`one-shot` 的结论就是工具返回值，不经过这条路）；`continuable` 留给父会话能持续在线的场景（GUI 会话）。
4. **续聊要靠官方的 `dsh-tool-subagent-control`**，不是任意叫 `send_message` 的工具：

| 工具 | 参数 | 语义 |
|---|---|---|
| `send_message` | `agent_id`、`message` | 只授权**直接父子**之间（父 → 直接 continuable 子，或驻留的 continuable 子 → 直接父）；返回 `{messageId}` = **送达确认，不是答复**。目标在跑就在最近步骤插入；空闲则唤醒；已结算则**冷启动**一个新 Activation 再投递 |
| `interrupt_agent` | `agent_id` | 要求它停止当前工作（不等它停下）；之后仍可用 `send_message` 继续 |

> **写 persona 的要点**：既然回传的只是"最后一条消息的文本"，`continuable` 定义所选用的 Agent Preset 里，persona 行必须明确要求**把结论汇总在收尾消息里**（含证据、结论、未解决问题），而不是散落在中途的工具调用中。中途出现影响父代理决策的发现时，再显式要求它用 `send_message(agent_id = 父代理 id)` 提前发一条。

两条硬限制：

- **`one-shot` 子代理永远无法续聊**；兄弟、隔代祖先、自身也都不被授权。
- **启用 Agent Teams 后"续聊"这条会被它替换掉。** `dsh-experimental-agent-team-profile` 会禁用 `tool-subagent-control`（连同 `tool-subagent`、`tool-subagent-fork`、`list-agents`），改挂 `tool-agent-team`：那个 `send_message` 的参数是 **`target`**（队友），对子代理 id 只会报 `active teammate "<id>" not found`。此时 `agent_type` 委派本身照常可用，**结算通知也照常投递**，只是父代理无法再主动追问该子代理 —— 这是该实验性 profile 的既定取舍，不是本插件的问题。

### 常见误解

**误解 1：`mode = "continuable"` 会等子代理跑完，答复稍后自动送达。**
前半句错、后半句对。`started subagent <childId>` 就是这次工具调用的全部返回值（官方语义：初始 prompt 入队被接受即 resolve），**结论不在返回值里**；但子代理收尾时宿主**会**投递一条带它最终文本的结算通知（见上一节），父会话空闲时会被唤醒。要注意这个回传是"最后一条消息的文本"，中途的工具输出、推理都不在其中 —— 所以**结论必须写在收尾消息里**，该定义所选 Agent Preset 的 persona 要这样要求它。

**误解 2：任何叫 `send_message` 的工具都能继续子代理。**
只有官方 `dsh-tool-subagent-control` 的那个可以：参数是 **`agent_id`**，只授权**直接父子**之间，返回的是**送达确认**而不是答复。Agent Teams 的同名工具参数是 **`target`**、寻址的是**队友**：拿子代理 id 去调只会得到 `active teammate "<id>" not found`。

**误解 3：装了 Agent Teams 就不能用本插件了，或者装了就收不到子代理结论。**
本插件的 `agent_type` 委派直接调用 `ctx.subagents.startActivation()`，与官方 `tool-subagent*` 无关，所以**委派本身照常可用**；**结算通知也照常投递**（它由续接管理器发出，团队组合包只禁用四个工具行）。但官方**不支持**这个组合使用方式：被 Agent Teams 替换掉的正是"官方直连委派"那一路 —— 父代理续聊 continuable 子代理的控制工具、`list_agents`（变成列队友）、以及官方 `subagent` / `subagent_fork` 工具本身。因此本插件**不推荐**、也不支持与它同时启用；设置页检测到团队开启时会显示红色提示（提示框自身可关闭；**关闭团队仍需你自己在插件页操作，本插件不会代为改动 profile**），完整说明见[与智能体团队（Agent Teams）不支持组合使用](#与智能体团队agent-teams不支持组合使用)。

**误解 4：`continuable` 保证父会话一定收得到结论。**
收得到的前提是**父会话在子代理收尾时仍然存在**。结算通知没有持久化邮箱，只在父会话自己的 turn 流里追加；父会话先结束就静默丢失，也不会重放。一次性运行（headless / `-p` 单轮 / 脚本化）要用 `one-shot` 定义，它的结论就是工具返回值。

### `output_schema` 的返回值长什么样

配了 `output_schema` 的 `one-shot` 定义，父会话**收到的是符合该 schema 的 JSON 文本**（缩进两格）。这一点值得单独说明，因为 Harness 会给这类子代理下一条硬指令（`When you have your final answer, you MUST report it by calling the structured_output tool… Do not finish with a plain text answer`）：子代理的最终文本**通常是空的**，真正的结论在结构化值里。所以：

- 成功时：工具返回值就是那段 JSON，不会再出现"(the subagent finished without a text answer)"这种占位句；
- 如果子代理同时留了文本，文本会附在 JSON 之后（中间空一行），两条信息都不丢；
- 子代理跑完却没有产出符合 schema 的值时，错误里会明确写出 `the child did not produce a value for output_schema`，而不是让它看起来像模型崩了；
- 想要 JSON 之外的**散文结论**，就在该定义选用 preset 的 persona 行里另外要求它交一段总结文本（上面那条指令并不禁止追加文本）。

### 子代理的人设与工具集：Agent Preset（0.4.0 起）

DSH 0.2.1 从启动请求里删掉了逐子代理的 `persona` 与工具过滤，0.4.0 因此移除了这两个 TOML 字段。它们的落点是**该定义用 `agent_preset` 选中的那个 Agent Preset**：

| 原来写在 TOML 里 | 现在写在哪里 | 怎么落 |
|---|---|---|
| `persona = "…"` | preset 的 `@deepseek-ai/dsh-persona` 行 | 那一行的 `config.prefix` 就是这段人设文本；一个 preset 一个 persona |
| `[tools] deny/allow` | preset 挂哪些工具插件行 | **逐名字的允许/拒绝无法表达**：只能让 preset 只挂该子代理能用的工具（例如不挂 `write`/`edit`），也就是"一个工具集合一个 preset" |

`agent_preset` 的三个前置条件，缺一在委派时报错并说明原因：

1. **provider 具备 `agentPreset` 能力**（`spawn` 有；`acp`/`codex`/`claude-code`/`dsh-sdk` 都没有）；
2. **该 provider 不继承父上下文**（`fork` 继承，因此不能选独立 preset；`spawn` 可以）；
3. **profile 挂载了 `agent-presets` 服务**（随发行版的 **web** 组合有，**headless** 组合没有 —— 缺失时插件在加载期就记一条 `info`，把"这个组合不支持 agent_preset"讲清楚，而不是等到第一次委派才失败）。

第 1、2 条在**调用期**按 provider 的能力位判定；第 3 条与"preset id 是否存在"也在**调用期**判定，报错会列出当前组合里可用的 preset id。工具描述里则会列出可用 preset，让模型不必猜。

完整迁移写法（含"用 preset 实现只读子代理"的 profile 片段）见 [0.4.0 升级说明](guide/migrating-to-0.4.md)。

### `max_depth` 的语义

它约束的是**本定义创建出来的子代理**的绝对深度（父级为 0，直接子代理为 1），而不是"这个子代理还能不能再往下委派"：

- `max_depth = 1`（推荐）：允许本次委派；子代理若再想委派，其深度 2 > 1 会被拒绝 —— 这才是"它不能再往下委派"。
- `max_depth = 0` **永远无法成立**（子代理深度至少为 1），因此本插件在解析阶段就判该定义失败并说明原因，而不是让模型在运行时撞到 `subagent depth 1 exceeds maxDepth 0`。

### 一次失败的升级会是什么样（0.4.0 常见现象）

沿用旧字段的文件不会被静默忽略，也不会让插件整体挂掉：

- 含 `persona` 或 `[tools]` 的文件在**下一次读盘时**被判失败（插件激活时，或下一次委派前的重装），原因是定向迁移提示，例如
  `persona was removed in 0.4.0: … write agent_preset = "<preset id>" instead … (see guide/migrating-to-0.4.md)`；
- 失败只在宿主日志里是一行 `warn`（`dsh-agents-toml: <file>: <原因>`），插件本身**照常加载**，其它定义不受影响；
- 如果还有别的可用定义，工具描述里会多一句 `Unavailable definitions: <name> (<原因>)`，模型硬点该名字会得到 `subagent "<name>" is unavailable: <原因> (<file>)`；
- **如果你只有那一个定义，委派工具会整体消失**（没有可用定义时不注册工具），此时唯一的信号就是那条日志 warn。这是升级场景下最容易困惑的一点：`agent_type` 列表空了、工具不见了，请先看日志。

### 不能配置的项

- **权限预设 / 沙箱 / 审批策略**：由父会话快照继承，"只读子代理"只能用"只挂读工具的 Agent Preset"近似。
- **provider 实例级设置**（如 `claude-code` 的 `permissionMode`、`acp` 的 `command/args/env`）：属于 profile 里的插件行，定义只能按名选择已注册的 provider。
- **子代理工作目录**：继承父会话 cwd。
- **逐名字的工具允许/拒绝**：DSH 0.2.1 起官方没有等价字段（这也是 `[tools]` 被移除的原因）；只能用 preset 选择"挂哪些工具插件行"。
- **`run_in_background`**：未暴露；后台语义由 `mode` 决定。

完整清单与原因见 [技术文档 · 不支持的能力](guide/technical.md#11-明确不支持的能力)。

## 失败可见性

1. 日志：每个失败文件一行 `dsh-agents-toml: <file>: <原因>`（同一文件 + 原因只报一次）。
2. 工具描述：列出不可用定义及原因（可关，见设置项）。
3. 调用报错：名字不存在 → 列出当前可用名字；命中失败定义 → 给出原因与文件路径。
4. 加载期降级告知：组合缺少某个**可选服务**时（例如没有 `agent-presets`），加载时记一条日志说明哪些功能因此不可用。
5. 任何定义问题**都不会导致 Agent 创建失败**。

## 文档

| 文档 | 内容 |
|---|---|
| [`guide/technical.md`](guide/technical.md) | 技术文档：实现结构、插件行配置语义、解析与校验规则、能力位规则与报错、生命周期、热更新、客户端半边、真机验证结论、开发与测试、限制 |
| [`guide/migrating-to-0.4.md`](guide/migrating-to-0.4.md) | 0.4.0 升级说明：被移除字段的等价写法、Agent Preset 怎么配、升级后会发生什么 |
| [`guide/settings-explained.md`](guide/settings-explained.md) | 四个设置项的场景讲解 |
| [`guide/explorer.toml`](guide/explorer.toml) / [`guide/reviewer.toml`](guide/reviewer.toml) | 逐键注释的完整示例 |

## 开发与测试

```sh
npm install
npm run check          # 两个编译面类型检查 + 文档链接检查 + 单测
npm run check:harness  # 用已安装的 DSH 校验本插件依赖的声明是否还在（见下）
npm run check:e2e      # 用真实 Harness 复验"声明如何变成模型可见的工具"（见下）
npm run build          # 产出 lib/*.js、lib/types/*.d.ts 与 lib/client.js
```

单测完全不依赖 DSH 安装，也不读写真实 `$DSH_HOME`。细节与覆盖范围见 [技术文档 · 测试](guide/technical.md#13-测试与构建)。

### 真机复验（`npm run check:e2e`）

单测里的 `tools.register` 是替身，因此"设置写入后正在运行的 Agent 会不会重新安装工具"这条路径在单测里**无法验证**——它取决于 Loader 的 volatile 语义。`scripts/e2e.mjs` 用真实组件复验它，分三档，按环境变量逐档启用：

| 档位 | 需要 | 验证内容 |
|---|---|---|
| Loader（默认跑） | 已安装的 DSH | 用真实 `cordis-plugin-loader` 建行、建 Agent、写设置：项目定义即时安装、volatile 写入重装而不重挂、关闭信任释放工具、重名双向剔除、关监听后文件不再触发重装 |
| 委派（`E2E_PROJECT`） | 一次性 home + 打开信任的 profile；可选模型凭据 | 真跑一次 `dsh --profile … --json`，从会话日志核对 `subagent_custom` 的 `agent_type` 枚举、子代理确实选中了定义里的 Agent Preset（子会话里 `agent-preset/selected` 出现在首条描述符之前、且该 preset 的 persona 文本进了子代理的系统提示）、AGENTS.md 是否注入子代理 |
| 浏览器（`E2E_GUI`） | 一个运行中的 Web 实例 + 带调试端口的独立浏览器 | 在**已打开**的会话里改设置/改定义文件，从该会话后续请求的日志核对枚举当场变化；`continuable` 子代理的收尾文本是否作为结算通知回投父会话（并按其当时忙碌与否核对投递形态） |

#### 环境变量

| 变量 | 默认 | 用途 |
|---|---|---|
| `E2E_DSH_ROOT` | 解析已安装的 `@deepseek-ai/dsh`，再退回 `node.exe` 旁边的全局安装 | 被测 Harness 的安装目录；Loader 档要它的 `cordis` 与 `cordis-plugin-loader` |
| `E2E_PLUGIN_ROOT` | 本仓库根 | 被测插件；Loader 档加载它的 `lib/index.js`，所以先 `npm run build` |
| `E2E_HOME` | 无 | 一次性 `DSH_HOME`。委派档与浏览器档**必需**（要有 profile 与会话目录） |
| `E2E_PROFILE` | `plugin-dev` | `E2E_HOME` 里给委派档用的 profile 名 |
| `E2E_GUI_PROFILE` | `plugin-gui` | 浏览器实例所用 profile 名；浏览器档通过它找到 `cordis.patch.yml` 来读回设置写入 |
| `E2E_PROJECT` | 无 | 被检查的**真实项目**（要有 `.dsh/agents/*.toml`）。脚本只读它：跑前跑后逐个 SHA-256 比对并核对 `git status --porcelain` |
| `E2E_API_KEY` | 无 | provider key。不给时脚本自己起一个**脚本化模型桩**（`scripts/e2e-model-stub.mjs`，说同一套 Messages 协议并必定发起委派），委派档照跑、不花额度；给了就走真实 provider |
| `E2E_BASE_URL` | 无 | provider 的 base URL；key 不是发给默认端点时设置 |
| `E2E_GUI` | 无 | 运行中的 Web 实例 URL（**含 token**）。给了才跑浏览器档 |
| `E2E_CDP_PORT` | `9222` | 那个浏览器的远程调试端口 |

#### 三档怎么跑

**① Loader 档**——不需要凭据，几秒钟。先构建，因为 Loader 档加载的是 `lib/` 而不是 `src/`：

```sh
npm install && npm run build
npm run check:e2e          # 或 node scripts/e2e.mjs
```

**② 委派档**——先造一个一次性 home 和一个打开信任的 profile，**并让这个 profile 具备 `agent_preset` 需要的东西**（一个 preset 注册表和一个示例 preset，见 [0.4.0 升级说明](guide/migrating-to-0.4.md)）。不给 key 时脚本会自动改用**脚本化模型桩**：它说同一套 provider 协议、必定发起一次委派，因此模型以下的一切（Loader、`subagents` 服务、Agent Preset 注册表、本插件的工具）都是真的，只有"模型说什么"是脚本；这条路径**不花额度**。给了 key 就用真实 provider：

```sh
export E2E_HOME=/tmp/dsh-e2e
export E2E_PROJECT=/path/to/your/project        # 有 .dsh/agents/*.toml 的项目

dsh --profile plugin-dev --from-default-profile headless
dsh plugin --profile plugin-dev add "$PWD"
# 在 profile 补丁里打开 trustProjectAgents（见「插件设置项」）
# 并补上这个组合缺的 Agent Preset 行（headless 组合默认不挂注册表；web 组合已经挂了，
# 脚本会自己看出来只补缺的那部分，因此两种 profile 都能用同一条命令）：
#   node -e "import('./scripts/e2e-preset-profile.mjs').then(m=>m.ensurePresetProfile({home:process.env.E2E_HOME,profile:'plugin-dev',dshRoot:process.env.E2E_DSH_ROOT}))"

node scripts/e2e.mjs                            # 用模型桩，零额度
E2E_API_KEY=sk-... node scripts/e2e.mjs         # 用真实模型
export E2E_BASE_URL=https://your-endpoint/v1    # 可选：key 不发给默认端点时
```

这一档的断言全部读会话日志，因此**不依赖模型说了什么**；`scripts/e2e-preset-profile.mjs` 会先问 Harness 本人（`--dump-config`）这个组合里有没有 preset 注册表，只补缺的行，写下的那段带 `# ── dsh-agents-toml e2e` 标记，重跑会跳过，且拒绝改写 `~/.dsh`。

**③ 浏览器档**——需要三样东西同时活着：一个 Web 实例、一个带远程调试端口的独立浏览器、以及它们所属的一次性 home。缺任何一样这一档都跑不起来，所以下面按顺序给出全部命令。

> **两个只在浏览器档才会遇到的坑**
> 1. **实例要有模型。** 这一档在真实 Web 实例里跑真会话，所以 `dsh --profile plugin-gui` 启动时必须带上 provider 凭据（或指向委派档那个模型桩：`DEEPSEEK_BASE_URL=http://127.0.0.1:<stub 端口>/v1 DEEPSEEK_API_KEY=stub-key`）。没有模型时页面能开，但第一条消息就发不出去，报错会以"找不到输入框/composer"的形式出现。
> 2. **要有一个已选中的工作区。** 新实例首次进入是"选择工作区"页，而那个选择器是系统目录选择框，CDP 驱动不了它。请先手动选一次（选你的 `E2E_PROJECT`），之后脚本就能直接用；工作区是持久化的（`$E2E_HOME/storages/workspace.json`），也可以直接写这个文件预置。

```sh
# 1) 隔离 home 与 profile（不要用你日常那个 profile）
export E2E_HOME=/tmp/dsh-e2e
dsh --profile plugin-gui --from-default-profile web
dsh plugin --profile plugin-gui add "$PWD"

# 2) 起 Web 实例（用私有端口，避免和日常实例抢）；控制台会打印带 token 的 URL
#    web 组合自带 preset 注册表，所以不用像委派档那样补 profile
export DEEPSEEK_API_KEY=sk-...        # 或指向模型桩
dsh --profile plugin-gui --port 3931 --no-open
#    记下形如 http://127.0.0.1:3931/?token=<token> 的地址

# 3) 起浏览器并开远程调试（用独立 user-data-dir：Chrome 136+ 禁止在默认
#    user-data-dir 上开远程调试，用默认目录会静默失败）
#    Chrome/Edge 均可，端口与下一步的 E2E_CDP_PORT 必须一致
chrome --remote-debugging-port=9222 --user-data-dir=/tmp/cdp-profile \
       --no-first-run --no-default-browser-check about:blank

# 4) 跑这一档
export E2E_PROJECT=/path/to/your/project
export E2E_GUI='http://127.0.0.1:3931/?token=<token>'
node scripts/e2e.mjs
```

在 Windows PowerShell 里把 `export X=…` 换成 `$env:X = '…'`，`$PWD` 换成 `(Get-Location).Path`，第 3 步的浏览器命令换成：

```powershell
Start-Process chrome -ArgumentList '--remote-debugging-port=9222',
  '--user-data-dir=D:\temp\cdp-profile','--no-first-run','--no-default-browser-check','about:blank'
```

浏览器档检查的是**会话日志**（谁在什么时刻被注册、`agent_type` 枚举是什么），不是画面，因此无头启动也可以；但 Chrome 在窗口被最小化或完全遮挡时可能不响应截图——这一档不截图，所以不受影响。

约定：`E2E_HOME` 用一次性 home；`E2E_PROJECT` 用真实项目，脚本在跑之前后对 `AGENTS.md` 与 `.dsh/agents/*.toml` 逐个算 SHA-256 并比对 `git status --porcelain`，跑完必须一字不差；凭据只从环境变量读。浏览器档连的是**调用者自己起的**实例（`E2E_CDP_PORT`，默认 9222），不会去碰别的端口。它**不在 `npm run check` 里**，也不在 `prepublishOnly` 里：三档都需要真实环境。额度方面只有两处：委派档不给 `E2E_API_KEY` 时用本地模型桩（零额度），浏览器档会在真实 Web 实例里跑真会话，因此**按真实用量计**。

## 边界与演进（DSH 升级时看这里）

本插件**不 import 任何 `@deepseek-ai/dsh-*` 包**：它只通过 `src/host.ts` 里的结构性类型调用 Harness 的服务，因此发布包的版本落后于运行时也不会把它锁死。代价是"声明被改名"这类变化编译器不会发现，所以有一个专门的检查：

```sh
npm run check:harness                              # 自动解析已安装的 @deepseek-ai/dsh，解析不到就找 node.exe 旁边的全局安装
DSH_SHAPE_ROOT=<node_modules> npm run check:harness  # 指定别的安装位置
```

它会逐条读取已安装包的声明文件，核对本插件用到的每个名字（`subagents.startActivation` / `getProvider` / `resolveMaxDepth`、`SubagentActivationSpec.delivery`、`agentPreset`（请求字段与能力位）、`SubagentResult.structured`、`depthLimit`、`inheritsParentContext`、`agentPresets.list`、`loader/volatile-update`、`skills.registerProvider`、`plugin-manager/changed`、`remote.<namespace>`、`listBundles`、以及客户端半边用到的 `SettingsForm` / `SettingsValueField` / `createSnapshotStore` / `plugins.bundle.config` 等），任何一条消失就打印 `DRIFT` 并以非零码退出，指明要改哪个模块（`src/host.ts`、`src/harness.ts`、客户端半边）。**本机根本没有 DSH 时**它单独报一句 `no DeepSeek Harness installation found` 并以退出码 1 结束，而不是把每条声明全判成 DRIFT——"没装"与"被改名"必须区分开，否则第一眼的结论正好是反的。客户端那几个包是 Web 端打包的**平台模块**，裸装 `@deepseek-ai/dsh` 时未必落在磁盘上，因此它们的条目标了 `optional`：**在磁盘上就核对，不在就报 `SKIP`**（以 SKIP 与 DRIFT 区分"这台机器没装这个包"与"这个包改名了"）。它**不在 `npm test` 里**，因为单测刻意不需要 DSH 环境；建议在升级 DSH 后先对**新装的**那棵树跑一次（`DSH_SHAPE_ROOT=<新安装>/node_modules/@deepseek-ai npm run check:harness`）。

`src/harness.ts` 是全项目唯一做能力探测的地方：composition 缺少某个可选服务时（Agent 注册表、共享深度策略、**Agent Preset 名册**），它会**在加载时明确告知缺什么、会少哪个功能**，而不是在用到时才静默降级。

### 关于 DSH 版本约束（`engines.dsh` + `peerDependencies` 双声明）

Harness 会检查插件的兼容范围，不满足就**拒绝安装**（并提示用 `dsh plugin allow-version` 逐版本放行）。本包的做法是**同时声明两处**，因为两代 Harness 读的字段不同：

- `engines.dsh: ">=0.2.1-rc.2"` —— **DSH 0.2.1 及以后只读这个字段**（此时 peer 被忽略）；
- `peerDependencies: {"@deepseek-ai/dsh": ">=0.2.1-rc.2"}` —— **DSH 0.2.0-rc.2 那一代完全不读 `engines`**，只读 peer；这一条就是让旧运行时也拒绝 0.4.0；
- `peerDependenciesMeta` 把该 peer 标成 `optional`，避免 npm/pnpm 试图去安装 `@deepseek-ai/dsh` 本体。**这不会削弱拒绝**：Harness 的兼容性判定不读 `peerDependenciesMeta`。

为什么值得写死范围而不是"什么都不声明"：

- 0.4.0 依赖的正是 0.2.1 **改掉**的那部分契约（`startActivation` 取代 `start`/`startContinuable`）。不声明范围的话，插件会被静默装上一个会在第一次委派时抛 `startActivation is not a function` 的运行时——那比安装期拒绝差得多；
- 代价是"范围之外一律拒绝"，所以放行口子必须留着：确实要在被拒绝的版本上试，用 `dsh plugin allow-version`。

声明的范围**没有上限**（`>=` 而非 `^`），因此它只兜住"太旧"，兜不住"未来某版又改契约"——那一路由 `npm run check:harness` 负责（这也是它存在的理由）。真实的宿主契约清单见 [技术文档 · 宿主契约](guide/technical.md#12b-宿主契约与本插件用到的名字)。
