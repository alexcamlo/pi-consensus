# pi-consensus

A pi extension for multi-model consensus.

`/consensus <prompt>` runs the same prompt across multiple configured participant models, filters weak/unusable first-pass outputs, and synthesizes a structured final answer.

## Features

- opt-in `/consensus` command and `consensus` tool
- participant + synthesis orchestration through a dedicated orchestrator boundary
- bounded participant concurrency
- retry support for transient participant/synthesis failures
- retry prompt path for non-evaluative participant responses
- participant quality classification (`usable`, `usable-with-warning`, `excluded`, `failed`)
- synthesis normalization/recovery and degraded fallback handling
- interactive progress widget in pi
- markdown result rendering in the TUI

## How it works

1. Load and validate config from `.pi/consensus.json` or `~/.pi/agent/consensus.json`
2. Orchestrator launches participant invocations (read-only tools only) with bounded concurrency
3. Participant outputs are classified for quality and filtered before synthesis
4. If at least 2 usable outputs remain, synthesis runs and validates/normalizes output
5. A structured consensus result is returned and rendered as markdown

## Read-only posture

Participant subprocesses are restricted to read-only tools:

- `read`
- `ls`
- `find`
- `grep`

No `edit`/`write` access is granted to participant runs.

## Configuration

Config locations:

- project: `.pi/consensus.json`
- global: `~/.pi/agent/consensus.json`

If project config exists, it replaces global config.

### Example

```json
{
  "models": [
    {
      "provider": "anthropic",
      "id": "claude-sonnet-4-5",
      "stance": "for"
    },
    {
      "provider": "openai",
      "id": "gpt-5",
      "stance": "against"
    },
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
  "synthesisTimeoutMs": 90000,
  "participantConcurrency": 3,
  "participantMaxRetries": 1,
  "synthesisMaxRetries": 1
}
```

### Runtime knobs

- `models` (required): 2–8 unique participant models (`provider/id` string or object form)
- `synthesisModel` (optional): synthesis model ref; falls back to the current pi model if omitted or unavailable
- `participantThinking` / `synthesisThinking` (optional): `off|minimal|low|medium|high|xhigh`
- `participantTimeoutMs` / `synthesisTimeoutMs` (optional): positive timeout in ms
- `participantConcurrency` (optional): integer `1..8`, default `3`
- `participantMaxRetries` (optional): integer `0..3`, default `1` (transient participant failures)
- `synthesisMaxRetries` (optional): integer `0..3`, default `1` (transient synthesis failures)
- model object metadata (optional):
  - `contextWindow` (positive integer)
  - `stance`: `for|against|neutral`
  - `focus`: `security|performance|maintainability|implementation speed|user value`

Command-line overrides:

- `/consensus --stance ...`
- `/consensus --focus ...`

These are one-run overrides applied to all participants for that run only.

## Repo layout

- `src/index.ts` — extension registration (`consensus` tool + `/consensus` command), progress widget wiring
- `src/orchestrator.ts` — end-to-end consensus workflow orchestration and stage/error handling
- `src/config.ts` — config discovery, normalization, validation, defaults, and model availability checks
- `src/participants.ts` — participant policy/prompt building, invocation, retry logic, filtering, early-stop gating
- `src/participant-quality.ts` — participant quality diagnostics and classification rules
- `src/synthesis.ts` — synthesis invocation, output validation/normalization, repair/degraded fallback
- `src/invocation-runner.ts` — shared `pi` subprocess JSON-mode invocation runner
- `src/pi-json-events.ts` — shared JSON event parsing helpers for participant/synthesis runs
- `src/result.ts` — final markdown/details result construction
- `test/*.test.ts` — workflow, config, invocation, quality, synthesis, and rendering tests

## Install

### Local install

```bash
npm install
pi -e ./src/index.ts
```

### Git install via pi

```bash
pi install git:github.com/alexcamlo/pi-consensus
```

### npm install via pi

Not published yet.

## Usage examples

```text
/consensus Should we add Redis caching to the API?
/consensus --stance against Should we add Redis caching to the API?
/consensus --stance for --focus performance Should we ship this now?
/consensus --focus security Review this auth design for likely risks.
```

