# pi-consensus

A pi extension for multi-model consensus.

## What it does

`/consensus <prompt>` sends the same prompt to multiple configured models in parallel, keeps their first-pass responses independent, and then synthesizes a final answer with:

- consensus recommendation
- agreement / disagreement / unclear percentages
- confidence score
- agreed points
- disagreement points
- participant and exclusion details

## v1 goals

- opt-in `/consensus` command
- configurable participant and synthesis models
- project config overrides global config
- read-only repo inspection only
- no file edits
- interactive progress UI
- plain-text fallback for non-interactive mode

## Config

Planned config locations:

- Project: `.pi/consensus.json`
- Global: `~/.pi/agent/consensus.json`

If project config exists, it replaces global config entirely.

Example:

```json
{
  "models": [
    "anthropic/claude-sonnet-4-5",
    {
      "provider": "openrouter",
      "id": "google/gemma-4-31b-it:free",
      "contextWindow": 128000
    }
  ],
  "synthesisModel": {
    "provider": "openai",
    "id": "gpt-5",
    "contextWindow": 400000
  }
}
```

`contextWindow` is optional per object-form model reference and is preserved as metadata for downstream prompt-sizing decisions.

## Safety

This extension is intended to be read-only.

Allowed participant tools in v1:

- `read`
- `ls`
- `find`
- `grep`
- `multi_grep`

Not allowed:

- `edit`
- `write`
- unrestricted `bash`

## Planning

- PRD: [#1](https://github.com/alexcamlo/pi-consensus/issues/1)
- Bootstrap: [#2](https://github.com/alexcamlo/pi-consensus/issues/2)
- Config + validation: [#3](https://github.com/alexcamlo/pi-consensus/issues/3)
- Parallel participant execution: [#4](https://github.com/alexcamlo/pi-consensus/issues/4)
- Usability filtering: [#5](https://github.com/alexcamlo/pi-consensus/issues/5)
- Consensus synthesis: [#6](https://github.com/alexcamlo/pi-consensus/issues/6)
- Rendering + progress UI: [#7](https://github.com/alexcamlo/pi-consensus/issues/7)
- Pi-native persistence: [#8](https://github.com/alexcamlo/pi-consensus/issues/8)

## Status

Consensus config loading, parallel participant execution, usability filtering, synthesis, markdown/plain-text result rendering, interactive progress updates, safety-capped participant counts, and pi-native tool-result persistence are implemented.

## Implementation notes

Current pi extension APIs document `pi.sendMessage()` and `pi.sendUserMessage()` for command-triggered turns, plus real tool results from `pi.registerTool().execute()`. They do not document a direct way for a slash command handler itself to append a `toolResult` entry. To keep `/consensus` pi-native, the command now injects a hidden assistant-steering message that tells the agent to call the registered `consensus` tool with the exact prompt. The workflow then runs inside the actual tool execution path, so the persisted artifact is a genuine tool result rather than assistant prose or a custom-message approximation.

## Synthesis JSON contract

The synthesis step expects strict structured JSON. Percentage and count fields must be emitted as JSON numbers, never strings. Required numeric fields must not be `null` or omitted, and participant counts such as `agreedPoints[].supportingParticipants` and `agreedPoints[].totalParticipants` must be integers rather than fractions like `"2/3"`.

## Repo layout

- `src/index.ts` — extension entrypoint and `/consensus` command orchestration
- `src/config.ts` — config loading and validation
- `src/participants.ts` — read-only participant execution and filtering
- `src/synthesis.ts` — structured synthesis execution and validation
- `src/result.ts` — markdown/plain-text result rendering
- `.pi/extensions/pi-consensus.ts` — project-local auto-discovery shim for pi
- `package.json` — pi package metadata + scripts
- `tsconfig.json` — TypeScript config for local typechecking

## Local usage

```bash
npm install
npm run check
```

Then either:

```bash
pi -e ./src/index.ts
```

or run pi in this repo and let the project-local shim auto-load from `.pi/extensions/pi-consensus.ts`.
