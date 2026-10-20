# pi-team

A pi extension that builds a team of agents from a `team.yaml` config. Every
agent gets its own model, role prompt, and tool permissions, and runs in its
own `pi` subprocess with an isolated context window. The active session
dispatches work through the `team` tool; results stream back into the
transcript.

No dependencies: YAML is parsed with pi's own `parseFrontmatter`.

## Install

From this repository (once pushed):

```bash
# personal: available in every project (written to ~/.pi/agent/settings.json)
pi install git:github.com/oorbt/pi-team

# project-local: recorded in .pi/settings.json, loads after project trust
pi install -l git:github.com/oorbt/pi-team
```

Or try it for one invocation without installing:

```bash
pi -e git:github.com/oorbt/pi-team
```

Update after pushing changes: `pi update --extensions`.
Remove with: `pi remove git:github.com/oorbt/pi-team`.

## Config: `.slai/team.yaml`

Searched upward from the working directory; falls back to `~/.pi/agent/team.yaml`.

```yaml
version: 1
project:
  name: minion
  description: What this project is (injected into every agent's prompt)
  main_branch: main
  integration_branch: slai/integration
defaults:                      # applied to every agent unless overridden
  permission_mode: auto        # auto | read_only | none
  max_turns_per_task: 40       # agent subprocess is stopped beyond this
  max_concurrent_agents: 5     # parallel-mode concurrency cap
  require_review: true         # adds review guidance to engineer/orchestrator prompts
  thinking: medium             # off|minimal|low|medium|high|xhigh|max
models:                        # aliases -> model patterns (as accepted by --model)
  opus: opus
  haiku: haiku
agents:
  - id: orch                   # required, unique: how you address the agent
    role: orchestrator         # required: picks the prompt template
    model: opus                # alias from `models`, or a direct pattern
    # focus: backend           # area of responsibility
    # persona: ...             # character description (focus_group agents)
    # prompt: |                # full system-prompt override (replaces the role template)
    # tools: [read, ls, grep]  # explicit allowlist; [] means no tools
    # permission_mode: read_only
    # thinking: high
    # max_turns: 20
    # description: ...         # one-liner shown to the model; defaults to the role's
```

### Built-in roles

`orchestrator`, `product_manager`, `principal_engineer`, `engineer`,
`reviewer`, `researcher`, `writer`, `focus_group`, `tester`, `devops`.

Any other role key works too: it gets a generic prompt ("You are a team member
with the role ...") plus persona/focus/project context.

Role defaults when an agent sets neither `tools` nor `permission_mode`:

| Roles | Access |
|---|---|
| orchestrator, product_manager, principal_engineer, reviewer, researcher | read-only (`read, ls, find, grep`) |
| engineer, writer, tester, devops | full (default tool set) |
| focus_group | no tools |

## The `team` tool

```
team({ agent: "pm", task: "..." })                          # single
team({ tasks: [{ agent, task }, ...] })                     # parallel
team({ chain: [{ agent, task: "... {previous} ..." }] })    # sequential
```

- Each entry may set `cwd` to run the agent in another directory.
- Chain steps substitute `{previous}` with the prior step's final output.
- Parallel caps: 8 tasks, `defaults.max_concurrent_agents` at a time (default 4),
  50 KB of model-visible output per task (full output kept in tool details).
- Per-agent and total usage (turns, tokens, cost) is tracked and included in
  the tool result; Ctrl+C aborts propagate to the subprocesses.

## Commands

| Command | Action |
|---|---|
| `/team` | Show the roster (ids, roles, models, focus/persona) |
| `/team reload` | Reload extensions and pick up config changes |
| `/team run <id> <task...>` | Dispatch a task directly from the user |

## Files

| File | Purpose |
|---|---|
| `extensions/team/index.ts` | Entry point: registers the `team` tool and `/team` command |
| `extensions/team/config.ts` | Discovers, parses, and validates team.yaml |
| `extensions/team/roles.ts` | Role prompt library and system-prompt assembly |
| `extensions/team/runner.ts` | Spawns per-agent `pi` subprocesses, tracks usage/turns |
| `extensions/team/render.ts` | TUI rendering for calls and results |
