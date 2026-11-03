# pi-herdr-squad

Visible Investigation Squads and coding Worker Squads for [Pi](https://github.com/earendil-works/pi-mono) running inside [Herdr](https://herdr.dev).

- **Investigation Squad:** strictly read-only parallel inspection through `/herdr-squad`.
- **Worker Squad:** parallel coding in one shared checkout through `/herdr-worker-squad`, with exclusive writable-root ownership.

Each squad supports 1-12 agents. Herdr packs agents in input order into at most three tabs, with at most four panes in each tab. The parent must select the smallest useful count from independent work units.

## Requirements

- Pi 1.5.0 or newer (uses `agent_before_settle` and sequential tool execution).
- A Pi session in a Herdr-managed pane (`HERDR_ENV=1`).
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

## Investigation Squads

Let the parent select a conservative count:

```text
/herdr-squad auto compare frontend and backend validation
```

Or request an exact count:

```text
/herdr-squad 5 investigate runtime, tests, configuration, observability, and dependencies
```

The parent creates distinct investigation scopes, then calls `herdr_squad_start`, `herdr_squad_wait` (or continues working until notified), and `herdr_squad_collect` in separate tool rounds.

Investigation children receive only:

```text
read, grep, find, ls, herdr_squad_report
+ web_search, fetch_content (when the parent has them)
```

They cannot run shell commands or modify the checkout. The report tool writes only extension-owned JSON under a private temporary run directory.

## Worker Squads

Let the parent inspect the repository and select ownership groups:

```text
/herdr-worker-squad auto implement the independent CLI and documentation changes
```

Or request an exact count when that many disjoint work units exist:

```text
/herdr-worker-squad 3 implement the server handler, client component, and isolated documentation update
```

The parent must inspect the task and repository first. It gives every worker an exclusive functional scope and one or more repository-relative `writableRoots`, then calls `herdr_worker_squad_start`, `herdr_squad_wait`, and `herdr_squad_collect` in separate tool rounds. The parent does not modify worker-owned files while workers run.

Worker children receive:

```text
read, bash, edit, write, grep, find, ls, herdr_squad_report
+ web_search, fetch_content (when the parent has them)
```

### Writable-root ownership

A writable root identifies one file or one directory tree. It is not a glob.

- Roots should be repository-relative. Absolute paths inside the checkout are converted; paths outside it are rejected.
- Parent traversal (`..`), empty roots, duplicates, and Git metadata are rejected.
- Roots owned by different workers cannot be equal or contain one another.
- `.` is valid only when one worker owns the full checkout.
- Workers can read outside their roots, but they must report a handoff instead of changing those files.
- Shared manifests, lockfiles, registries, schemas, generated indexes, and similar integration files should have one owner or move to a later wave.

The child extension resolves existing targets and nearest existing parents through `realpath`. It blocks `edit` and `write` targets outside the canonical checkout, inside Git metadata, or outside the worker's roots.

### Bash is cooperative, not sandboxed

Pi has no built-in shell sandbox. Writable-root enforcement covers `edit` and `write`; it cannot reliably classify every shell command. Worker prompts require bash only for inspection, tests, builds, and validation. Workers must not use it for broad formatters, generators, dependency installation, destructive Git commands, or changes outside their ownership.

Worker squads are for trusted local coding work, not hostile isolation. After collection, the parent must inspect the actual checkout diff and run aggregate validation. A worker report alone is not proof that the checkout is correct.

## Tools

| Tool | Purpose |
| --- | --- |
| `herdr_squad_start` | Launch a read-only investigation squad. |
| `herdr_worker_squad_start` | Launch a shared-checkout worker squad. |
| `herdr_squad_wait` | Block until every report is in, a new problem appears (a child is blocked, finished without a report, or lost its pane), or the timeout passes. A problem the parent was already told about does not end the wait while other agents still run. A timeout does not stop the agents. |
| `herdr_squad_status` | Non-blocking progress check: reports ready and each agent's Herdr status. |
| `herdr_squad_collect` | Collect structured reports, with terminal tails for missing ones. Agents that are still running are listed as pending. |
| `herdr_squad_steer` | Send a correction or follow-up message to one child. A child that already reported reports again. |
| `herdr_squad_close` | Close a squad's tabs. Refuses while agents are running unless `force: true`. Reports stay on disk. |

## Completion notifications

The parent does not need to block on `herdr_squad_wait`. While a squad runs, the extension checks it in the background and sends a follow-up message to the parent session when every report is ready, or when a child is blocked, finished without a report, or lost its pane. The parent can keep working on independent tasks and collect when notified. Partially collected squads stay watched until the remaining agents finish, including children still starting up. A problem notification does not stop monitoring: each further report sends another notification, and the same problem is never announced twice (including after a wait already returned it or a collect). Transient Herdr CLI failures are retried rather than treated as missing panes.

## Steering

`herdr_squad_steer` sends a message to one child by label. The parent writes it to the private run directory and the child's squad extension delivers it as a user message: while the child works, it arrives after the current tool calls; when the child is idle or has already reported, it starts a new turn. If the child already reported, that report is renamed to `report-<agent>.superseded-<time>.json` and the squad goes back to running, so the parent is notified again when the updated report arrives. Reports acknowledge the latest steering revision only after the child model receives the message, so an in-flight report cannot satisfy a newer follow-up. A delivery acknowledgment means Pi accepted the message, not that the child has finished acting on it. You can also type into a child's pane directly.

## Parent context

Pass `inheritContext: true` to a start tool to include the parent's current conversation branch in every child prompt as background. It is serialized the same way compaction serializes messages (tool results are cut to 2,000 characters, thinking is omitted) and only the most recent ~40KB is kept. Children are told it is background, not instructions. It is off by default because it adds the same tokens to every child.

## Children

- **Web tools:** children get the parent's `web_search` and `fetch_content` tools when they exist (for example from `pi-simple-web-tools`). Pass `webTools: false` to a start tool to withhold them.
- **Skills and context files:** children load skills and context files (`AGENTS.md`), so domain skills apply to their work. Prompt templates are disabled. The child prompt tells children not to start squads themselves.
- **Report reminder:** a child that ends its run without calling `herdr_squad_report` is reminded to report (up to twice) in the same run, so the parent does not get an empty result.
- **Report shape:** only `findings` is required (up to 20,000 characters). `evidence`, `risksOrUnknowns`, and `recommendedNextStep` are optional. Worker `changedFiles` may use absolute paths inside the checkout; they are stored repository-relative.

## Multi-tab behavior

Herdr creates `Math.ceil(agentCount / 4)` tabs and retains them after completion or partial failure for inspection until `herdr_squad_close` is called. Squads track tabs by Herdr tab ID, so renaming a squad tab does not break wait or collect. Background tabs stay unfocused. With `focus: true`, the first squad tab is focused only after all children start. Shared wait and collect tools find reports and terminal fallbacks across all tabs.

## Child model selection

Model precedence for both squad types is:

1. A `model` on an individual assignment (that agent only).
2. An explicit `model` passed to the start tool.
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

Configuration is read each time a squad starts. The project config path is relative to the session's working directory, not searched upward from a subdirectory. Untrusted project configuration is ignored. The squad model applies to every child without an assignment `model`; mix models in one squad by setting `model` on individual assignments (for example a cheaper model for a mechanical scope and a stronger one for a subtle one).

Use the exact identifier recognized by Pi, usually in `provider/model` form:

```bash
pi --list-models
```

Pi remains responsible for model resolution, credentials, and availability.

## State compatibility

Squad state is stored in Pi session entries. Version-1 read-only squad snapshots are migrated in memory when a session reloads, so existing investigation squad IDs remain usable by wait and collect.

Task text is stored in mode-`0600` prompt files and is never interpolated directly into shell commands. Per-agent identity tokens protect report submission.

## Package contents

- `agent/extensions/herdr-squad/` — shared parent orchestration, ownership checks, and child reporting.
- `agent/skills/herdr-squad/SKILL.md` — Investigation Squad policy.
- `agent/skills/herdr-worker-squad/SKILL.md` — Worker Squad ownership and coordination policy.
- `agent/prompts/herdr-squad.md` — `/herdr-squad`.
- `agent/prompts/herdr-worker-squad.md` — `/herdr-worker-squad`.

## Development checks

```bash
npm run check
npm run pack:check
```

The package has no third-party runtime dependencies. Pi-provided APIs are peer dependencies.

## License

MIT
