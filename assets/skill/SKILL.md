---
name: dsh-agents-toml
description: Author or edit dsh-agents-toml subagent definitions (TOML) that this Harness exposes as the agent_type values of its delegation tool.
whenToUse: Use when the user asks for a named/reusable subagent, a specialist delegate, or wants to change or fix an existing TOML definition.
---

# Authoring subagent definitions for `dsh-agents-toml`

This Harness runs the `dsh-agents-toml` plugin. It turns TOML files into named subagents that the model reaches through **one** delegation tool (default `subagent_custom`) whose `agent_type` argument selects the definition. Your job with this skill: turn a request in plain language into a valid definition file, then tell the user the exact `agent_type` to use.

Definitions are read on every delegation, so a new file works on the next call — no restart. The `agent_type` list the model sees refreshes on a definition-file change or on any settings write, and the name you write in `description` is what the model reads when choosing.

## 1. Ask before writing

Ask only what you cannot infer, but do not guess these three:

1. **Job and boundaries** — what the subagent does, and what it must never do.
2. **May it change things?** — should it only read/report, or may it edit files and run commands? (This decides which Agent Preset it should select: a persona and tool set live in a preset, not in this file.)
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
agent_preset = "docs-writer"             # optional; the preset that owns this child's persona and tools
max_depth = 1                            # optional; 1 = it may not delegate further
```

| Key | Required | Values / notes |
|---|---|---|
| `name` | yes | `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`; kebab-case by convention |
| `description` | yes | non-empty; the model's routing hint, shown beside this name in the `agent_type` parameter description — write when to pick this role |
| `enabled` | no | `false` hides it from the tool while keeping the file |
| `mode` | no | `"one-shot"` (default) waits for the child and returns its text; `"continuable"` returns `started subagent <childId>` at once, and the child's **final text** arrives later as a settlement notice (see the pitfalls below) |
| `provider` | no | a transport registered in this profile (`spawn`, `fork`, `acp`, `codex`, `claude-code`, `dsh-sdk`, …); default comes from the plugin row |
| `llm_provider` / `model` / `reasoning_effort` / `max_tokens` | no | route the child to another model; needs a provider with `agentOptions` (`spawn`/`fork`/`dsh-sdk`) |
| `agent_preset` | no | id of an Agent Preset declared in this profile; the preset owns the child's persona and tool composition. Needs a provider with `agentPreset` that does **not** inherit the parent context (`spawn`, not `fork`), and a composition that mounts `agent-presets` (the web bundle does, the headless one does not) |
| `max_depth` | no | integer ≥ 1; caps the child's absolute depth. **`0` always fails.** Omitting it sends the Host depth only to a provider that can enforce it |
| `output_schema` | no | object-rooted JSON Schema for a structured result; **`one-shot` only**. The parent receives the schema value as JSON text |

Hyphens may replace underscores (`max-depth` = `max_depth`). Unknown keys, wrong types, and a missing required key make **that file** fail — other definitions keep working.

**`persona` and `[tools]` no longer exist.** The Harness dropped per-child persona and tool filtering in 0.2.1, so this plugin removed both keys in 0.4.0. Writing either one fails that file with a migration message pointing at `guide/migrating-to-0.4.md`. A child's persona and its tool set now come from the Agent Preset named by `agent_preset`: put an `@deepseek-ai/dsh-persona` row in that preset for the persona, and mount only the tool plugins the child may use.

## 4. Pitfalls that produce a definition the user cannot use

- **`max_depth = 0`** — rejected at parse time: the cap applies to the child being created, whose depth is at least 1.
- **`persona` or `[tools]`** — removed in 0.4.0; the file fails with a migration message. Do not "work around" it by renaming the key.
- **Tools that only read** — a preset is the only lever: build one that mounts the read tools and none of the writing ones, then select it with `agent_preset`. Per-name allow/deny lists cannot be expressed at all.
- **A `agent_preset` id that this profile does not declare** — the delegation fails at call time and lists the presets the profile does have.
- **`agent_preset` on `fork`** — rejected: a transport that inherits the parent's context cannot select an independent preset.
- **`output_schema` with `mode = "continuable"`** — invalid combination; a structured result belongs to a one-shot run.
- **A structured result replaces the answer text.** The Harness tells such a child to report by calling a structured-output tool and *not* to finish with a plain answer, so its final text is usually empty. The parent receives the captured value as JSON (with the child's text appended when there is one). If the child completes without producing a value, the call fails with `the child did not produce a value for output_schema`. Want prose as well? Ask for it in the preset's persona row.
- **A depth cap on a provider that cannot enforce one.** The Harness rejects any request carrying `maxDepth` on a provider without the `depthLimit` capability, so `max_depth` on such a definition fails at call time — that is why the plugin sends the Host's own depth only to providers that advertise it.
- **`mode = "continuable"` returns a child id, not an answer — and the answer arrives later, from the child's last message only.** The call resolves as soon as the prompt is queued. When the child's turn ends, the continuation manager delivers a settlement notice into the parent's own request: the outcome line (`Background subagent <id> finished and will do no further work unless you send it more.`, or the matching line for stopped / out of room / declined / failed) followed by the nonempty text blocks of the child's **final** assistant output, or `It left no closing message.` An idle parent is woken by it. Nothing else comes back: reasoning, tool output, and anything said mid-run but not in the closing text stay in the child's session. **So the preset persona of a `continuable` definition must require the child to put its conclusion in its closing message** — otherwise the parent receives a notice with nothing usable in it. Ask for earlier `send_message(agent_id = <parent id>)` only for findings that must reach the parent before the child finishes; the parent id is injected into the child's task prompt, so the parent never writes it. That early message arrives as its own `Agent <childId> sent a message:` turn, **not** as a settlement notice — so tell the child to put only the increment in it and keep the conclusion for the closing message, and expect a delivery confirmation rather than a reply. **A settlement notice also needs the parent to still exist when the child settles**: the runtime has no durable parent mailbox and delivers into the parent's own turn stream, so a one-shot parent run that has already ended silently loses the notice (no replay), while a model-authored `send_message` to a missing parent fails loudly instead. For work whose result must reach a run that will not stay alive, choose `one-shot` instead. The parent keeps the ability to follow up with `send_message` (parameter `agent_id`) on the child, which needs the official subagent control tool; a profile that enables Agent Teams disables that plugin and mounts a same-named tool that addresses teammates by `target` instead (the settlement notice itself still arrives).
- **Model routing on an out-of-process provider** — `acp`/`codex`/`claude-code` accept none of `model`, `agent_preset`, `max_depth`, `output_schema`; the definition then fails at call time with the reason. A definition that asks for **no** capability field works fine on them.
- **This plugin does not support the Agent Teams combination.** If the user asks for team-style multi-agent work, or if the session exposes team tools (`spawn_teammate`, a `send_message` that takes `target`), say that the official Agent Teams bundle replaces the delegation control tools these definitions rely on, and point at the plugin's settings page — it carries a red notice asking for Agent Teams to be turned off. That notice only asks: the user switches the feature off in the Plugins page, and nothing here edits their profile for them.

## 4b. Putting the persona in an Agent Preset

This plugin no longer carries a persona itself: a child's persona is a row in the Agent Preset the definition selects with `agent_preset`. So when the user wants a role to behave a certain way, that text goes into the preset's `@deepseek-ai/dsh-persona` row (`config.prefix`), not into the TOML.

What the preset still decides, and what it means for the mode:

- **`one-shot`** — the parent gets the child's final text as the tool result (or the `output_schema` JSON, when the definition sets one). Ask for the answer directly: what to report, in what order, and what counts as evidence.
- **`continuable`** — the parent gets the child id now and the child's **closing message** later. The persona MUST end the run with the conclusion: state explicitly *"put your conclusion in your final message: findings, evidence, open questions"*. A child that explains everything through tool calls and ends with "done" reports nothing the parent can use. The notice only arrives if the parent is **still alive** when the child settles — there is no durable parent mailbox, and a one-shot parent run that already ended loses it silently; when the result must reach such a run, choose `one-shot` instead. Add the early-return rule only when a mid-run finding must reach the parent: *"when a finding changes what the parent should do next, send it now with `send_message(agent_id = <your parent id>)`; sending does not end your turn."* **Require that early message to carry that one increment only, and keep the full conclusion for the closing message**: an early-return rule that says merely "send something early" makes the child re-send its whole conclusion mid-run, and the parent then receives the same content twice — once as `Agent <childId> sent a message:` and again inside the settlement notice's `Its closing message:`. `send_message` answers with a delivery confirmation, not a reply.
- **Both modes** — never put the task itself in the persona (the caller passes `prompt`), never restate the role rules the caller already has, and keep it to the role, its boundaries, and its reporting format.

A preset is profile configuration, not a definition file, so you usually cannot write it for the user from here: tell them which preset id the definition selects, and what its persona row should say. The full recipe (including how to make a child read-only with a tool set) is in `guide/migrating-to-0.4.md`.

Mention the mode to the user when you finish: for `continuable`, say the result arrives as a settlement notice after the run and that the conclusion lives in the child's closing message.

## 5. Report back

After writing the file, tell the user:

1. the definition name — that is the `agent_type` value to use;
2. when it takes effect (the next delegation; the tool's list updates at the next tool install, i.e. a new task/session, a definition-file change, or a settings write);
3. if you wrote into the project directory: that they must enable **信任项目级定义** in the plugin settings first — and that saving that switch applies to the running session immediately, with no restart;
4. how to try it, e.g. *"delegate to `docs-writer` and ask it to document …"*;
5. for `mode = "continuable"`: that the call returns a child id and the result arrives later as a settlement notice, and that the conclusion is whatever that child puts in its closing message.

## 6. Templates and deeper reference (relative to this skill's package)

- `guide/reviewer.toml` — one-shot review with a structured result and an `agent_preset` that owns the persona and the read-only tool set.
- `guide/explorer.toml` — continuable child routed to a faster model (its comment block shows the settlement-notice contract).
- `README.md` — field reference table, the capability matrix per provider, and the continuable section.
- `guide/migrating-to-0.4.md` — how `persona` and `[tools]` map onto Agent Presets since 0.4.0.
- `guide/technical.md` — parse rules, capability checks with their exact messages, and limitations.
- `guide/settings-explained.md` — what each settings switch changes, with scenarios.
