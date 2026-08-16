---
description: Start visible Herdr coding workers with exclusive writable roots in one shared checkout
argument-hint: "<1-12|auto> <task>"
---
Use the herdr-worker-squad skill for this request.

Requested worker count: $1
Parent task: ${@:2}

First inspect the task, repository status, relevant files, and ownership boundaries with the parent tools. For `auto`, select the smallest useful exact count. Plan exclusive repository-relative writable roots, then launch with `herdr_worker_squad_start`. Follow the separate start, wait, and collect tool rounds. Stay in coordinator mode while workers run. After collection, inspect the final diff and run appropriate aggregate validation. Use later waves for dependent shared integration files.
