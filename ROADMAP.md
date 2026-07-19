# SD Forge Neo Prompt Agent Roadmap

## Purpose

This roadmap governs the migration from the archived sidecar runtime to a
frontend Pi agent, a thin Python security boundary, and IndexedDB sessions.

Decision priority is:

1. user experience;
2. stability and data integrity;
3. performance;
4. maintainability and operability;
5. new capability.

Security and privacy are invariants. API keys, decrypted secrets, arbitrary
local paths, and privileged Forge operations never move into browser storage.

## Product Boundary

The product is `SD Forge Neo Prompt Agent`, a single-agent prompt assistant
embedded in Forge Neo.

The frontend owns:

- the Pi agent loop and generation state;
- streaming, reasoning, tool-call, and abort UI;
- IndexedDB session history and preferences;
- provider/model/profile selection.

Python owns:

- Forge extension registration and privileged operations;
- provider secret storage and request authorization;
- streaming provider proxying;
- profile authority;
- llama.cpp process lifecycle and local model paths.

The migration must not introduce another Kotlin, Node, or Bun sidecar, a second
agent loop, tool leases, browser bridge claims, a session ownership server,
turn-event replay, or refresh-time continuation of old execution.

## Architecture Invariants

- `PromptAgentRuntime` is the only source of generation state.
- Svelte stores map runtime state; components do not create a second state
  machine.
- Provider-specific request logic stays out of Svelte components.
- Every Forge tool is one validated request and one structured response.
- Python revalidates every tool argument and never trusts browser paths or model
  identifiers.
- API keys are decrypted only for the request that needs them.
- IndexedDB is authoritative for new session history, not Python.
- Refresh persists partial content, marks unfinished messages interrupted, and
  never re-executes an old tool call.
- Local process state is independent of agent session state.
- Compatibility reads are isolated in migration modules; there is no dual-write
  legacy runtime.

## Phase 0: Freeze The Old Runtime

Status: complete.

Artifacts:

```text
branch: kt
tag: kt-final
commit: b016c88
```

The verified baseline passed 240 Python tests, 146 frontend tests, Svelte
checks, the Vite build, bundle budget, and browser syntax checks.

## Phase 1: Audit And Migration Contract

Status: in progress.

Deliverables:

- `docs/current-architecture-audit.md`;
- `docs/kt-runtime-migration.md`;
- old runtime call chains, schemas, build flow, and deletion dependencies;
- explicit Pi version and licensing gates.

Exit criteria:

- the audit names all sources of ownership, lease, replay, and provider state;
- deletion prerequisites are documented;
- the roadmap no longer requires the archived runtime on `main`.

## Phase 2: New Skeleton

Create and compile:

```text
frontend/src/agent/
frontend/src/providers/
frontend/src/tools/
frontend/src/sessions/
backend/prompt_agent/
```

Add shared errors, API contracts, logging, health, and lifecycle entrypoints.
Keep the current Svelte surface usable while replacing its runtime boundary.

Exit criteria:

- frontend check, tests, and build pass;
- Python compile and focused API tests pass;
- no new ownership or replay protocol exists.

## Phase 3: Minimal Pi Loop

Integrate pinned, mutually compatible versions of:

```text
@earendil-works/pi-agent-core
@earendil-works/pi-ai
```

Implement `PromptAgentRuntime` with single-turn streaming, event mapping, abort,
reset, destroy, and normalized errors. Use a proxy stream function so the
browser never receives provider secrets.

Exit criteria:

- one streaming conversation completes without starting the archived sidecar;
- abort closes the provider request and restores usable composer state;
- failed requests produce a terminal runtime state;
- runtime destroy aborts work and removes subscribers.

## Phase 4: Thin Python Provider Proxy

Implement provider/profile reads, encrypted secret injection, streaming
forwarding, cancellation propagation, health tests, request IDs, and sanitized
errors under `/prompt-agent/api`.

Exit criteria:

- plaintext saved keys never appear in frontend responses or persistence;
- OpenAI-compatible streaming works end to end;
- disconnect and abort close upstream work;
- logs exclude authorization and sensitive bodies.

## Phase 5: Provider Adapters

Add frontend adapters for:

```text
OpenAI Compatible
OpenRouter
Anthropic
Gemini
llama.cpp
```

Normalize capabilities, messages, tools, attachments, reasoning, usage, stream
events, and errors.

Exit criteria:

- provider differences exist only in adapter modules and Python proxy helpers;
- each adapter has contract tests for text, tools, errors, and abort;
- unsupported capabilities are explicit in the UI.

## Phase 6: Forge Agent Tools

Migrate, in order:

```text
read_prompt
edit_prompt
read_negative_prompt
edit_negative_prompt
list_resources
read_resource_metadata
ask_teacher
read_generation_parameters
apply_generation_parameters
list_models
list_loras
list_embeddings
```

Every tool needs a frontend TypeBox schema, backend validation, timeout,
AbortSignal, structured error, user-readable error, and permission boundary.

Exit criteria:

- no claim, release, bridge ID, lease token, or owner ID is used;
- stale prompt mutations remain hash guarded;
- failed or aborted tools do not leave the runtime blocked.

## Phase 7: Profiles

Make Python profile storage authoritative and expose list, read, create, update,
delete, duplicate, set-default, models, and connection-test APIs.

Exit criteria:

- CRUD and default selection survive refresh;
- DPAPI round trips are covered;
- frontend caches contain no secret values;
- old profile import is isolated and idempotent.

## Phase 8: IndexedDB Sessions

Create database `sd-forge-neo-prompt-agent` with versioned stores for sessions,
messages, attachments, runtime preferences, and profile cache.

Exit criteria:

- session and message CRUD pass;
- streaming messages update without duplicate writes;
- refresh restores history and selection;
- unfinished messages become `interrupted`;
- no old stream or tool call resumes after refresh;
- multi-tab behavior is informational only.

## Phase 9: Remove Archived Runtime

Delete from `main` after dependency searches are empty:

- managed sidecar and installer;
- Terrarium package/configuration and requirements;
- frontend KT client and runtime controller;
- bridge claim/release and lease renewal;
- single active session ownership and 409 recovery;
- follow-up queue, branch runtime, runtime event log, and replay cursors;
- old provider runtime and contract tests.

Exit criteria:

- no active import, route, build step, test, or startup path references the old
  runtime;
- default build and launch do not create or inspect `.loom`;
- rollback remains available through `kt` and `kt-final`.

## Phase 10: Complete Naming Migration

Use these active identifiers:

```text
SD Forge Neo Prompt Agent
sd-forge-neo-prompt-agent
prompt_agent
prompt-agent
PromptAgent
PromptAgentRuntime
/prompt-agent/api
window.__SD_FORGE_NEO_PROMPT_AGENT__
```

Old names may remain only in Git history, migration documentation, and isolated
compatibility constants. Release under the new name remains gated by the
licensing decision documented in `docs/kt-runtime-migration.md`.

## Quality Gates

Run the smallest complete set covering every changed layer:

```powershell
python -m compileall -q backend scripts install.py tools
python -m unittest discover -s tests

cd frontend
npx --yes --package node@22.17.0 --package pnpm@10.12.4 pnpm run check
npx --yes --package node@22.17.0 --package pnpm@10.12.4 pnpm run test:coverage
npx --yes --package node@22.17.0 --package pnpm@10.12.4 pnpm run build
npx --yes --package node@22.17.0 --package pnpm@10.12.4 pnpm run bundle:size
npx --yes --package node@22.17.0 --package pnpm@10.12.4 pnpm run test:e2e
```

Update the commands when the pinned Node version changes. Browser scripts must
also pass `node --check` after generation or lifecycle edits.

## Definition Of Done

A phase is complete only when:

- user-visible success, failure, abort, refresh, and recovery behavior match its
  acceptance criteria;
- focused regression tests cover the changed boundary;
- generated assets are rebuilt rather than edited;
- secrets and raw private content are absent from logs and audit records;
- applicable CI-equivalent checks pass;
- `AUDIT.md` records changed files, commands, outcomes, and residual risk.
