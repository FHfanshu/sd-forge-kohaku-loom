# Current Architecture Audit

## Scope

This audit records the verified migration baseline at commit `b016c88`, tagged
`kt-final`. The repository did not contain Kotlin or Gradle sources. The old
runtime called "KT" in code and documentation is a managed Python sidecar that
loads the KohakuTerrarium Python package.

## Repository Layout

```text
creatures/loom/             Terrarium creature and system prompt
frontend/src/               Svelte 5 source
javascript/                 Ordered Forge browser scripts and generated UI
kohaku_loom/                Python package and managed sidecar
scripts/kohaku_loom.py      Forge extension API registration
tests/                      Python contracts and browser-host tests
frontend/tests/             Svelte, runtime, and browser tests
```

Runtime state is also written outside tracked source:

```text
.loom/config/               public profile configuration
.loom/secrets/              DPAPI-encrypted provider secrets
.loom/sessions/             .kohakutr sessions and metadata
.loom/runtime/              sidecar lock and process metadata
data/assistant_sessions.sqlite3
                            read-only legacy sessions
```

## Entrypoints

Forge registers the extension in `scripts/kohaku_loom.py` through
`script_callbacks.on_app_started`. It mounts direct resource APIs and the
same-origin `/kohaku-loom/kt/{path}` proxy.

The managed sidecar starts at `kohaku_loom.sidecar.__main__`, builds FastAPI in
`kohaku_loom/sidecar/app.py`, and owns one `LoomSidecarRuntime` from
`kohaku_loom/sidecar/runtime.py`.

The frontend source starts at `frontend/src/main.ts`. It installs the generated
UI contract through `frontend/src/bootstrap.ts`. The ordered
`javascript/kohaku_loom_99_boot.js` gate mounts the app only after both Forge UI
readiness and the generated Svelte bundle are available.

`frontend/src/runtime-connection.ts` creates `LoomRuntimeController` from
`frontend/src/runtime-controller.ts`. The controller synchronizes profiles,
opens or adopts the single sidecar session, owns the two SSE streams, maps
runtime state into Svelte stores, and performs teardown.

## Runtime Call Chain

```text
Surface.svelte
  -> LoomRuntimeController
  -> KTClient
  -> /kohaku-loom/kt proxy
  -> managed Python sidecar
  -> LoomSidecarRuntime
  -> KohakuTerrarium creature
  -> Python provider implementation
```

The return path is an in-memory sidecar event log exposed as SSE, followed by
snapshot reconciliation from `/runtime` and `/sessions/{id}` after disconnects.

## Bridge And Lease

`javascript/kohaku_loom.js` creates a browser-tab bridge ID and exposes
`claimAssistantToolBridge`, `releaseAssistantToolBridge`, and
`executeAssistantTool`. `javascript/kohaku_loom_07_host.js` publishes those
functions through the host API consumed by `frontend/src/bridge.ts`.

`kohaku_loom/forge_bridge.py` owns `ForgeToolBroker`. It grants one bridge a
ten-second lease, tracks pending tool requests, rejects foreign replies, and
deduplicates pending mutations by a request fingerprint.

`LoomRuntimeController.startToolStream()` claims the bridge, renews it every
five seconds, consumes `/tools/events`, and releases it when a run settles.
Lease loss cancels the accepted turn and returns the composer to a terminal
state.

## Session Ownership

`LoomSidecarRuntime.active` permits one active session per sidecar process.
Opening a second session returns HTTP 409. `frontend/src/runtime-session.ts`
handles the conflict by adopting the requested active session or closing it and
retrying once.

The frontend separately uses `sessionEpoch` to reject stale responses after a
session switch or component teardown.

The older `kohaku_loom/assistant_sessions.py` SQLite controller contains a
different persistent run-lease model. It is no longer the active chat runtime,
but its database remains available through the read-only
`kohaku_loom/legacy_sessions.py` adapter.

## Queue And Replay

The old architecture has three event or queue mechanisms:

1. `kohaku_loom/sidecar/message_queue.py` persists FIFO primary and guidance
   messages inside each `.kohakutr` session.
2. `kohaku_loom/sidecar/event_log.py` stores up to 2,000 runtime events in
   process memory and supports cursor replay over `/turns/events`.
3. `kohaku_loom/forge_bridge.py` stores up to 1,000 browser-tool events in
   process memory and supports cursor replay over `/tools/events`.

`frontend/src/kt/client.ts` reconnects SSE with `Last-Event-ID`. The runtime
controller repairs a clean EOF or network loss by reading the current runtime
snapshot. Full event history is not durable across a sidecar restart.

Branch replay, regeneration, edit-and-rerun, and branch selection live in
`kohaku_loom/sidecar/branch_runtime.py` and are delegated to Terrarium session
history APIs.

## Provider Chain

`kohaku_loom/kt_providers.py` selects one of:

- `ProfileOpenAIProvider` for OpenAI-compatible endpoints;
- `GeminiNativeProvider` for Gemini native requests;
- `LlamaOnceProvider` for a per-turn local llama.cpp process.

Profiles explicitly provide protocol, runtime, endpoint, model, capabilities,
parameters, and local model paths. Provider errors are sanitized by
`kohaku_loom/provider_errors.py`.

The older direct provider chain remains in `kohaku_loom/assistant.py`,
`assistant_openai.py`, `assistant_gemini.py`, and `assistant_local.py`. It is
still used for metadata generation, teacher calls, compatibility tests, and
workload tools.

## Profile Schema

The browser profile implementation is in
`javascript/kohaku_loom_03_profiles.js`. Its schema version is 2 and includes:

```text
id, display_name, enabled, protocol, runtime, endpoint, fallback_endpoints,
model_id, has_api_key, capabilities, parameters, model_info, model_path,
mmproj_path, llama_server_path, n_ctx, n_gpu_layers, thinking
```

The browser persists only public fields. It recognizes the legacy
`loom_assistant_*` and `q3vl_assistant_*` keys during import.

`kohaku_loom/profile_store.py` is authoritative. Public state is stored in
`.loom/config/profiles.json`; API keys are encrypted with Windows DPAPI in
`.loom/secrets/profiles.dpapi.json`. A browser `has_api_key` flag cannot create
a secret, and plaintext keys are scrubbed after confirmed import.

## Session Schema

Current active sessions are `.loom/sessions/{id}.kohakutr` files whose
conversation schema is owned by Terrarium. Loom adds:

- the persisted message queue in the Terrarium session store;
- `{id}.kohakutr.meta.json` title and description metadata;
- process-local runtime and tool event logs;
- branch-view metadata.

The read-only legacy SQLite schema contains `agent_sessions`, `agent_runs`, and
`agent_events`, including persistent lease and event-sequence fields. It is not
the source of truth for new sessions.

## Forge Tool Inventory

Initial model-visible tools are:

```text
load_tool_group
read_prompt
edit_prompt
```

Optional groups add style/resource lookup, Danbooru lookup, teacher calls, and
prompt knowledge. Definitions and disclosure live in
`kohaku_loom/forge_tools.py`, `kohaku_loom/kt_tools.py`, and
`kohaku_loom/sidecar/tool_disclosure.py`.

Actual prompt mutation remains browser-DOM based in
`javascript/kohaku_loom.js`. It enforces read-before-write, prompt/context hash
guards, field targeting, and Forge input/change events. Resource and Danbooru
operations call Python APIs registered by `scripts/kohaku_loom.py`.

## Build And Verification

The frontend is pinned to Node 22.17.0 and pnpm 10.12.4. Vite emits one IIFE to
`javascript/kohaku_loom_90_ui.js`; that generated file is not edited manually.

The migration baseline passed:

```text
240 Python tests, including the required Terrarium contract: pass
146 frontend unit tests with coverage: pass
Svelte check: pass with 0 errors and 0 warnings
Vite production build: pass
Bundle size: 602,204 raw / 170,428 gzip bytes
Ordered browser script syntax checks: pass
git diff --check: pass, with line-ending warnings only
```

## Deletion Dependencies

The old runtime can be deleted only after these replacements are active:

- Pi agent state and event mapping replace `runtime-controller` and KT SSE.
- IndexedDB persistence replaces `.kohakutr` session history for new sessions.
- Python provider proxy replaces `kt_providers` as the network/security boundary.
- Direct request-response Forge tool APIs replace `ForgeToolBroker` and its
  browser lease.
- Python profile CRUD replaces browser-to-sidecar profile import.
- Python local-process APIs replace sidecar-owned llama-once lifecycle.
- The Svelte mount contract no longer depends on `window.kohakuLoom`.

After those boundaries are covered, remove the sidecar manager, sidecar package,
Terrarium requirements, KT tests, queue/replay code, bridge claim/release code,
and old generated scripts in one dependency-checked phase.
