# Findings

## Architectural deepening candidates

### 1. Consensus run orchestration

- **Cluster**: `src/index.ts`, `src/participants.ts`, `src/synthesis.ts`, `src/result.ts`
- **Why they're coupled**: one logical workflow is split across config validation, participant execution, filtering, synthesis gating, progress UI, and result shaping. To understand one run, you have to trace `executeConsensusWorkflow()` in `src/index.ts`, then jump into participant classification, then synthesis normalization/repair, then back to result formatting.
- **Dependency category**: Local-substitutable
- **Test impact**: could replace many stage-specific tests with boundary tests around a single “run consensus” module:
  - `test/consensus-extension.test.ts` cases for early-stop, synthesis skip/fail, progress/result mapping
  - some glue assertions now spread across `participants` + `synthesis` tests

### 2. Pi subprocess execution protocol

- **Cluster**: `src/participants.ts`, `src/synthesis.ts`
- **Why they're coupled**: both modules independently own the same subprocess protocol:
  - spawn `pi`
  - parse line-delimited JSON
  - extract assistant text
  - manage timeout / stderr / exit-code handling
  - translate failures
  The duplicated `parseJsonLine()` / `extractAssistantText()` and near-identical spawn lifecycle are the clearest signal.
- **Dependency category**: Local-substitutable
- **Test impact**: could replace low-level invocation tests with boundary tests against one “Pi runner” abstraction:
  - participant invocation behavior tests
  - synthesis invocation behavior tests
  - duplication-sensitive tests for parsing and failure handling

### 3. Participant policy / evaluation contract

- **Cluster**: `src/config.ts`, `src/index.ts`, `src/participants.ts`, `src/result.ts`
- **Why they're coupled**: `stance`, `focus`, retry metadata, allowed tools, and participant output classification all belong to one concept — “how a participant should be run and judged” — but they’re threaded through config parsing, command overrides, prompt construction, filtering, and rendering.
- **Dependency category**: In-process
- **Test impact**: could replace scattered tests with boundary tests on a single participant-policy module:
  - `test/config.test.ts` stance/focus preservation/validation pieces
  - `test/participant-runner.test.ts` prompt framing + non-evaluative retry/classification pieces
  - some rendering assertions in `test/consensus-extension.test.ts`

### 4. Synthesis contract handling

- **Cluster**: `src/synthesis.ts`, with touchpoints in `src/index.ts` and `src/result.ts`
- **Why they're coupled**: synthesis prompt creation, raw invocation, normalization, validation, repair, degraded fallback, and status mapping all co-own one concept but expose several shallow seams. There’s even status translation logic that leaks upward, so callers need to know too much about internal recovery modes.
- **Dependency category**: Local-substitutable
- **Test impact**: could replace many normalization/repair implementation tests with boundary tests on “given usable/excluded participant inputs, produce a validated synthesis result or degraded fallback”:
  - much of `test/synthesis.test.ts`
  - parts of extension tests that assert synthesis-status plumbing
