# Archived Kohaku Loom Runtime Contract

> Historical record only. This document describes the runtime frozen at
> `kt-final`. It is not the current architecture or an implementation guide.
> The active design is governed by `ROADMAP.md`, `README.md`, and
> `docs/SESSION_SYSTEM_DESIGN.md`.

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

## Frontend Stack

The generated floating UI uses Svelte 5, TypeScript, Vite library mode,
shadcn-svelte source components backed by Bits UI, and Tailwind CSS. Tailwind
uses the `kl-` prefix with Preflight disabled so Forge remains authoritative for
the host page. The build emits one CSS-injected IIFE at
`javascript/kohaku_loom_90_ui.js`.

The Svelte UI is the only browser renderer. It remains behind the explicit
`UI_READY` gate, and `javascript/kohaku_loom_99_boot.js` mounts it only after
Forge's `onUiLoaded` callback allows startup. The browser files that remain
outside the generated bundle are host adapters for Forge DOM tools, profiles,
locale hints, and the sidecar bridge; they do not construct assistant UI.

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

Messages sent during an active turn use a durable FIFO queue stored in the KT
session. The first pending message remains the next turn; up to five later
messages are offered as live mid-turn guidance. Unclaimed guidance becomes a
normal queued message when the current turn ends. Pending messages may be
edited or cancelled until KT claims them. Successful turns automatically drain
the queue; failure or user cancellation pauses it at the current head.

Transient provider failures retry within the same turn, preserving partial
output while showing attempt state. If a broken stream already emitted a native
tool call, that call is returned to KT instead of retrying the unresolved tool
round. OpenAI-compatible APIs do not expose partial tool deltas after a broken
stream, so ambiguous failures during native-tool rounds fail closed and pause
the durable queue instead of risking a duplicate mutation. Cloud providers use
the `2, 5, 10, 30, 60` schedule with bounded jitter unless `Retry-After`
overrides it. llama-once restarts its server and uses the `1, 2, 4, 8, 16`
schedule with bounded jitter. Browser operations carry stable IDs so a lost
unsafe response can be reconciled without duplicating the turn or queue item.
A later repeated Forge mutation is sent back to the browser to revalidate the
current context hash before changing Forge state.

The old `assistant_sessions.sqlite3` database is exposed only through read-only
GET routes. New turns are never dual-written. Continuing an old conversation
creates a new Loom session and carries a bounded transcript forward as context.

## Tool Ownership

KohakuTerrarium owns the controller loop. Browser tools are direct KT tools that
delegate to the active Forge tab and await a correlated reply.

Forge-only tools are registered for Forge sessions and execute only through the
leased active-tab bridge. The browser remains authoritative for DOM state and
preserves read-before-write, prompt and context hashes, stale-context rejection,
and tab-scoped bridge identity. Prompt edits are immediately applied only after
their read/context guards succeed; stale guards require a fresh read.

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
