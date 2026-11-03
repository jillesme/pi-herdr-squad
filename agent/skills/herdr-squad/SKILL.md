---
name: herdr-squad
description: Create and coordinate a visible, strictly read-only Herdr investigation squad of 1-12 Pi subagents across up to three tabs. Use only when the user explicitly asks for a Herdr squad, multiple visible subagents, or parallel investigation. Plans distinct scopes, launches through herdr_squad_start, waits, collects reports, and synthesizes findings.
---

# Herdr Investigation Squad

Use this workflow only for an explicit request for visible or parallel Herdr investigation. Do normal work when the user did not request a squad or multiple subagents. Use the separate `herdr-worker-squad` skill when agents must modify files.

## Preconditions

- Herdr squads require `HERDR_ENV=1`.
- Children are strictly read-only and receive only `read`, `grep`, `find`, `ls`, the extension-owned report tool, and the parent's web tools (`web_search`, `fetch_content`) when available.
- Web tools are on by default, so investigation squads can do web research. Pass `webTools: false` for checkout-only investigations.
- Children cannot run tests or shell diagnostics. Never imply that they did.
- Children load skills and context files, so domain skills apply to their work.
- One squad supports 1-12 agents. Herdr packs at most four panes in each tab and creates at most three tabs.

## Planning

Inspect the task before launch. Select one agent for each independent investigation domain. Overlapping read access is allowed, but each scope must have a different responsibility.

Honor an explicit count from 1 through 12 only when that many useful domains exist. For `auto`, choose the smallest useful count. Do not start extra agents only because capacity is available. Reduce the count if you cannot state a distinct responsibility for every assignment. Never use duplicate assignments such as “investigate the issue” or “review everything.”

Before launch, present:

- a short tab title;
- the selected count;
- an explicit requested model, if any, or the configured/default model, plus any per-assignment models;
- each unique label and scope;
- one sentence that explains why the responsibilities are different.

Each prompt must request concrete evidence and stay inside its scope. Verify that `task` contains the full parent request, `count` is exact, and `assignments` has exactly that many entries.

## Model selection

- Pass an exact user-requested model string in `herdr_squad_start.model`.
- Ask for Pi's exact model identifier if the name is ambiguous.
- Otherwise omit `model`. The extension resolves project config, global config, then Pi's default.
- The squad model applies to every child. To mix models, set `model` on individual assignments: a cheaper/faster model for mechanical scopes (listing usages, reading docs), a stronger one for subtle analysis. Only use model identifiers the user asked for or that appear in their configuration.
- Pass `inheritContext: true` when assignments depend on context discussed earlier in the conversation (decisions, constraints, prior findings) that would be long to restate. Leave it off for self-contained scopes; it adds the same tokens to every child.

## Tool sequence

Calls must occur in separate tool rounds:

1. Call `herdr_squad_start` alone and retain the returned `squadId`.
2. Then choose one mode:
   - **Wait mode** (nothing else useful to do): call `herdr_squad_wait` alone with a generous timeout. A timeout does not stop the agents.
   - **Background mode** (independent work remains): keep working. The extension sends an automatic follow-up message when the squad finishes or needs attention. Use `herdr_squad_status` for a non-blocking progress check.
   - Never poll with short `herdr_squad_wait` timeouts, and never collect early just to check progress.
3. Call `herdr_squad_collect` alone after the wait returns or the follow-up arrives, including after partial results. If collection lists agents as still running, you will be notified again; collect again then.
   - To redirect a running child, or ask a finished child a follow-up within its scope, call `herdr_squad_steer` instead of starting a new squad. A steered child reports again; collect after the next follow-up.
4. Synthesize only after collection returns.
5. When every report is structured, call `herdr_squad_close` to close the squad tabs. Leave the tabs open when reports are missing, blocked, or malformed so the user can inspect them.

Never create tabs or panes with raw `herdr` commands when squad tools are available. Use only the returned opaque `squadId` between calls.

## Synthesis

Organize the result around the parent task:

```markdown
## Squad setup
- Tabs: <labels>
- Agents: <labels and scopes>
- Mode: strictly read-only investigation (web tools: <yes/no>)

## Consolidated findings

## Evidence

## Cross-agent agreement and conflicts

## Gaps / missing reports

## Recommended next action
```

Compare evidence and identify agreement or conflict. Call out malformed, blocked, missing, or timed-out reports. Do not claim a result without collected evidence. State that children were read-only and made no checkout changes.
