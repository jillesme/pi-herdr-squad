# pi-herdr-squad

Visible squads of parallel agents for [Pi](https://github.com/earendil-works/pi-mono) running inside [Herdr](https://herdr.dev).

A squad is 1-12 **agents**, each a Pi session in its own Herdr pane, all in the current checkout. Every agent is one of:

- **Read-only** (default): inspects code and, optionally, the web. It cannot run shell commands or modify the checkout.
- **Writable**: a coding agent that owns exclusive `writableRoots` in the shared checkout.

One squad can mix both. Herdr packs agents in input order into at most three tabs, with at most four panes in each tab. The parent session should select the smallest useful number of agents.

## Requirements

- Pi 1.5.0 or newer (uses `agent_before_settle` and sequential tool execution).
- A Pi session in a Herdr-managed pane (`HERDR_ENV=1`). Outside Herdr the squad tools are not registered.
- Herdr's managed Pi state integration. Herdr normally manages `herdr-agent-state.ts` itself.

## Install

From npm:

```bash
pi install npm:pi-herdr-squad
```

For local development:

```bash
pi install /absolute/path/to/pi-herdr-squad
```

Start a new Pi session or run `/reload` after installation.

## Read-only agents

Let the parent select a conservative count:

```text
/herdr-squad auto compare frontend and backend validation
```

Or request an exact count:

```text
/herdr-squad 5 investigate runtime, tests, configuration, observability, and dependencies
```

The parent plans distinct scopes and calls `herdr_squad_start`. The reports come back from `herdr_squad_wait`, or in an automatic follow-up message if the parent keeps working.

Read-only agents receive only:

```text
read, grep, find, ls, herdr_squad_report
+ web_search, fetch_content (when the parent has them)
```

They cannot run shell commands or modify the checkout. The report tool writes only extension-owned JSON under a private temporary run directory.

## Writable agents

Let the parent inspect the repository and select ownership groups:

```text
/herdr-worker-squad auto implement the independent CLI and documentation changes
```

Or request an exact count when that many disjoint work units exist:

```text
/herdr-worker-squad 3 implement the server handler, client component, and isolated documentation update
```

The parent must inspect the task and repository first. It gives every coding agent an exclusive scope and one or more repository-relative `writableRoots` in its `herdr_squad_start` assignment. The parent does not modify files inside a running agent's roots.

Writable agents receive:

```text
read, bash, edit, write, grep, find, ls, herdr_squad_report
+ web_search, fetch_content (when the parent has them)
```

### Writable-root ownership

A writable root identifies one file or one directory tree. It is not a glob.

- Roots should be repository-relative. Absolute paths inside the checkout are converted; paths outside it are rejected.
- Parent traversal (`..`), empty roots, duplicates, and Git metadata are rejected.
- Roots owned by different agents cannot be equal or contain one another.
- `.` is valid only when a single agent owns the full checkout and no other agent has writable roots.
- Agents can read outside their roots, but they must report a handoff instead of changing those files.
- Shared manifests, lockfiles, registries, schemas, generated indexes, and similar integration files should have one owner or move to a later wave.

The agent-side extension resolves existing targets and nearest existing parents through `realpath`. It blocks `edit` and `write` targets outside the canonical checkout, inside Git metadata, or outside the agent's roots. Agents without writable roots have `edit` and `write` blocked entirely.

### Bash is cooperative, not sandboxed

Pi has no built-in shell sandbox. Writable-root enforcement covers `edit` and `write`; it cannot reliably classify every shell command. Agent prompts allow bash only for inspection, tests, builds, and validation. Agents must not use it for broad formatters, generators, dependency installation, destructive Git commands, or changes outside their ownership.

Writable agents are for trusted local coding work, not hostile isolation. After the reports arrive, the parent must inspect the actual checkout diff and run aggregate validation. An agent's report alone is not proof that the checkout is correct.

## Tools

| Tool | Purpose |
| --- | --- |
| `herdr_squad_start` | Launch a squad. An assignment with `writableRoots` creates a writable agent; without it, a read-only agent. |
| `herdr_squad_wait` | Block until every report is in and return the reports. Returns early when a new problem appears (an agent is blocked, finished without a report, or lost its pane) or the timeout passes. A problem the parent was already told about does not end the wait while other agents still run. A timeout does not stop the agents. |
| `herdr_squad_status` | Non-blocking progress check: reports ready and each agent's Herdr status. |
| `herdr_squad_collect` | Read reports on demand, with terminal tails for missing ones: for partial results, after a problem, or to re-read. Agents that are still running are listed as pending. |
| `herdr_squad_steer` | Send a correction or follow-up message to one agent. An agent that already reported reports again. |
| `herdr_squad_close` | Close a squad's tabs. Refuses while agents are running unless `force: true`. Reports stay on disk. |

`herdr_worker_squad_start` remains as a deprecated alias of `herdr_squad_start` for one release.

### Upgrading from 0.3

- `herdr_squad_start` no longer takes `count`; the number of agents is the number of assignments.
- `herdr_worker_squad_start` is an alias. Put `writableRoots` on `herdr_squad_start` assignments instead.
- `herdr_squad_wait` and the completion follow-up now include the reports, so a separate `herdr_squad_collect` call is only needed for partial results.
- The `herdr-worker-squad` skill was merged into `herdr-squad`. Both `/herdr-squad` and `/herdr-worker-squad` still work.

## Report size

Collected output is limited to Pi's tool-output size (50KB). Every agent is guaranteed an equal share of it, and is told that share in its prompt so it can put conclusions first. Shares that short reports do not use go to longer ones. A report that still does not fit is cut inline, with the path of the full report, and the complete collection is saved to `collection.md` in the run directory.

## Completion notifications

The parent does not need to block on `herdr_squad_wait`. While a squad runs, the extension checks it in the background and sends a follow-up message to the parent session: with the reports when every agent has reported, or with a notice when an agent is blocked, finished without a report, or lost its pane. The parent can keep working on independent tasks in the meantime. Partially collected squads stay watched until the remaining agents finish, including agents still starting up. A problem notification does not stop monitoring: each further report sends another notification, and the same problem is never announced twice (including after a wait already returned it or a collect). Transient Herdr CLI failures are retried rather than treated as missing panes.

## Steering

`herdr_squad_steer` sends a message to one agent by label. The parent writes it to the private run directory and the agent's squad extension delivers it as a user message: while the agent works, it arrives after the current tool calls; when the agent is idle or has already reported, it starts a new turn. If the agent already reported, that report is renamed to `report-<agent>.superseded-<time>.json` and the squad goes back to running, so the parent receives the updated report when it arrives. Reports acknowledge the latest steering revision only after the agent's model receives the message, so an in-flight report cannot satisfy a newer follow-up. A delivery acknowledgment means Pi accepted the message, not that the agent has finished acting on it. You can also type into an agent's pane directly.

## Parent context

Pass `inheritContext: true` to `herdr_squad_start` to include the parent's current conversation branch in every agent prompt as background. It is serialized the same way compaction serializes messages (tool results are cut to 2,000 characters, thinking is omitted) and only the most recent ~40KB is kept. Agents are told it is background, not instructions. It is off by default because it adds the same tokens to every agent.

## Agents

- **Web tools:** agents get the parent's `web_search` and `fetch_content` tools when they exist (for example from `pi-simple-web-tools`). Pass `webTools: false` to `herdr_squad_start` to withhold them.
- **Skills and context files:** agents load skills and context files (`AGENTS.md`), so domain skills apply to their work. Prompt templates are disabled. The agent prompt tells agents not to start squads themselves.
- **Report reminder:** an agent that ends its run without calling `herdr_squad_report` is reminded to report (up to twice) in the same run, so the parent does not get an empty result.
- **Report shape:** only `findings` is required (up to 20,000 characters). `evidence`, `risksOrUnknowns`, and `recommendedNextStep` are optional. Writable agents also report `changedFiles` and `validation`; `changedFiles` may use absolute paths inside the checkout and are stored repository-relative.

## Multi-tab behavior

Herdr creates `Math.ceil(agentCount / 4)` tabs and retains them after completion or partial failure for inspection until `herdr_squad_close` is called. Squads track tabs by Herdr tab ID, so renaming a squad tab does not break wait or collect. Background tabs stay unfocused. With `focus: true`, the first squad tab is focused only after all agents start. Wait and collect find reports and terminal fallbacks across all tabs.

## Agent model selection

Model precedence is:

1. A `model` on an individual assignment (that agent only).
2. An explicit `model` passed to `herdr_squad_start`.
3. Trusted project config at `.pi/herdr-squad.json`.
4. Global config at `~/.pi/agent/herdr-squad.json`.
5. Pi's normal default.

Configuration shape:

```json
{
  "defaultModel": "openai-codex/gpt-5.6-terra"
}
```

A trusted project can bypass the global model and use Pi's default:

```json
{
  "defaultModel": null
}
```

Configuration is read each time a squad starts. The project config path is relative to the session's working directory, not searched upward from a subdirectory. Untrusted project configuration is ignored. The squad model applies to every agent without an assignment `model`; mix models in one squad by setting `model` on individual assignments (for example a cheaper model for a mechanical scope and a stronger one for a subtle one).

Use the exact identifier recognized by Pi, usually in `provider/model` form:

```bash
pi --list-models
```

Pi remains responsible for model resolution, credentials, and availability.

## State compatibility

Squad state is stored in Pi session entries. Version-1 read-only squad snapshots are migrated in memory when a session reloads, so existing squad IDs remain usable by wait and collect.

Task text is stored in mode-`0600` prompt files and is never interpolated directly into shell commands. Per-agent identity tokens protect report submission.

## Package contents

- `agent/extensions/herdr-squad/` — parent orchestration (`index.ts`), agent-side reporting, steering, and write enforcement (`agent.ts`), and ownership checks.
- `agent/skills/herdr-squad/SKILL.md` — planning, ownership, and coordination policy.
- `agent/prompts/herdr-squad.md` — `/herdr-squad` (read-only agents).
- `agent/prompts/herdr-worker-squad.md` — `/herdr-worker-squad` (coding agents with writable roots).

## Development checks

```bash
npm run check
npm run pack:check
```

The package has no third-party runtime dependencies. Pi-provided APIs are peer dependencies.

## License

MIT
