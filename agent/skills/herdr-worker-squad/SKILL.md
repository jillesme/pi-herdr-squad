---
name: herdr-worker-squad
description: Create and coordinate a visible Herdr coding worker squad of 1-12 Pi subagents in one shared checkout with exclusive writable roots. Use only when the user explicitly asks for a worker squad, parallel coding agents, or visible parallel implementation. Inspects the repository, plans ownership, launches through herdr_worker_squad_start, waits, collects, then reviews the final diff and validates it.
---

# Herdr Worker Squad

Use this workflow only when the user explicitly requests visible parallel coding work or a Herdr worker squad. Use the read-only `herdr-squad` skill for investigation only.

## Preconditions and safety boundary

- Worker squads require `HERDR_ENV=1`.
- All workers use the same checkout and can see changes as they occur.
- Workers receive `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `herdr_squad_report`, and the parent's web tools (`web_search`, `fetch_content`) when available. Pass `webTools: false` to withhold web tools.
- Workers load skills and context files, so domain skills (for example Remotion or Cloudflare skills) apply to their work.
- The extension enforces `writableRoots` for `edit` and `write` calls. Bash is a cooperative policy boundary, not a sandbox. Use worker squads only for trusted local coding work.
- One squad supports 1-12 workers in no more than three tabs, with no more than four panes per tab.

## Required initial inspection

Before launch, use the parent tools to inspect the task, repository status, relevant directories, and shared integration files. Do not delegate this initial ownership analysis.

Then:

1. List the files or directory roots each work unit can modify.
2. Put work that needs the same root in one assignment.
3. Select at most one worker for each exclusive ownership group.
4. Select the smallest useful count. Do not fill capacity without independent work.
5. Assign shared integration files to one worker or defer them to a later wave.
6. Keep dependent integration work for a later squad when it needs changes from multiple workers.

Common later-wave files include manifests, lockfiles, central registries, shared schemas, generated indexes, migrations, changelogs, and release metadata.

## Writable roots

Every assignment needs one or more exact repository-relative `writableRoots`:

- A root identifies one file or one directory tree. It is not a shell glob.
- Roots for different workers must not be equal, nested, or otherwise overlap.
- Prefer repository-relative paths. Absolute paths inside the checkout are converted automatically. Do not use paths outside the checkout, `..`, empty paths, duplicates, or `.git` paths.
- Use `.` only when one worker owns the full checkout.
- A worker can read outside its roots but must report a handoff instead of writing there.

Before launch, present the title, count, model choice, each label and functional scope, each exact writable root, and why ownership does not overlap.

## Model selection

Pass an exact user-requested model in `herdr_worker_squad_start.model`. Ask when a model identifier is ambiguous. Otherwise omit it so shared squad configuration and Pi's default apply. One model applies to all workers.

Pass `inheritContext: true` when workers need decisions or constraints from earlier in the conversation that would be long to restate. Leave it off for self-contained assignments; it adds the same tokens to every worker.

## Mandatory sequence and coordinator mode

Calls must occur in separate tool rounds:

1. Call `herdr_worker_squad_start` alone with the full parent `task`, exact `count`, and exactly `count` assignments.
2. Retain the returned `squadId`.
3. While workers run, stay in coordinator mode. Do not modify any worker-owned file.
4. Either call `herdr_squad_wait` alone with a generous timeout, or continue work outside every worker's writable roots and act on the automatic follow-up message the extension sends when the squad finishes or needs attention. Use `herdr_squad_status` for a non-blocking check. Never poll with short wait timeouts.
5. Call `herdr_squad_collect` alone, including after timeout, failure, or blocker results. Agents listed as still running keep ownership of their roots; collect again after the next follow-up.
   - To correct a worker, or ask it to fix a problem within its own writable roots, call `herdr_squad_steer`. A steered worker owns its roots again until it reports again. Use a later wave for work outside its roots.
6. Inspect the final checkout diff. Worker reports are not proof that the checkout is correct.
7. Run appropriate aggregate validation.
8. When every report is structured, call `herdr_squad_close` to close the squad tabs. Leave the tabs open when reports are missing or blocked so the user can inspect them.
9. If integration depends on first-wave results, plan and start a later worker squad with new exclusive ownership.

Never coordinate workers directly or ask one worker to wait for another. The parent coordinates waves.

## Final response

Report:

- tabs, workers, scopes, and ownership;
- collected completion summaries and missing reports;
- actual changed files confirmed from the final diff;
- validation results run by workers and aggregate checks run by the parent;
- handoffs, conflicts, or remaining integration work;
- the shared-checkout and cooperative bash limitation when relevant.
