# pi-herdr-squad

Visible Investigation Squads and coding Worker Squads for [Pi](https://github.com/earendil-works/pi-mono) running inside [Herdr](https://herdr.dev).

- **Investigation Squad:** strictly read-only parallel inspection through `/herdr-squad`.
- **Worker Squad:** parallel coding in one shared checkout through `/herdr-worker-squad`, with exclusive writable-root ownership.

Each squad supports 1-12 agents. Herdr packs agents in input order into at most three tabs, with at most four panes in each tab. The parent must select the smallest useful count from independent work units.

## Requirements

- Pi with extension, skill, and prompt-template support.
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

The parent creates distinct investigation scopes, then calls `herdr_squad_start`, `herdr_squad_wait`, and `herdr_squad_collect` in separate sequential tool rounds.

Investigation children receive only:

```text
read, grep, find, ls, herdr_squad_report
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
```

### Writable-root ownership

A writable root identifies one file or one directory tree. It is not a glob.

- Roots must be repository-relative.
- Absolute paths, parent traversal (`..`), empty roots, duplicates, and Git metadata are rejected.
- Roots owned by different workers cannot be equal or contain one another.
- `.` is valid only when one worker owns the full checkout.
- Workers can read outside their roots, but they must report a handoff instead of changing those files.
- Shared manifests, lockfiles, registries, schemas, generated indexes, and similar integration files should have one owner or move to a later wave.

The child extension resolves existing targets and nearest existing parents through `realpath`. It blocks `edit` and `write` targets outside the canonical checkout, inside Git metadata, or outside the worker's roots.

### Bash is cooperative, not sandboxed

Pi has no built-in shell sandbox. Writable-root enforcement covers `edit` and `write`; it cannot reliably classify every shell command. Worker prompts require bash only for inspection, tests, builds, and validation. Workers must not use it for broad formatters, generators, dependency installation, destructive Git commands, or changes outside their ownership.

Worker squads are for trusted local coding work, not hostile isolation. After collection, the parent must inspect the actual checkout diff and run aggregate validation. A worker report alone is not proof that the checkout is correct.

## Multi-tab behavior

Herdr creates `Math.ceil(agentCount / 4)` tabs and retains them after completion or partial failure for inspection. Background tabs stay unfocused. With `focus: true`, the first squad tab is focused only after all children start. Shared wait and collect tools find reports and terminal fallbacks across all tabs.

## Child model selection

Model precedence for both squad types is:

1. An explicit `model` passed to the start tool.
2. Trusted project config at `.pi/herdr-squad.json`.
3. Global config at `~/.pi/agent/herdr-squad.json`.
4. Pi's normal default.

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

Configuration is read each time a squad starts. Untrusted project configuration is ignored. The selected model applies to every child in one squad.

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
