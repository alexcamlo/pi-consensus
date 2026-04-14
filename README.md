# pi-consensus

A pi extension for multi-model consensus.

`/consensus <prompt>` runs the same prompt across multiple configured models, keeps their first-pass outputs independent, and synthesizes a final answer.

## Features

- opt-in `/consensus` command
- configurable participant and synthesis models
- project config overrides global config
- read-only repository inspection only
- participant filtering for empty, refusal-only, and weak responses
- structured synthesis with agreement, disagreement, unclear, and confidence scores
- interactive progress UI in pi
- markdown/plain-text result output

## How it works

1. Load consensus config from `.pi/consensus.json` or `~/.pi/agent/consensus.json`
2. Run participant models in parallel with read-only tools
3. Filter unusable participant outputs
4. Synthesize usable outputs into a single structured consensus result
5. Persist the result as a real tool result in the session

## Safety

This extension is intended to be read-only.

Allowed participant tools:

- `read`
- `ls`
- `find`
- `grep`
- `multi_grep`

Not allowed:

- `edit`
- `write`
- unrestricted `bash`

## Config

Config locations:

- project: `.pi/consensus.json`
- global: `~/.pi/agent/consensus.json`

If project config exists, it replaces global config entirely.

Example:

```json
{
  "models": [
    "anthropic/claude-sonnet-4-5",
    "openai/gpt-5",
    {
      "provider": "google",
      "id": "gemini-2.5-pro",
      "stance": "neutral",
      "focus": "maintainability"
    }
  ],
  "synthesisModel": "openai/gpt-5",
  "participantThinking": "low",
  "synthesisThinking": "medium",
  "participantTimeoutMs": 120000,
  "synthesisTimeoutMs": 90000
}
```

## Result shape

Consensus output includes:

- prompt
- participant summaries
- metadata
- debug participant outputs
- excluded participants
- synthesized answer
- overall agreement / disagreement / unclear / confidence
- agreed points
- disagreements

## Repo layout

- `src/index.ts` — extension entrypoint and `/consensus` command orchestration
- `src/config.ts` — config loading and validation
- `src/participants.ts` — read-only participant execution and filtering
- `src/synthesis.ts` — structured synthesis execution and validation
- `src/result.ts` — consensus result formatting
- `test/consensus-extension.test.ts` — workflow and rendering tests

## Local usage

```bash
npm install
npm run test
npm run typecheck
```

Then either:

```bash
pi -e ./src/index.ts
```

or run pi in this repo and let the project-local shim auto-load the extension.

## Open issues

- Retry weak participant answers that ask for more context instead of evaluating: [#25](https://github.com/alexcamlo/pi-consensus/issues/25)
- Render consensus tool results as formatted markdown in the TUI: [#26](https://github.com/alexcamlo/pi-consensus/issues/26)
