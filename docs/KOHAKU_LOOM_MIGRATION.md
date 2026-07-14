# Kohaku Loom Migration

## Identity

- Display name: `Kohaku Loom`
- Forge extension directory: `sd_forge_Kohaku_Loom`
- GitHub repository: `sd-forge-kohaku-loom`
- Python package: `kohaku_loom`
- Browser namespace: `window.kohakuLoom`
- HTTP prefix: `/kohaku-loom`
- KohakuTerrarium package: `kohaku-loom`
- Creature: `loom`

KohakuTerrarium is the only floating-assistant controller runtime. There is no
automatic or explicit fallback to the legacy browser-managed Agent loop.

## Scope

Kohaku Loom remains a single-agent product. It does not expose multi-agent
editing, graph management, privileged-node tools, or Terrarium Studio UI.

The same `loom` Creature is packaged so an external KohakuTerrarium can load it
as an ordinary node. Loom does not create or manage the external graph and is
not privileged by default.

The reverse-prompt workbench is owned by the separate
`sd_forge_reverse_prompt` extension. Kohaku Loom keeps only assistant
vision analysis and local llama.cpp/Profile runtime foundations; it does not
register reverse-prompt tabs, WD Tagger controls, or Krea inline actions.

## Runtime Boundary

Forge starts an isolated sidecar on demand. The sidecar runs a minimal Loom API
and KohakuTerrarium. It does not run Studio, the KT web dashboard, TUI, desktop
app, Laboratory, or marketplace UI.

The browser communicates only with same-origin Forge routes. Forge proxies
requests to the sidecar and keeps the sidecar bearer token out of browser
storage. The sidecar binds to `127.0.0.1` on a random port.

The sidecar starts when Loom is first used and stops after 15 minutes with no
active turn or pending browser tool. Forge shutdown also stops it.

## Managed Files

All runtime files stay inside the extension:

```text
.loom/
  venv/
  config/
  sessions/
  cache/
  runtime/
  secrets/
```

The sidecar sets `KT_CONFIG_DIR` to `.loom/config` and must not use the global
`~/.kohakuterrarium` directory. `.loom/` is ignored by Git.

Installation is automatic and logs to Forge stdout. The installer resolves the
latest stable KohakuTerrarium release, records the exact version in
`.loom/runtime/runtime-lock.json`, and keeps it pinned until an explicit user
upgrade. Repair must not delete sessions or secrets.

## Agent And Sessions

The product presents one Agent. Internally, the sidecar uses a one-creature
Terrarium only for supported KT session ownership and resume. This remains an
implementation detail and does not expose a multi-agent surface.

Each chat session maps to one `.kohakutr` file. Only one session is active in
the first release. Closing or refreshing the browser does not cancel a turn;
clients reconnect with an event cursor.

The old `assistant_sessions.sqlite3` database is exposed only through read-only
GET routes. New turns are never dual-written. Continuing an old conversation
creates a new Loom session and carries a bounded transcript forward as context.

## Tool Ownership

KohakuTerrarium owns the controller loop. Browser tools are direct KT tools that
delegate to the active Forge tab and await a correlated reply.

Forge-only tools are registered only while a bridge is available. The browser
remains authoritative for DOM state and preserves read-before-write, prompt and
context hashes, stale-context rejection, preview-first edits, explicit mutation
intent, and tab-scoped bridge identity.

Without Forge, the packaged Creature remains useful for chat, image-prompt
construction, and Danbooru research. Forge mutation tools are omitted.

## Profiles And Secrets

Profiles and secrets move into the sidecar. Loom maps each stored profile
to a KT-native provider or a Loom `BaseLLMProvider` instance, preserving Gemini
native, OpenAI-compatible relays, resident llama endpoints, llama-once,
fallback endpoints, capabilities, usage, and teacher selection.

The new UI may read `q3vl_assistant_profiles_v2` and old `q3vl_assistant_*`
settings once. It deletes those values only after the sidecar confirms an
encrypted import. The browser then scrubs plaintext API keys and retains only a
`has_api_key` marker for settings display and secret-preserving updates.

API keys are encrypted with Windows DPAPI CurrentUser scope under
`.loom/secrets`. Plaintext keys must not enter logs, profile-list responses,
sessions, runtime metadata, or browser storage. The managed runtime is
Windows-first and must not fall back to plaintext on other platforms.

## llama-once

`llama-once` means once per user turn. The server starts before the first model
call, remains alive through tool-result rounds, and terminates after TurnEnded,
cancellation, timeout, or failure.

## Sidecar API

The minimal authenticated API owns health/version, repair/update, encrypted
profiles, sessions, reconnectable turn events, browser tool replies,
cancellation, reference-image analysis, and teacher operations. The browser
never receives the sidecar port or token.

## Default-Runtime Gates

The KT runtime acceptance audit requires all of these:

1. Existing Python and browser regression tests under Loom names.
2. ScriptedLLM tests for tool request/reply, continuation, cancellation, stale
   replies, and reconnect behavior.
3. Sidecar tests for health, authentication, profiles, sessions, SSE replay,
   cancellation, idle shutdown, and repair.
4. A real local-model smoke test with the configured Qwen GGUF and
   `llama-server.exe`.
5. Functional parity for streaming, prompt tools, all model runtimes, KT
   sessions, attachments, local vision, teacher/redaction, and old-session
   read-only access.

The legacy controller routes and browser fallback are removed. Any remaining
acceptance gap must fail explicitly rather than routing a turn through the old
controller.
