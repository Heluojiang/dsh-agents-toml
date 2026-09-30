# dsh-agents-toml

用 TOML 文件给 DeepSeek Harness 声明**具名子代理**的插件。它不修改 DSH 源码，作为普通 bundle 通过 `dsh plugin add` 安装。

> 完整功能与边界（字段语义、能力位映射、失败可见性、真机验证结论、明确不支持的能力）见 **[docs/FEATURES.md](docs/FEATURES.md)**。

- **一个工具 + `agent_type` 参数**：模型看到 `subagent_custom`（名字可配）一个工具，用 `agent_type` 选择要委派的子代理，而不是每个定义多一份工具 schema。
- **两层目录**：`$DSH_HOME/agents/*.toml`（全局，始终加载）与 `<projectRoot>/.dsh/agents/*.toml`（项目级，默认关闭，需显式信任）。同名时项目定义覆盖全局定义。
- **失败可见、互不牵连**：某个定义写错或用了 provider 不支持的能力时，只有该定义不可用（日志 + 工具描述里说明原因），其余定义照常工作，且**绝不会导致 Agent 创建失败**。
- **热生效**：定义文件在每次调用时重新读取，改完下一次委派即生效；目录 watcher 会在增删文件后重装工具，让 schema 里的 `agent_type` 列表同步更新。

本插件按 DSH 的函数式插件约定编写（`name` / `inject` / `Config`(Schemastery) / `apply`），注册走 `ctx.tools.register`，按 Agent 作用域安装（`agent.ctx.inject`），清理走 `ctx.effect`。它**不 import 任何 `@deepseek-ai/dsh-*` 内部包**：工具注册表只校验输出 schema（`packages/core/tools/src/index.ts` 的 `register` 只 `assertSupportedJsonSchema(output.schema)`，入参由工具自己校验），其余都是结构性 ctx 方法，因此在 npm 上发布版本落后于运行时版本的情况下仍可加载。

## 安装

### 本地目录（开发/试用）

```sh
dsh plugin --profile web add D:\Work\Codes\Others\dsh-agents-toml
```

### npm（发布后）

```sh
dsh plugin --profile web add dsh-agents-toml
```

> 当前 `package.json` 里保留了 `private: true`（开发态防误发布）。要发布到 npm，删掉该字段后 `npm publish`；`prepare` 脚本会先构建。

### GitHub

```sh
dsh plugin --profile web add github:<you>/dsh-agents-toml
```

git 安装拿到的是源码，所以包内自带 `prepare` 脚本（`tsc -p tsconfig.build.json`）。pnpm ≥10 默认拦截依赖的构建脚本，第一次 `add` 会失败，并打印放行所需的**完整 key**（pnpm 会把它规范化成 codeload tarball URL 并带提交 SHA），例如实测输出：

```
ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED  The git-hosted package "dsh-agents-toml@0.1.0" needs to execute build scripts but is not in the "allowBuilds" allowlist.
Add the package to "allowBuilds" in your project's pnpm-workspace.yaml to allow it to run scripts. For example:
allowBuilds:
  dsh-agents-toml@https://codeload.github.com/<you>/dsh-agents-toml/tar.gz/<sha>: true
```

把 **`allowBuilds:` 下面那一整行**追加到 `$DSH_HOME/profiles/<profile>/pnpm-workspace.yaml`，然后重跑 `add`。该文件已存在（含 `packages`、`nodeLinker`、`autoInstallPeers`），**追加，不要覆盖**。

两个坑：

- 只写裸包名 `dsh-agents-toml: true` **不足以**放行 git 依赖（pnpm 11 按完整 spec 匹配，实测被拒）。
- key 里的 SHA 随提交变化；更新到新提交后需要把新打印的 key 也加进 `allowBuilds`。

**放行构建脚本等于允许该包在你的机器上以你的权限执行代码**：只放行你自己信任的仓库，并固定提交（`github:you/dsh-agents-toml#<sha>`）以免后续推送改变实际执行的代码。

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

| 动作 | 开启 HMR 的 profile（`web` 默认开启） | 关闭 HMR 的 profile（`headless` / `sdk` / `acp` / `sdk-minimal`） |
|---|---|---|
| 安装/卸载本插件 bundle | 不需要重启：DSH 监听 profile 的 `package.json`（`dsh.profile.bundles`）与 patch 文件并在变化时重组 | 需要重启 |
| 新增/修改 `*.toml` 定义 | 不需要重启（下次调用即生效；watcher 会刷新工具 schema） | 同左 |
| 升级本插件自身版本 | 已加载的模块实例不会热替换，建议重启 | 需要重启 |

## 开启项目级子代理（装完必看）

**项目级定义默认是关闭的。** `<projectRoot>/.dsh/agents/*.toml` 会随 `git clone` 一起到来，所以插件默认只加载用户级 `$DSH_HOME/agents/*.toml`，必须显式信任才读取项目目录（忽略时会打印一行 info 日志说明）。

> 插件页目前**没有**本插件的配置表单 —— 第三方插件的配置页需要各插件自带客户端半边（官方那几个配置页都是这么做的），通用配置页尚未提供（依据见 [docs/FEATURES.md](docs/FEATURES.md) 第 11 节）。所以现在用下面的一键脚本，或让 Creator 模式下的 agent 代改。

### 一键开启（PowerShell，幂等）

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
  "该 profile 还没安装本插件，先运行：dsh plugin --profile $profileName add github:Heluojiang/dsh-agents-toml"
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

脚本做三件事：确认该 profile 真的装了本插件（否则 `- id: dsh-agents-toml` 会指向不存在的行，`--dump-config` 打印 `patch: entry "dsh-agents-toml" not found`）；已在则跳过（幂等）；**空补丁 `[]` 用替换而不是追加**，避免 YAML 解析失败。

写入后对**新任务/新会话**立即生效；开启 HMR 的 profile（`web` 默认开启）无需重启，因为补丁文件被监听。已经存在的会话/Agent 不会自动重装工具，**新建一个任务**即可。

### 验证

```powershell
dsh --profile web --dump-config > $env:TEMP\dump.txt
Select-String -Path $env:TEMP\dump.txt -Pattern 'dsh-agents-toml' -Context 0,6
```

应看到（补丁层里的这一行）：

```yaml
# == ...\profiles\web\cordis.patch.yml
- id: dsh-agents-toml
  name: dsh-agents-toml
  config:
    trustProjectAgents: true
```

### 另外两种方式

- **临时试用**：`dsh web --patch .\trust-project.patch.yml`（文件内容同上，不改 profile）。
- **让 agent 代改**：启用 Creator 模式后说"把 dsh-agents-toml 的 trustProjectAgents 打开"，它通过 `plugin_manager` 写入当前 profile。

### 开启前后对比

| 目录 | 作用域 | 默认 | 开启后 |
|---|---|---|---|
| `$DSH_HOME/agents/*.toml` | 用户级（整机） | ✅ 始终加载 | ✅ |
| `<projectRoot>/.dsh/agents/*.toml` | 项目级（随仓库） | ❌ 忽略并记一条 info | ✅ 同名覆盖用户级 |

项目根 = 会话工作目录向上最近的含 `.git` 目录；找不到则用工作目录本身。

## 目录与优先级

| 目录 | 来源 | 是否默认加载 |
|---|---|---|
| `$DSH_HOME/agents/*.toml` | 用户级（对整台机器生效） | 是 |
| `<projectRoot>/.dsh/agents/*.toml` | 项目级（随仓库分发） | **否**，需 `trustProjectAgents: true` |

`$DSH_HOME` 默认为 `~/.dsh`。项目根 = 从会话工作目录向上找到的最近含 `.git` 的目录（与 DSH 技能发现一致），找不到就用会话工作目录本身。

同名定义：项目覆盖全局；**同一个目录内重名则两个都判为失败**（不猜赢家）。非 `.toml` 文件被忽略。

## 配置

插件行的 `config`（写进 `$DSH_HOME/profiles/<name>/cordis.patch.yml`，或在插件页里改）：

```yaml
- id: dsh-agents-toml
  config:
    trustProjectAgents: false      # 是否允许项目目录的定义
    toolName: subagent_custom      # 模型看到的工具名
    defaultProvider: spawn         # 定义未指定 provider 时用的传输
    projectAgentsDir: .dsh/agents  # 项目内相对目录
    watchDefinitions: true         # 监听定义目录，变更后重装工具
    reportFailuresToModel: true    # 在工具描述里列出不可用的定义
    # userAgentsDir: 'C:/Users/you/.dsh/agents'   # 可选：覆盖用户目录
```

## `xxx.toml` 字段

```toml
name = "reviewer"                    # 必填，唯一；模型用它填 agent_type
description = "只读代码审查"           # 必填；模型据此选择
enabled = true                        # 默认 true
mode = "one-shot"                     # "one-shot"（默认，等待结果）| "continuable"（后台持久子代理）
provider = "spawn"                    # 传输名：spawn/fork/acp/codex/claude-code/dsh-sdk…
llm_provider = "deepseek-official"    # 子代理的 LLM 路由 provider（agentOptions.provider）
model = "deepseek-v4-flash"
reasoning_effort = "high"
max_tokens = 4096
persona = """
你是代码审查者，只报告问题，不修改文件。
"""
max_depth = 1                          # 被创建子代理的绝对深度上限；省略则用 Host 设置（默认 1）
output_schema = { type = "object", properties = { summary = { type = "string" } }, required = ["summary"] }

[tools]                                # 子代理可见/可执行的工具限制（仅进程内 provider）
deny = ["write", "edit", "bash", "pwsh"]
```

键名允许用 `-` 代替 `_`（`llm-provider`、`max-depth` 等价）。**未知键与类型错误一律报错**，不会被静默忽略。

> `max_depth` 的语义容易踩坑：它约束的是**本定义创建出来的子代理**的绝对深度（父级为 0，直接子代理为 1），而不是"这个子代理还能不能再往下委派"。所以：
> - `max_depth = 1`（推荐默认）：允许本次委派；子代理若再想委派，其深度 2 > 1 会被拒绝 —— 这才是"它不能再往下委派"。
> - `max_depth = 0` **永远无法成立**（子代理深度至少为 1），因此本插件在解析阶段就把该定义判为失败，并给出原因，而不是让模型在运行时撞到 `subagent depth 1 exceeds maxDepth 0`。

### 各字段的生效条件（能力位）

| 字段 | 需要的 provider 能力 | 实际支持者 |
|---|---|---|
| `llm_provider` / `model` / `reasoning_effort` / `max_tokens` | `agentOptions` | `spawn`、`fork`、`dsh-sdk` |
| `persona` | `persona` | `spawn`、`fork` |
| `tools.allow` / `tools.deny` | `toolFilter` | `spawn`、`fork` || `max_depth` | `depthLimit` | `spawn`、`fork` |
| `output_schema` | `outputSchema` | `spawn`、`fork`（且只能配 `one-shot`） |
| `mode = "continuable"` | `prepareContinuable` | `spawn`、`fork` |

用了 provider 不具备的能力时，该定义被判为失败并在日志中给出原因（例如 `subagent "x" cannot run on provider "codex": child LLM routing is unsupported by this provider`），不会被静默忽略 —— 这与 DSH 自身的 fail-loud 语义一致。

**`tools.allow` / `tools.deny` 里的名字必须来自该部署实际注册的工具**，它们是部署相关的：Windows headless profile 只有 `pwsh`，web profile 还可能有 `bash`/`terminal`，其他平台是 `bash`。名字写错不会静默忽略，而是在委派时明确报错并列出已知工具名：

```
Error: tools.restrict() names unknown global tools "bash", "terminal";
known global tools: create_goal, edit, …, pwsh, read, write
```

因此 `examples/reviewer.toml` 只 deny 每个部署都有的 `write`/`edit`，并把 shell 工具的 deny 行留作注释，按你的部署取消注释。

### 不能配置的项（重要）

- **权限预设 / 沙箱 / 审批策略**：委派时由父会话快照继承，定义文件无法设置。Auto/Full 父级让子级获得相同权限预设；Read Only / Workspace Write 父级保留继承的沙箱覆盖与 `approval: never`。想要"只读子代理"只能靠 `[tools] deny` 近似（同时从提示词移除并拒绝执行），并且要一并 deny shell 类工具。
- **provider 实例级设置**：如 `claude-code` 的 `permissionMode`、`acp` 的 `command/args/env`、`dsh-sdk` 的 `profile/dshHome` —— 这些属于 profile 里的插件行；定义只能按名字选择已注册的 provider。
- **子代理工作目录**：继承父会话 cwd（`acp`/`dsh-sdk` 的 provider 行可整体覆盖）。
- **是否继承父对话**：由 `spawn`（不继承）或 `fork`（继承已完成轮次前缀）决定。
- **`run_in_background`**：本插件未暴露该参数；后台语义由定义的 `mode` 决定。

## 失败可见性

1. `ctx.logger.warn` 每个失败文件一行：`dsh-agents-toml: <file>: <reason>`。
2. 工具描述里列出不可用定义（`reportFailuresToModel: false` 可关闭）。
3. 模型若调用了失效的 `agent_type`，工具返回明确原因；若名字压根不存在，返回当前可用的名字列表。
4. 任何定义问题都不会导致 Agent 创建失败。

## 开发与测试

```sh
npm install
npm run check     # tsc 类型检查 + node --test 测试
npm run build     # 产出 lib/*.js 与 lib/types/*.d.ts
```

测试完全不依赖 DSH 安装，也不读写真实 `$DSH_HOME`：`ctx` 是假实现，定义目录是内存文件系统或注入的 `homeDir`，因此不会碰到你机器上的 `~/.dsh`。

测试已覆盖：TOML 解析与全部校验分支、目录优先级与重名、能力位矩阵、请求映射（含 continuable 的字段裁剪）、工具 schema 与入参校验、委派成功/失败/取消路径、按 Agent 安装与释放、watcher 重装、卸载清理。

## 隔离式端到端验证（尚未执行）

真机验证请使用一次性 Harness home 与一次性 profile，别碰你正在使用的 `web` profile：

```powershell
$env:DSH_HOME        = 'D:\temp\dsh-plugin-e2e\home'
$env:DSH_AGENTS_HOME = 'D:\temp\dsh-plugin-e2e\agents'
dsh --profile plugin-dev --from-default-profile web
dsh plugin --profile plugin-dev add D:\Work\Codes\Others\dsh-agents-toml
dsh --profile plugin-dev --dump-config | Select-String dsh-agents-toml
```

## 已知限制

- 只暴露一个工具、一个 `agent_type` 参数；不同定义的能力差异不会体现在 schema 上，靠调用时的明确报错兜底。
- 工具 schema 里的 `agent_type.enum` 在 Agent 组装时生成；文件变更后由 watcher 重装刷新。关闭 `watchDefinitions` 时，新名字要等该 Agent 下次创建才会出现在 enum 里（直接调用新名字仍会即时生效）。
- 不提供设置页开关；项目级信任通过插件行的 `trustProjectAgents` 显式开启（默认关闭）。
- 委派是同步等待结果的（`one-shot`）或立即返回子代理 id（`continuable`），不接入 `job_*` 后台任务面。
