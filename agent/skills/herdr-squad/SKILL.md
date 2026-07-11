---
name: herdr-squad
description: Create and coordinate a visible, strictly read-only Herdr investigation squad of 1-4 Pi subagents. Use only when the user explicitly asks for a Herdr squad, multiple visible subagents, or parallel investigation. Plans non-overlapping scopes, launches through herdr_squad_start, waits, collects reports, and synthesizes findings.
---

# Herdr Squad

Use this workflow only for an explicit request for visible or parallel Herdr delegation. Do normal work when the user has not requested a squad or multiple subagents.

## Preconditions

- Herdr squads require `HERDR_ENV=1`.
- Children are strictly read-only and receive only `read`, `grep`, `find`, `ls`, and the extension-owned final-report tool.
- Children cannot run tests or shell diagnostics. Never imply that they did.

## Planning

Honor an explicit count from 1 through 4. For `auto`, choose the smallest useful count:

- **1:** narrow single-domain reconnaissance.
- **2:** a clear binary split such as frontend/backend or implementation/tests.
- **3:** three independent dimensions such as runtime path, tests/observability, and configuration/dependencies.
- **4:** only a genuinely broad task with four separable domains.

Reduce the count if you cannot state exclusive scopes. Never use vague duplicate assignments such as “investigate the issue” or “review everything.”

## Model selection

- If the user explicitly requests a model for the investigation, pass that exact model string in `herdr_squad_start.model`.
- If a user-provided name is ambiguous, ask for Pi's exact model identifier rather than guessing a provider.
- Otherwise omit `model`. The extension will resolve the project config, global config, and finally Pi's normal default.
- Do not invent a model override merely because several agents are being launched.
- The explicit model applies to every child in the squad.

Before launching, present a concise plan containing:

- a short tab title;
- selected count;
- an explicit requested model, if any; otherwise say the configured/default model will be used;
- each unique label and exclusive scope;
- one sentence explaining why the scopes do not overlap.

Each assignment prompt must request concrete evidence and stay inside its scope.

Before calling `herdr_squad_start`, verify its arguments include:

- `task`: the full parent request, copied or faithfully summarized so every child receives the shared context;
- `count`: the selected agent count;
- `assignments`: exactly `count` entries, each with a unique `label`, exclusive `scope`, and specific `prompt`.

`task` is mandatory even when the assignment prompts appear self-contained. Do not omit it or substitute the tab title for it.

## Mandatory tool sequence

Tool calls must be sequential across separate model turns because Pi may execute sibling calls concurrently:

1. Call `herdr_squad_start` by itself.
2. Wait for its result and retain the returned opaque `squadId`.
3. In the next tool round, call `herdr_squad_wait` by itself.
4. Wait for the wait result, including timeout or blocker information.
5. In the next tool round, call `herdr_squad_collect` by itself, even if a child timed out, blocked, or failed to submit a structured report.
6. Synthesize only after collection returns.

Never construct tabs or panes with raw `herdr` commands when the squad tools are available. Do not pass guessed Herdr IDs between tools; use only the `squadId`.

## Synthesis

Organize the final answer around the parent task, not as a concatenation of child reports. Include:

```markdown
## Squad setup
- Tab: <title>
- Agents: <labels and scopes>
- Mode: strictly read-only investigation

## Consolidated findings

## Evidence

## Cross-agent agreement and conflicts

## Gaps / missing reports

## Recommended next action
```

Compare evidence, identify corroboration and disagreement, and call out malformed, blocked, missing, or timed-out reports. Do not claim a finding unless collected evidence supports it. State that the children were read-only and made no checkout changes.
