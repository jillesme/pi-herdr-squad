---
description: Start a visible Herdr squad of read-only investigation agents and synthesize their reports
argument-hint: "<1-12|auto> <task>"
---
Use the herdr-squad skill for this request.

Requested agent count: $1
Parent task: ${@:2}

Inspect the task and plan distinct scopes for read-only agents (no `writableRoots`). For `auto`, select the smallest useful count. Launch with `herdr_squad_start`, wait for the reports or explicit blockers, failures, or timeouts, and synthesize an evidence-based answer. Do not ask the agents to modify files or run shell commands.
