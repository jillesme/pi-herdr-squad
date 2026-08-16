---
name: herdr-squad
description: Create and coordinate a visible, strictly read-only Herdr investigation squad of 1-12 Pi subagents across up to three tabs. Use only when the user explicitly asks for a Herdr squad, multiple visible subagents, or parallel investigation. Plans distinct scopes, launches through herdr_squad_start, waits, collects reports, and synthesizes findings.
---

# Herdr Investigation Squad

Use this workflow only for an explicit request for visible or parallel Herdr investigation. Do normal work when the user did not request a squad or multiple subagents. Use the separate `herdr-worker-squad` skill when agents must modify files.

## Preconditions

- Herdr squads require `HERDR_ENV=1`.
- Children are strictly read-only and receive only `read`, `grep`, `find`, `ls`, and the extension-owned report tool.
- Children cannot run tests or shell diagnostics. Never imply that they did.
- One squad supports 1-12 agents. Herdr packs at most four panes in each tab and creates at most three tabs.

## Planning

Inspect the task before launch. Select one agent for each independent investigation domain. Overlapping read access is allowed, but each scope must have a different responsibility.

Honor an explicit count from 1 through 12 only when that many useful domains exist. For `auto`, choose the smallest useful count. Do not start extra agents only because capacity is available. Reduce the count if you cannot state a distinct responsibility for every assignment. Never use duplicate assignments such as “investigate the issue” or “review everything.”

Before launch, present:

- a short tab title;
- the selected count;
- an explicit requested model, if any, or the configured/default model;
- each unique label and scope;
- one sentence that explains why the responsibilities are different.

Each prompt must request concrete evidence and stay inside its scope. Verify that `task` contains the full parent request, `count` is exact, and `assignments` has exactly that many entries.

## Model selection

- Pass an exact user-requested model string in `herdr_squad_start.model`.
- Ask for Pi's exact model identifier if the name is ambiguous.
- Otherwise omit `model`. The extension resolves project config, global config, then Pi's default.
- One model applies to all children.

## Mandatory tool sequence

Calls must occur in separate tool rounds:

1. Call `herdr_squad_start` alone.
2. Retain the returned `squadId`.
3. Call `herdr_squad_wait` alone.
4. Wait for completion, timeout, failure, or blocker details.
5. Call `herdr_squad_collect` alone, even after a partial result.
6. Synthesize only after collection returns.

Never create tabs or panes with raw `herdr` commands when squad tools are available. Use only the returned opaque `squadId` between calls.

## Synthesis

Organize the result around the parent task:

```markdown
## Squad setup
- Tabs: <labels>
- Agents: <labels and scopes>
- Mode: strictly read-only investigation

## Consolidated findings

## Evidence

## Cross-agent agreement and conflicts

## Gaps / missing reports

## Recommended next action
```

Compare evidence and identify agreement or conflict. Call out malformed, blocked, missing, or timed-out reports. Do not claim a result without collected evidence. State that children were read-only and made no checkout changes.
