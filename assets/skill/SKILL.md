---
name: dsh-agents-toml
description: Author or edit dsh-agents-toml subagent definitions (TOML) that this Harness exposes as the agent_type values of its delegation tool.
whenToUse: Use when the user asks for a named/reusable subagent, a specialist delegate, or wants to change or fix an existing TOML definition.
---

# Authoring subagent definitions for `dsh-agents-toml`

This Harness runs the `dsh-agents-toml` plugin. It turns TOML files into named subagents that the model reaches through **one** delegation tool (default `subagent_custom`) whose `agent_type` argument selects the definition. Your job with this skill: turn a request in plain language into a valid definition file, then tell the user the exact `agent_type` to use.

Definitions are read on every delegation, so a new file works on the next call — no restart.

## 1. Ask before writing

Ask only what you cannot infer, but do not guess these three:

1. **Job and boundaries** — what the subagent does, and what it must never do.
2. **May it change things?** — should it only read/report, or may it edit files and run commands? (This decides the `[tools]` restriction.)
3. **Where should the definition live?** — see the rule below.

## 2. Choose the directory (this decides whether it works at all)

| Goal | Path | Requirement |
|---|---|---|
| Available to this user everywhere | `<DSH_HOME>/agents/<name>.toml` (usually `~/.dsh/agents/`) | none — always loaded |
| Travels with the repository | `<projectRoot>/.dsh/agents/<name>.toml` | **project definitions load only when the user turns on "信任项目级定义" / `trustProjectAgents` in the plugin's settings page** (Plugins → Installed → `dsh-agents-toml`) |

Default to the user directory unless the user explicitly wants the definition committed with the repository. When you do write into the project directory, say so plainly: *the file will not load until project definitions are trusted*, and point at the settings switch. Project definitions override user definitions with the same `name`; two files with the same `name` in **one** directory both fail.

`<projectRoot>` is the nearest ancestor of the working directory containing `.git`.

## 3. Write a valid file

`name` and `description` are the only required keys. Every other key has a default.

```toml
name = "docs-writer"                     # required; the agent_type value the model passes
description = "写用户文档：解释用法、补全示例，不改代码。"   # required; why the model should pick it
mode = "one-shot"                        # optional; "one-shot" (default) waits for the result
provider = "spawn"                       # optional; defaults to the plugin's defaultProvider
max_depth = 1                            # optional; 1 = it may not delegate further

[tools]                                  # optional; subtractive only
deny = ["write", "edit", "pwsh"]
```

| Key | Required | Values / notes |
|---|---|---|
| `name` | yes | `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`; kebab-case by convention |
| `description` | yes | non-empty; the model's routing hint |
| `enabled` | no | `false` hides it from the tool while keeping the file |
| `mode` | no | `"one-shot"` (default) waits for the child and returns its text; `"continuable"` returns `started subagent <childId>` immediately and the child answers later through the parent's inbox (see the pitfall below) |
| `provider` | no | a transport registered in this profile (`spawn`, `fork`, `acp`, `codex`, `claude-code`, `dsh-sdk`, …); default comes from the plugin row |
| `llm_provider` / `model` / `reasoning_effort` / `max_tokens` | no | route the child to another model; needs a provider with `agentOptions` (`spawn`/`fork`/`dsh-sdk`) |
| `persona` | no | extra system prompt for this child only; needs `persona` (`spawn`/`fork`) |
| `max_depth` | no | integer ≥ 1; caps the child's absolute depth. **`0` always fails** |
| `output_schema` | no | object-rooted JSON Schema for a structured result; **`one-shot` only** |
| `tools.allow` / `tools.deny` | no | tool names of **this deployment**; wrong names fail loudly at call time |

Hyphens may replace underscores (`max-depth` = `max_depth`). Unknown keys, wrong types, and a missing required key make **that file** fail — other definitions keep working.

## 4. Pitfalls that produce a definition the user cannot use

- **`max_depth = 0`** — rejected at parse time: the cap applies to the child being created, whose depth is at least 1.
- **Tools that only read** — there is no read-only permission preset per definition. Approximate it with `[tools] deny = ["write", "edit"]` and deny shell tools too (`pwsh` on Windows, `bash`/`terminal` elsewhere). Only `write`/`edit` are portable.
- **Tool names are deployment-specific** — do not deny `bash` on a Windows profile; it fails loud with the known names. When unsure, deny `write`/`edit` only.
- **`output_schema` with `mode = "continuable"`** — invalid combination; a structured result belongs to a one-shot run.
- **`mode = "continuable"` returns a child id, not an answer.** The prompt is queued when the call returns; the child's output arrives later as an inbox message. Continuing that same child needs the official subagent control tool (`send_message` with `agent_id`, parent and direct continuable child only) — a profile that enables Agent Teams disables that plugin and mounts a same-named tool that addresses teammates by `target` instead. Never tell the user a continuable child can be continued unless that control tool is in the composition.
- **Model routing on an out-of-process provider** — `acp`/`codex`/`claude-code` accept none of `model`, `persona`, `tools`, `max_depth`, `output_schema`; the definition then fails at call time with the reason.
- **Long personas** — a persona is not a place for the task itself; keep the task in the `prompt` the caller passes.

## 5. Report back

After writing the file, tell the user:

1. the definition name — that is the `agent_type` value to use;
2. when it takes effect (the next delegation; the tool's list updates at the next tool install, i.e. a new task/session or a definition-file change);
3. if you wrote into the project directory: that they must enable **信任项目级定义** in the plugin settings first;
4. how to try it, e.g. *"delegate to `docs-writer` and ask it to document …"*.

## 6. Templates and deeper reference (relative to this skill's package)

- `guide/reviewer.toml` — one-shot review with persona, structured result, and `write`/`edit` denied.
- `guide/explorer.toml` — continuable child routed to a faster model.
- `README.md` — field reference table and the capability matrix per provider.
- `guide/technical.md` — parse rules, capability checks with their exact messages, and limitations.
