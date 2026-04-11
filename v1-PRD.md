# PRD: Pi Consensus Extension

## Summary

Build a **global pi extension** that adds an opt-in `/consensus <prompt>` command. The command sends the same prompt to **2+ configured models** in parallel, keeps their first-pass reasoning independent, then runs a configurable synthesis step to produce a single consensus answer with agreement/disagreement analysis.

The extension must be **read-only**: no model run may edit files.

## Problem

A single model often gives one plausible approach, but not the best one. For planning, architecture, and implementation strategy, I want multiple models to independently evaluate the same prompt, inspect the repo when needed, and return a final consensus with explicit areas of agreement and disagreement.

## Goals

- Add `/consensus <prompt>` as an opt-in workflow
- Run all configured participant models in parallel
- Keep first-pass model responses independent
- Make participant and synthesis models configurable via settings
- Use number of configured models as the participant count
- Allow read-only repo inspection only
- Produce a final answer with:
  - consensus answer
  - overall agreement/disagreement/unclear percentages
  - confidence percent + label
  - agreed points
  - disagreements
  - participating + excluded models
- Persist the result in a pi-native way, ideally as a real tool result
- Support interactive mode well; degrade to plain text in non-interactive mode

## Non-goals

- No automatic replacement of normal pi behavior
- No write/edit tools
- No unrestricted bash
- No image input in v1
- No multi-round debate in v1
- No per-model custom prompts in v1
- No synthesis repo inspection in v1
- No config merge between project and global config

---

## User stories

### User story 1
As a pi user, I can run `/consensus <prompt>` to get a multi-model consensus answer instead of a single-model answer.

### User story 2
As a user working in a repo, participant models can inspect relevant code using read-only tools when the prompt depends on repo context.

### User story 3
As a user, I can configure which models participate in consensus through settings files.

### User story 4
As a user, project-level consensus config fully overrides global consensus config.

### User story 5
As a user, I get a final answer that includes agreement/disagreement percentages and confidence, not just prose.

### User story 6
As a user, I can see which models contributed, failed, or were excluded as unusable.

### User story 7
As a user, I can expand/debug the result to inspect raw participant outputs.

### User story 8
As a user, the feature never edits my codebase.

---

## Functional requirements

### 1. Command
- Register `/consensus`
- Invocation format:
  - `/consensus <prompt>`
- v1 does not support command flags

### 2. Extension scope
- Implement as a **global extension**
- Use a directory-based extension layout

### 3. Config resolution
Config files:
- Project: `.pi/consensus.json`
- Global: `~/.pi/agent/consensus.json`

Resolution policy:
- If project config exists, use it **exclusively**
- Else if global config exists, use it
- Else error

No merge behavior.

### 4. Config schema
Support both string and object model references.

Example:

```json
{
  "models": [
    "anthropic/claude-sonnet-4-5",
    "openai/gpt-5",
    { "provider": "google", "id": "gemini-2.5-pro" }
  ],
  "synthesisModel": "anthropic/claude-sonnet-4-5",
  "participantThinking": "low",
  "synthesisThinking": "medium",
  "participantTimeoutMs": 120000,
  "synthesisTimeoutMs": 120000
}
```

Normalized internal model shape:

```ts
type ModelRef = {
  provider: string
  id: string
}
```

### 5. Participant model rules
- Use **all configured participant models**
- Minimum required unique participant models: **2**
- Deduplicate duplicates
- Warn and deduplicate duplicate model entries
- Hard cap participant count in code for safety
- Validate configured models against pi model registry before running
- If synthesis model is invalid/missing, fall back to current pi model
- If current pi model is also invalid/unavailable, error
- If synthesis model also appears in participant set, allow but warn

### 6. Execution model
- First pass: run participant models in parallel
- Use separate `pi` subprocesses for isolation
- Each participant gets the same core prompt
- Participants must not see each other’s outputs
- v1 workflow:
  1. validate config/models
  2. run parallel participant pass
  3. filter failed/unusable outputs
  4. run synthesis pass
  5. render/persist final result

### 7. Tool access
Participant tools allowed:
- `read`
- `ls`
- `find`
- `grep`
- `multi_grep`

Participant tools not allowed:
- `edit`
- `write`
- destructive tools
- raw `bash`

Synthesis tools:
- none

### 8. Prompting rules
Participant prompts should:
- answer the user’s prompt directly
- inspect the repo when the prompt depends on repo context
- provide:
  - recommended approach
  - why
  - risks/tradeoffs
  - confidence
- choose one primary recommendation
- optionally mention alternatives briefly

No per-model prompt customization in v1.

### 9. Success and usability rules
A participant response is not successful just because it is non-empty.

A participant result is usable only if:
1. subprocess completed without fatal error
2. response passes heuristic checks
3. synthesis/judge determines the response is usable for the initial prompt

Heuristic prefilter can reject:
- empty output
- obvious refusal
- generic nonsense
- severely vague responses

Consensus can continue only if at least **2 usable** participant outputs remain.

### 10. Failure policy
- If one participant fails, continue if at least 2 usable outputs remain
- If fewer than 2 usable outputs remain, fail the run
- Show failed/excluded models in output

### 11. Synthesis
- Use configured `synthesisModel` if valid
- Else fall back to current pi model
- Synthesis sees:
  - original user prompt
  - participant model identities
  - full raw participant outputs
- Synthesis does not inspect repo in v1
- Synthesis returns structured JSON internally
- Extension renders human-readable markdown/text from that JSON

### 12. Required synthesis output fields
Structured output must include at least:
- `consensusAnswer`
- `overallAgreementPercent`
- `overallDisagreementPercent`
- `overallUnclearPercent`
- `confidencePercent`
- `confidenceLabel`
- `agreedPoints[]`
- `disagreements[]`
- `participants[]`
- `excludedParticipants[]`

Rules:
- overall agreement/disagreement/unclear must sum to **100**
- confidence must include percent + label
- claim-level support should include counts/percent where applicable

### 13. Default user-visible output
Normal view should show:
- consensus answer
- agreement / disagreement / unclear percentages
- confidence percent + label
- agreed points
- disagreement points
- participating models
- excluded models with short reason

Expanded/debug view should show:
- raw participant outputs
- exclusion/usability reasons
- synthesis raw structured details if useful

### 14. Interactivity
Interactive mode:
- show live progress
- show per-model status
- show synthesis status

Non-interactive mode:
- still run
- output plain text/markdown result
- no rich UI required

### 15. Persistence
Desired behavior:
- persisted artifact should be a **real tool result**, not assistant prose

Implementation preference:
- keep a registered `consensus` tool
- `/consensus` command is the entrypoint
- if direct command-driven tool-result creation is not possible, route through a real assistant tool call to preserve pi-native behavior

### 16. Safety
- extension must never write/edit repo files
- no write-capable tools exposed to participants
- no unrestricted shell access

---

## UX details

### Normal output shape
Example:

```md
# Consensus

## Answer
[final synthesized recommendation]

## Overall
- Agreement: 68%
- Disagreement: 22%
- Unclear: 10%
- Confidence: 74% (medium)

## Agreed points
- Use opt-in `/consensus` workflow — 100% (3/3)
- Keep participant pass parallel — 100% (3/3)

## Disagreements
- Whether to add critique round in v1 — mixed support

## Participants
- anthropic/claude-sonnet-4-5
- openai/gpt-5

## Excluded
- google/gemini-2.5-pro — timed out
```

### Progress UI
Interactive progress should show:
- validation
- participant statuses by model
- synthesis running/completed

Example:
- `anthropic/claude-sonnet-4-5` — running
- `openai/gpt-5` — done
- `google/gemini-2.5-pro` — excluded: vague answer
- `synthesis` — running

---

## Acceptance criteria

- [ ] `/consensus <prompt>` is registered and works as an opt-in command
- [ ] Extension is installable as a global directory-based pi extension
- [ ] Config is loaded from `.pi/consensus.json` or `~/.pi/agent/consensus.json`
- [ ] Project config fully replaces global config when present
- [ ] Missing config produces a clear error
- [ ] Participant models are validated before execution
- [ ] Duplicate participant models are warned on and deduplicated
- [ ] Minimum 2 unique participant models enforced
- [ ] Participant subprocesses run in parallel
- [ ] Participant subprocesses only have read-only tools: `read`, `ls`, `find`, `grep`, `multi_grep`
- [ ] No participant can edit files
- [ ] Repo-dependent prompts cause participants to inspect code before answering
- [ ] Participant responses use light structured markdown, not JSON
- [ ] Unusable participant outputs are filtered out
- [ ] Consensus proceeds when at least 2 usable outputs remain
- [ ] Synthesis uses configured synthesis model or falls back to current pi model
- [ ] Synthesis consumes full participant outputs
- [ ] Synthesis returns structured JSON internally
- [ ] Final result renders readable markdown/text
- [ ] Output includes agreement/disagreement/unclear percentages summing to 100
- [ ] Output includes confidence percent + label
- [ ] Output includes participating and excluded models
- [ ] Excluded models show short reasons in normal view
- [ ] Expanded/debug view exposes raw participant outputs
- [ ] Interactive mode shows live per-model progress
- [ ] Non-interactive mode still returns plain text output
- [ ] Final persisted artifact is pi-native, preferably a real tool result

---

## Risks / edge cases

- No documented API may exist for directly creating a tool-result entry from a command
- Provider/model availability may differ across environments
- Usability judgment may be noisy if synthesis prompt/schema is weak
- Agreement percentages can become hand-wavy unless schema/prompt is strict
- Same model as participant + synthesis may bias results
- Large participant outputs may increase synthesis token cost

---

# Implementation plan

Extremely concise, tracer-bullet friendly.

1. **Scaffold global extension**
   - directory-based extension
   - register `/consensus`
   - register `consensus` tool
   - unresolved: confirm best pi-native path for persisted tool result

2. **Config + validation**
   - load project-or-global config
   - parse string/object model refs
   - dedupe
   - validate models + thinking + timeouts
   - fail cleanly

3. **Participant runner**
   - spawn isolated `pi` subprocess per model
   - current cwd only
   - read-only tools only
   - same prompt shape for all
   - parallel status updates

4. **Usability gate**
   - heuristic prefilter
   - synthesis/judge usability classification
   - exclude bad outputs with short reasons
   - require 2 usable

5. **Consensus synthesis**
   - feed prompt + full raw participant outputs
   - structured JSON output
   - agreement/disagreement/unclear sum 100
   - confidence percent + label

6. **Render + persist**
   - concise normal output
   - expanded/debug raw outputs
   - non-interactive plain text fallback
   - persist as real tool result if pi-native path available

7. **Hardening**
   - timeout/failure handling
   - duplicate/warning paths
   - missing synthesis fallback
   - overlap warning when synthesis model also participated

Unresolved questions:
- exact pi-native mechanism to persist a real tool result from `/consensus` entry flow
