---
description: Start a visible Herdr read-only investigation squad, wait for reports, and synthesize the result
argument-hint: "<1-4|auto> <task>"
---
Use the herdr-squad skill for this request.

Requested agent count: $1
Parent task: ${@:2}

Create a non-overlapping, strictly read-only investigation plan. Launch it with the Herdr squad tools, wait for completion or explicit blockers/timeouts, collect every available report, and synthesize an evidence-based answer. Follow the skill's sequential tool-call protocol and do not ask child agents to modify files or run shell commands.
