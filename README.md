# pi-herdr-squad

Visible, strictly read-only investigation squads for [Pi](https://github.com/earendil-works/pi-mono) running inside [Herdr](https://herdr.dev).

The package creates a dedicated Herdr tab with one to four interactive Pi children, assigns exclusive scopes, waits for structured reports, and gives the parent agent the evidence needed to synthesize a result.

## Requirements

- Pi with extension, skill, and prompt-template support.
- A Pi session running in a Herdr-managed pane (`HERDR_ENV=1`).
- Herdr's managed Pi state integration installed. Herdr normally manages `herdr-agent-state.ts` itself.

## Install

After publishing:

```bash
pi install npm:pi-herdr-squad
```

For local development from this checkout:

```bash
pi install /absolute/path/to/pi-herdr-squad
```

Then start a new Pi session or run `/reload`.

## Use

Let the parent choose a conservative agent count:

```text
/herdr-squad auto compare frontend and backend validation
```

Use an exact count:

```text
/herdr-squad 3 investigate checkout failures across runtime code, tests, and configuration
```

Natural-language requests also load the skill when they explicitly request a Herdr squad or parallel subagents:

```text
Start a two-agent Herdr squad to compare client and server validation.
```

The parent plans non-overlapping scopes, then calls `herdr_squad_start`, `herdr_squad_wait`, and `herdr_squad_collect` sequentially. Children remain visible in their Herdr tab after collection.

## Default child model

The model precedence is:

1. An explicit model requested for the squad.
2. Project config at `.pi/herdr-squad.json` in a trusted project.
3. Global config at `~/.pi/agent/herdr-squad.json`.
4. Pi's normal default model when no squad model is configured.

Global example:

```json
{
  "defaultModel": "anthropic/claude-haiku-4-5"
}
```

Project example:

```json
{
  "defaultModel": "anthropic/claude-haiku-4-5"
}
```

A trusted project can set `defaultModel` to `null` to ignore the global squad model and use Pi's normal default:

```json
{
  "defaultModel": null
}
```

Configuration is read whenever a squad starts, so changing the JSON file does not require `/reload`.

To override the configured model for one investigation, say so explicitly:

```text
Start a two-agent Herdr squad using anthropic/claude-haiku-4-5 to audit the auth migration.
```

The skill passes explicit requests through `herdr_squad_start.model`. The selected model applies to every child in that squad. Model credentials and availability are still handled by Pi.

## Read-only boundary

Every child receives exactly these active tools:

```text
read, grep, find, ls, herdr_squad_report
```

Children do not receive `bash`, `edit`, or `write`. The report tool writes only an extension-owned JSON report under a private temporary run directory; it cannot modify the shared checkout.

Task text is stored in mode-`0600` prompt files and is never interpolated into shell commands. Tab and pane identities are revalidated before terminal fallbacks are read.

## Package contents

- `agent/extensions/herdr-squad/` — parent orchestration and child reporting.
- `agent/skills/herdr-squad/SKILL.md` — delegation and synthesis policy.
- `agent/prompts/herdr-squad.md` — `/herdr-squad` entry point.

## Development checks

```bash
npm run check
npm run pack:check
```

The package has no third-party runtime dependencies. Pi-provided APIs are declared as peer dependencies.

## License

MIT
