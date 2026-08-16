# Herdr Investigation and Worker Squads Plan

## Goal

Extend `pi-herdr-squad` with two compatible squad types:

1. **Investigation Squad** — the existing read-only workflow.
2. **Worker Squad** — full coding workers in one shared checkout, with exclusive file ownership.

Keep the existing `/herdr-squad` interface. Add `/herdr-worker-squad` without changing the existing investigation workflow.

Both squad types can use from 1 through 12 agents. Herdr layout limits are:

- maximum 4 agent panes per tab;
- maximum 3 tabs per squad;
- maximum 12 agents per squad.

The parent agent must inspect the task first, find independent work units, and select the smallest useful agent count. It must not start 12 agents only because capacity is available.

## Confirmed product decisions

- Keep the package name `pi-herdr-squad`.
- Keep `/herdr-squad` as the read-only Investigation Squad command.
- Add `/herdr-worker-squad` as the shared-checkout Worker Squad command.
- Keep `herdr_squad_start` for investigation squads.
- Add `herdr_worker_squad_start` for worker squads.
- Share `herdr_squad_wait` and `herdr_squad_collect` between both types.
- Use a shared checkout for workers. Do not create Git worktrees.
- Give workers the normal coding tools, including bash, edit, and write.
- Coordinate writes through exclusive repository-relative writable roots.
- Use later waves for files that depend on changes from more than one worker.
- Preserve compatibility with existing sessions, prompts, and tool callers.

## Current implementation context

### Parent orchestration

`agent/extensions/herdr-squad/index.ts` currently:

- registers `herdr_squad_start`, `herdr_squad_wait`, and `herdr_squad_collect`;
- accepts from 1 through 4 assignments;
- creates one Herdr tab;
- creates a four-pane maximum layout in that tab;
- starts every child in `ctx.cwd`;
- gives children only `read,grep,find,ls,herdr_squad_report`;
- stores one `tabId`, `tabLabel`, and `rootPaneId` in squad state;
- refreshes and reads panes from one tab;
- persists squad snapshots through `pi.appendEntry()`.

### Child behavior

`agent/extensions/herdr-squad/child.ts` currently:

- detects squad children through `HERDR_SQUAD_*` environment variables;
- validates the temporary run directory, manifest, agent ID, and token;
- registers `herdr_squad_report`;
- writes one extension-owned JSON report and terminates the child turn.

`agent/extensions/herdr-squad/shared.ts` currently:

- defines state, manifest, and report types;
- builds a strictly read-only child prompt;
- validates structured reports;
- defines shell quoting and report-file helpers.

### User-facing resources

- `agent/skills/herdr-squad/SKILL.md` defines read-only planning and synthesis.
- `agent/prompts/herdr-squad.md` provides `/herdr-squad`.
- `README.md` documents one read-only squad type.
- `package.json` exposes one extension, one skill, and one prompt.
- `config.ts` resolves one model for all children and can remain shared.

## Public interfaces

### Investigation start tool

Keep `herdr_squad_start` compatible. Raise its limits from 4 to 12:

```ts
{
  task: string;
  count: 1..12;
  assignments: Array<{
    label: string;
    scope: string;
    prompt: string;
  }>;
  title?: string;
  model?: string;
  focus?: boolean;
}
```

Its children remain strictly read-only.

### Worker start tool

Add `herdr_worker_squad_start`:

```ts
{
  task: string;
  count: 1..12;
  assignments: Array<{
    label: string;
    scope: string;
    writableRoots: string[];
    prompt: string;
  }>;
  title?: string;
  model?: string;
  focus?: boolean;
}
```

Worker tools:

```text
read,bash,edit,write,grep,find,ls,herdr_squad_report
```

`count` must equal `assignments.length`. The start result must report the squad type, tabs, agents, and writable roots.

### Shared wait and collect tools

Keep these names and sequence rules:

1. Start one squad.
2. Wait with `herdr_squad_wait` in a separate tool round.
3. Collect with `herdr_squad_collect` in a separate tool round.

The opaque `squadId` identifies either squad type. State determines how collection output is formatted.

## Parent planning policy

### Investigation Squad

The parent selects one agent for each independent investigation domain. Overlapping read access is allowed, but scopes must have different responsibilities.

### Worker Squad

Before launch, the parent must use its own tools to inspect the task and relevant repository structure. It must then:

1. List the files or directory roots that each work unit can modify.
2. Put work that needs the same writable root in one assignment.
3. Choose at most one worker for each exclusive ownership group.
4. Use no more than 12 workers.
5. Keep the parent in coordinator mode while workers run. The parent must not modify owned files before collection completes.
6. Assign shared integration files to one worker or defer them to a later wave.
7. Start a later worker squad when integration depends on results from the first wave.
8. Review the final checkout diff and run appropriate aggregate validation after collection.

Examples of shared files that often need a later integration wave:

- package manifests and lockfiles;
- central export or registry files;
- generated indexes;
- shared schemas;
- migration ordering files;
- changelogs and release metadata.

## Writable-root rules

`writableRoots` are ownership declarations, not shell globs.

- Each root is relative to the squad checkout.
- A root can identify one file or one directory tree.
- `.` can be used only when one worker owns the full checkout.
- Absolute paths are invalid.
- Paths containing a parent traversal (`..`) are invalid.
- Git metadata such as `.git` is never writable.
- Empty and duplicate roots are invalid.
- Roots owned by different workers cannot be equal.
- A root cannot be an ancestor or descendant of another worker's root.
- One worker can own multiple separate roots.
- Workers can read files outside their writable roots.
- A worker that needs another root must report a handoff instead of modifying it.

Normalize separators and path segments before overlap checks. Use path-segment containment, not raw string prefixes, so `src/a.ts` does not conflict with `src/a.ts.snap`.

## Write coordination and safety boundary

The child extension must intercept `edit` and `write` tool calls for worker children.

For each target path:

1. Resolve the path against the canonical checkout root.
2. Resolve existing files and directories through `realpath`.
3. For a new path, resolve its nearest existing parent through `realpath`.
4. Block a target outside the checkout.
5. Block Git metadata.
6. Block a target outside the worker's declared writable roots.

The report tool remains allowed to write only into the extension-owned temporary run directory.

### Bash limitation

Pi has no built-in sandbox. A general shell command cannot be reliably classified as read-only or restricted to writable roots. The worker prompt must therefore require these rules:

- use `edit` and `write` for source-file changes;
- use bash for inspection, tests, builds, and validation;
- do not use bash to change files owned by another worker;
- do not run broad formatters, generators, dependency installers, Git reset/clean/stash/checkout, or other commands that can rewrite unrelated files;
- run a formatter or generator only when all of its possible output is inside the worker's ownership;
- preserve pre-existing user changes;
- do not commit unless the parent task explicitly requires a commit.

The documentation must state that writable-root enforcement covers `edit` and `write`. Bash remains a cooperative policy boundary. The shared checkout is for trusted local coding work, not hostile isolation.

## Multi-tab layout

For `N` agents, create `Math.ceil(N / 4)` tabs. Pack assignments in input order, four per tab.

Each tab uses the current layout pattern:

- agent 1: root pane;
- agent 2: right split;
- agent 3: lower-left split;
- agent 4: lower-right split.

Suggested tab labels:

```text
<title> 1/3 · sq-<short-id>
<title> 2/3 · sq-<short-id>
<title> 3/3 · sq-<short-id>
```

Requirements:

- create every tab in the validated parent workspace;
- use the same shared checkout cwd for all worker panes;
- keep background tabs unfocused;
- when `focus: true`, focus the first squad tab after all children start;
- retain created tabs after completion or partial failure for user inspection;
- return all created tab IDs and labels in public tool details.

If creation fails after one or more tabs exist, save a partial squad state. Remove the private run directory only when no tab was created.

## State and compatibility

Introduce a squad kind:

```ts
type SquadKind = "investigation" | "worker";
```

Replace single-tab state with:

```ts
interface SquadTabState {
  tabId: string;
  tabLabel: string;
  rootPaneId: string;
}

interface SquadAgentState {
  // existing fields
  tabId: string;
  tabLabel: string;
  writableRoots?: string[];
}

interface SquadState {
  version: 2;
  kind: SquadKind;
  tabs: SquadTabState[];
  // existing shared fields
}
```

Add the checkout root, squad kind, and optional writable roots to the manifest. Continue to use per-agent identity tokens.

On `session_start`, migrate version-1 snapshots in memory:

- set `kind` to `investigation`;
- convert `tabId`, `tabLabel`, and `rootPaneId` into a one-item `tabs` array;
- attach the old tab identity to each agent;
- use empty or absent writable roots.

Do not make existing investigation squad IDs unusable after reload.

The report format can remain version 1 with backward-compatible optional fields. Do not reject reports created by version 0.1.3.

## Pane refresh and lifecycle

Refactor pane refresh to support all tabs:

1. List workspace tabs once.
2. Revalidate each expected tab by its stored identity and unique label.
3. List workspace panes once.
4. Index panes by tab and pane label.
5. Refresh each agent only inside its assigned tab.
6. Report missing tabs and panes with their agent labels.

Wait behavior remains report-driven:

- complete when every valid structured report exists;
- return partial when a tab or pane disappears;
- return partial when a child is blocked or terminates without a report;
- retain bounded overall timeout behavior;
- collect structured reports and terminal tails from every tab.

## Child prompts

### Investigation child

Keep the present read-only boundaries and final-report requirement.

### Worker child

The prompt must include:

- parent task;
- worker label;
- exclusive functional scope;
- exact writable roots;
- specific implementation instructions;
- shared-checkout warning;
- requirement to preserve unrelated and pre-existing changes;
- requirement to use edit/write for modifications;
- bash restrictions;
- handoff behavior for files outside ownership;
- required validation where practical;
- final structured report requirement.

A worker must not wait for or coordinate directly with another worker. The parent coordinates separate waves.

## Structured reports and collection

Extend `herdr_squad_report` with optional worker data:

```ts
changedFiles?: Array<{
  path: string;
  summary: string;
}>;
validation?: Array<{
  command: string;
  result: string;
}>;
```

Keep the existing fields:

- `findings`;
- `evidence`;
- `risksOrUnknowns`;
- `recommendedNextStep`.

For worker reports:

- normalize changed paths;
- include files created or modified;
- state when no files changed;
- include validation commands and results;
- identify handoffs and files the worker intentionally did not change.

Collection output must show:

- squad kind;
- all tab labels;
- model and model source;
- structured-report count;
- each worker's writable roots;
- findings or completion summary;
- changed files;
- validation;
- risks and handoffs;
- terminal fallback when a report is missing.

The parent skill must not treat a worker report as proof that the checkout is correct. It must inspect the final diff and run aggregate checks.

## Skill and prompt resources

### Existing investigation resources

Keep:

- skill name `herdr-squad`;
- prompt `/herdr-squad`;
- read-only language and synthesis format;
- existing natural-language trigger for explicit investigation squads.

Update capacity guidance from 1–4 to 1–12 and explain four panes per tab and three tabs maximum.

### New worker resources

Add:

- `agent/skills/herdr-worker-squad/SKILL.md`;
- `agent/prompts/herdr-worker-squad.md`.

The worker skill must describe:

- when to use a worker squad;
- required initial repository inspection;
- agent-count selection by exclusive ownership groups;
- `writableRoots` planning;
- multi-wave integration;
- no parent writes while children run;
- mandatory start/wait/collect sequence;
- final diff review and aggregate validation;
- shared-checkout and bash limitations.

Suggested command syntax remains compatible with the investigation prompt:

```text
/herdr-worker-squad auto <task>
/herdr-worker-squad <1-12> <task>
```

The parent converts `auto` into an exact count before it calls `herdr_worker_squad_start`.

## Relevant file changes

### Existing files

- `agent/extensions/herdr-squad/index.ts`
  - add worker start schema and tool;
  - raise shared capacity to 12;
  - add multi-tab creation and refresh;
  - share launch logic without changing the existing tool contract;
  - include kind, tabs, ownership, and worker report data in output.

- `agent/extensions/herdr-squad/shared.ts`
  - add squad kind, tab state, ownership, and state migration types;
  - add investigation and worker prompt builders;
  - extend manifest and report validation.

- `agent/extensions/herdr-squad/child.ts`
  - detect squad kind;
  - validate worker ownership from the manifest;
  - gate edit/write paths;
  - extend the final report tool for worker results.

- `agent/extensions/herdr-squad/config.ts`
  - keep model resolution shared;
  - no functional change is expected unless types move.

- `agent/skills/herdr-squad/SKILL.md`
  - retain investigation semantics;
  - update capacity and multi-tab planning.

- `agent/prompts/herdr-squad.md`
  - retain `/herdr-squad` and update the accepted count range.

- `README.md`
  - remove the temporary TODO during implementation;
  - document Investigation Squad and Worker Squad separately;
  - document shared checkout, ownership, capacity, and bash limitations;
  - preserve existing installation and model guidance.

- `package.json`
  - update description and keywords if useful;
  - include the worker skill and prompt in `files`;
  - register the worker skill and prompt in `pi`;
  - keep the package name and existing resource paths.

### New files

- `agent/skills/herdr-worker-squad/SKILL.md`
- `agent/prompts/herdr-worker-squad.md`

Add a small ownership helper file only if path normalization and containment make `child.ts` or `index.ts` difficult to review. Do not add a dependency for path matching.

## Implementation order

1. Add shared constants, squad kind, multi-tab state, and version-1 migration.
2. Refactor current investigation launch and pane refresh to use `tabs[]` without changing behavior.
3. Raise investigation capacity to 12 and create up to three tabs.
4. Add writable-root normalization and cross-assignment overlap validation.
5. Add `herdr_worker_squad_start` and the full worker tool allowlist.
6. Add child edit/write ownership gates and worker prompts.
7. Extend reports and collection formatting.
8. Add the worker skill and prompt.
9. Update README and package metadata.
10. Run existing validation and perform a manual Herdr smoke check.

## Validation

Do not add new automated tests unless separately requested. Run existing checks:

```bash
npm run check
npm run pack:check
```

Manual smoke checks inside a Herdr-managed Pi pane:

1. Start one investigation agent and confirm the old workflow still works.
2. Start five investigation agents and confirm two tabs are created and collected.
3. Start one worker with `writableRoots: ["."]` and confirm edit/write work.
4. Confirm a worker edit outside its ownership is blocked.
5. Confirm overlapping worker roots are rejected before tab creation.
6. Start five workers with disjoint roots and confirm two tabs use one checkout.
7. Confirm wait and collect find reports across all tabs.
8. Confirm a partial launch remains collectable.
9. Reload the extension and confirm a version-1 investigation snapshot still restores.
10. Inspect the final Git diff and confirm no worker changed another worker's owned files.

## Out of scope

- Git worktree creation or automatic merging.
- Automatic commits, stashes, resets, or checkout cleanup.
- Shell-command parsing as a security boundary.
- Direct child-to-child communication.
- More than 12 agents or more than three tabs per squad.
- Different models per worker in one squad.
- Automatic conflict resolution.

## Acceptance criteria

- Existing `/herdr-squad` use remains valid and read-only.
- Existing `herdr_squad_start` callers remain valid.
- `/herdr-worker-squad` starts full coding workers in the shared checkout.
- The parent selects 1–12 agents from independent ownership groups.
- The extension creates no more than four panes per tab and no more than three tabs.
- Worker assignments with overlapping writable roots fail before any tab is created.
- Worker edit/write calls outside ownership are blocked.
- Wait and collect work across every squad tab.
- Worker reports include changed files, validation, and handoffs.
- Old persisted investigation squads can still be restored and collected.
- Documentation clearly states that bash follows a cooperative policy and is not a sandbox.

## Clean-session kickoff

Use this request in a new session:

```text
Implement PLAN.md in order. Preserve the existing /herdr-squad investigation interface. Add /herdr-worker-squad with shared-checkout writable-root ownership, full worker tools, and support for 1-12 agents across at most three four-pane tabs. Do not overwrite unrelated changes. Run the existing checks when complete.
```
