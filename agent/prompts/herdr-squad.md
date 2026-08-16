---
description: Start a visible Herdr read-only investigation squad, wait for reports, and synthesize the result
argument-hint: "<1-12|auto> <task>"
---
Use the herdr-squad skill for this request.

Requested agent count: $1
Parent task: ${@:2}

Inspect the task and create a distinct, strictly read-only investigation plan. For `auto`, select the smallest useful exact count. Launch with the Herdr investigation squad tools, wait for completion or explicit blockers, failures, or timeouts, collect every available report, and synthesize an evidence-based answer. Follow the skill's sequential tool-call protocol. Do not ask children to modify files or run shell commands.
