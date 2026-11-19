---
name: herdr-squad
description: Create and coordinate a visible Herdr squad of 1-12 Pi agents across up to three tabs. Agents are read-only investigators by default; agents given exclusive writable roots can edit a shared checkout in parallel. Use only when the user explicitly asks for a Herdr squad, multiple visible agents, parallel investigation, or parallel coding agents. Plans distinct scopes and ownership, launches through herdr_squad_start, receives reports, then synthesizes findings or reviews the final diff.
---

# Herdr Squad

Use this workflow only for an explicit request for visible or parallel Herdr agents. Do normal work when the user did not request a squad or multiple agents.

A squad is a set of **agents**. Each agent is one of:

- **Read-only** (default): `read`, `grep`, `find`, `ls`. No shell. It cannot run tests or diagnostics; never imply that it did.
- **Writable** (its assignment sets `writableRoots`): adds `bash`, `edit`, and `write`. It may modify only its own roots.

One squad can mix both, for example two writable agents and a read-only reviewer of existing code.

## Preconditions

- The squad tools exist only inside a Herdr-managed Pi pane (`HERDR_ENV=1`).
- Every agent also gets `herdr_squad_report` and, when the parent has them, the web tools `web_search` and `fetch_content`. Pass `webTools: false` to withhold web access.
- Agents load skills and context files, so domain skills apply to their work.
- One squad supports 1-12 agents. Herdr packs at most four panes in each tab and creates at most three tabs.
- All agents share one checkout and see each other's changes as they happen.
- Writable roots are enforced for `edit` and `write`. Bash is a cooperative policy boundary, not a sandbox. Use writable agents only for trusted local coding work.

## Planning

Inspect the task before launch. Select one agent for each independent unit of work. Overlapping read access is allowed, but each scope must have a different responsibility.

Honor an explicit count from 1 through 12 only when that many useful units exist. For `auto`, choose the smallest useful count. Do not start extra agents only because capacity is available. Never use duplicate assignments such as “investigate the issue” or “review everything.”

Each prompt must be self-contained, stay inside its scope, and request concrete evidence. Agents see only `task` and their own assignment unless `inheritContext` is set.

### Planning writable agents

Before launch, inspect the repository status, relevant directories, and shared integration files yourself. Do not delegate this ownership analysis. Then:

1. List the files or directory roots each work unit can modify.
2. Put work that needs the same root in one assignment.
3. Assign shared integration files to one agent or defer them to a later wave.
4. Keep dependent integration work for a later squad when it needs changes from several agents.

Common later-wave files include manifests, lockfiles, central registries, shared schemas, generated indexes, migrations, changelogs, and release metadata.

Rules for `writableRoots`:

- A root identifies one file or one directory tree. It is not a shell glob.
- Roots of different agents must not be equal, nested, or otherwise overlap.
- Prefer repository-relative paths. Absolute paths inside the checkout are converted. Paths outside the checkout, `..`, duplicates, and `.git` paths are rejected.
- Use `.` only when a single agent owns the full checkout and no other agent has writable roots.
- An agent can read outside its roots but must report a handoff instead of writing there.

### Present the plan

Before launch, present:

- a short tab title and the number of agents;
- the model choice, including any per-assignment models;
- each label and scope, and for writable agents each exact writable root;
- one sentence that explains why the responsibilities, and any ownership, do not overlap.

## Model selection

- Pass an exact user-requested model string in `herdr_squad_start.model`.
- Ask for Pi's exact model identifier if the name is ambiguous.
- Otherwise omit `model`. The extension resolves project config, global config, then Pi's default.
- The squad model applies to every agent. To mix models, set `model` on individual assignments: a cheaper or faster model for mechanical scopes, a stronger one for subtle analysis or tricky logic. Only use model identifiers the user asked for or that appear in their configuration.
- Pass `inheritContext: true` when assignments depend on context discussed earlier in the conversation (decisions, constraints, prior findings) that would be long to restate. Leave it off for self-contained scopes; it adds the same tokens to every agent.

## Tool sequence

1. Call `herdr_squad_start` with the full parent `task` and one assignment per agent. Retain the returned `squadId`.
2. Then choose one mode:
   - **Wait mode** (nothing else useful to do): call `herdr_squad_wait` with a generous timeout. When every agent has reported, it returns the reports. A timeout does not stop the agents.
   - **Background mode** (independent work remains): keep working. An automatic follow-up message delivers the reports when the squad finishes, or tells you when an agent needs attention. Use `herdr_squad_status` for a non-blocking progress check.
   - Never poll with short `herdr_squad_wait` timeouts.
3. While writable agents run, stay in coordinator mode: do not modify any file inside a running agent's writable roots.
4. Call `herdr_squad_collect` only when you need partial results, when a wait or follow-up reports a problem (blocked agent, missing report, lost pane), or to re-read reports. Agents listed as still running keep ownership of their roots.
5. To correct a running agent, or ask a finished agent a follow-up within its scope and roots, call `herdr_squad_steer` instead of starting a new squad. A steered agent reports again, and its updated report arrives the same way as the first.
6. When every report is structured and handled, call `herdr_squad_close`. Leave the tabs open when reports are missing, blocked, or malformed so the user can inspect them.

Each agent is told how much of its report the parent sees inline (an equal share of the output limit). Longer reports are truncated inline and the full text is saved to the path shown.

Never create tabs or panes with raw `herdr` commands when squad tools are available. Never ask one agent to wait for or coordinate with another; the parent coordinates waves.

## After the reports arrive

For read-only agents, organize the answer around the parent task, not around the agents. Compare evidence, state where agents agree or conflict, and call out missing, blocked, or truncated reports. Do not claim a result without collected evidence.

For writable agents:

1. Inspect the final checkout diff. A report is not proof that the checkout is correct.
2. Run appropriate aggregate validation.
3. If integration depends on first-wave results, plan and start a later squad with new exclusive ownership.

Then report the agents, scopes, and ownership; the changed files confirmed from the diff; validation run by agents and by you; and any handoffs, conflicts, or remaining integration work. Mention the cooperative bash limitation when it is relevant.
