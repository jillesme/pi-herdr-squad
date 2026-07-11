# pi-herdr-squad

Visible, strictly read-only investigation squads for [Pi](https://github.com/earendil-works/pi-mono) running inside [Herdr](https://herdr.dev).

The package creates a dedicated Herdr tab with one to four interactive Pi children, assigns exclusive scopes, waits for structured reports, and gives the parent agent the evidence needed to synthesize a result.

## Requirements

- Pi with extension, skill, and prompt-template support.
- A Pi session running in a Herdr-managed pane (`HERDR_ENV=1`).
- Herdr's managed Pi state integration installed. Herdr normally manages `herdr-agent-state.ts` itself.

## Install

Install from npm:

```bash
pi install npm:pi-herdr-squad
```

For local development from this checkout:

```bash
pi install /absolute/path/to/pi-herdr-squad
```

Then start a new Pi session or run `/reload`.

### First use

1. Run Pi inside a Herdr-managed pane.
2. Use `/login` to authenticate, if needed, and `/model` to verify the desired model.
3. Install the package, then start a new Pi session or run `/reload`.
4. Start a simple squad, for example `/herdr-squad 1 inspect the package entry point`.

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

## Child model selection

The model precedence is:

1. An explicit model requested for one squad through `herdr_squad_start.model`.
2. Trusted project config at `.pi/herdr-squad.json`.
3. Global config at `~/.pi/agent/herdr-squad.json`.
4. Pi's normal default model when no squad model is configured.

Global configuration (`~/.pi/agent/herdr-squad.json`):

```json
{
  "defaultModel": "openai-codex/gpt-5.6-terra"
}
```

Trusted project configuration (`.pi/herdr-squad.json`) uses the same shape. A trusted project can bypass the global squad model and use Pi's normal default:

```json
{
  "defaultModel": null
}
```

Configuration is read whenever a squad starts, so changing the JSON file does not require `/reload`. Untrusted project configuration is ignored.

To override configuration for one investigation, request the exact model explicitly:

```text
Start a two-agent Herdr squad using openai-codex/gpt-5.6-terra to audit the auth migration.
```

The selected model applies to every child in that squad.

### Choose and verify a model

Copy the exact identifier recognized by Pi, generally in `provider/model` form. List available identifiers with:

```bash
pi --list-models
```

In interactive Pi, use `/login` to authenticate and `/model` to inspect or select available models. Pi also accepts compatible suffixes such as `provider/model:thinking`; squad configuration passes the value unchanged to `pi --model`.

Prefer the provider-qualified identifier shown by Pi. A bare name such as `gpt-5.6-terra` can be ambiguous or resolve against an unintended provider; use `openai-codex/gpt-5.6-terra` when that is the identifier Pi shows. Pi remains responsible for resolving the identifier, credentials, and model availability; the squad extension does not preflight or duplicate Pi's model registry.

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
