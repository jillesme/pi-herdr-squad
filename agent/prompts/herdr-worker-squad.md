---
description: Start a visible Herdr squad of coding agents with exclusive writable roots in one shared checkout
argument-hint: "<1-12|auto> <task>"
---
Use the herdr-squad skill for this request.

Requested agent count: $1
Parent task: ${@:2}

First inspect the task, repository status, relevant files, and ownership boundaries yourself. For `auto`, select the smallest useful count. Plan exclusive repository-relative `writableRoots` for every coding agent, then launch with `herdr_squad_start`. Stay in coordinator mode while the agents run. After the reports arrive, inspect the final diff and run appropriate aggregate validation. Use later waves for dependent shared integration files.
