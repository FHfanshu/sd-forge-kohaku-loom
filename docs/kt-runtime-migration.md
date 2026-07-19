# KT Runtime Migration

## Archived Version

The final verified old runtime is available at:

```text
branch: kt
tag: kt-final
commit: b016c88
```

The branch and tag were pushed before new-architecture work began. The `kt`
branch is frozen for critical security or compatibility fixes and historical
comparison. New features belong on `main`.

Despite the historical "KT" shorthand, the archived repository contains no
Kotlin source. It uses a managed Python sidecar that embeds the
KohakuTerrarium Python runtime.

## Why Development Stopped

The archived runtime distributes one logical generation across Svelte,
`runtime-controller`, a same-origin proxy, a managed sidecar, a single active
session owner, a browser-tool lease, two replayable SSE streams, a durable
follow-up queue, and Terrarium state.

That design supports background-like recovery, but it introduces recurrent
ownership and convergence failures inside Forge's page lifecycle:

- duplicate or stale session claims;
- bridge claim and release races;
- suspended or orphaned tool requests;
- 409 recovery paths during remount;
- frontend/runtime disagreement after stream loss;
- substantial event replay and queue edge states;
- high installation and maintenance cost for a plugin-local sidecar.

The new product deliberately accepts a simpler refresh contract: persist data,
not execution. Refresh aborts the active request, retains generated partial
content, marks incomplete messages interrupted, and never reconnects or replays
an old tool call.

## New Architecture Entry

The target architecture on `main` is:

```text
Svelte 5 UI
  -> frontend Pi Agent runtime
  -> thin same-origin Python provider proxy
  -> provider

Svelte 5 UI
  -> frontend tool registry
  -> validated Python Forge tool endpoint
  -> Forge operation

Svelte 5 UI
  -> IndexedDB sessions and preferences
```

The intended source boundaries are:

```text
frontend/src/agent/
frontend/src/providers/
frontend/src/tools/
frontend/src/sessions/
backend/prompt_agent/
```

## Old Data

The `main` branch does not keep a complete copy of the old runtime. Old source
is read from `kt` or `kt-final`.

Migration code may read these old locations, but compatibility constants must
remain isolated in migration modules:

```text
.loom/config/profiles.json
.loom/secrets/profiles.dpapi.json
.loom/sessions/*.kohakutr
data/assistant_sessions.sqlite3
loom_assistant_*
q3vl_assistant_*
kohaku-loom:*
```

Profile secrets remain server-side. A migration may import encrypted profile
state through Python, but must never expose decrypted keys to the browser.

The first new session release restores only IndexedDB sessions written by the
new frontend. Old `.kohakutr` and SQLite sessions remain readable from the
archived branch until a bounded, explicit transcript importer is implemented.
No dual-write compatibility runtime will be added.

## Pi Version Boundary

At migration start, the repository pinned Node 22.17.0. Pi `0.80.10` declares
Node `>=22.19.0`, while Pi `0.74.2` declares Node `>=20.0.0`. The first Pi
integration must either upgrade the repository's pinned Node version everywhere
or pin both packages to an API-compatible release. Package versions and imports
must be changed together because the newer Pi provider subpaths differ from
the older API.

## Licensing Gate

The archived root license is the KohakuTerrarium License 1.0. Its naming clause
requires products that incorporate or are substantially derived from that work
to include `Kohaku` or `Terrarium` in primary branding.

The technical migration removes the Terrarium runtime and preserves historical
attribution in this document and Git history. Before distributing a release
under only `SD Forge Neo Prompt Agent`, the maintainer must confirm that the
remaining work can be distributed under the intended license and name, or
obtain permission from the relevant copyright holder. This is a release gate,
not a reason to preserve the old runtime architecture.

## Rollback

Before the new architecture becomes the default Forge extension, rollback is:

```text
git switch kt
```

After a release, rollback must not point both versions at the same writable
session store. The old runtime owns `.loom` and `.kohakutr`; the new runtime
owns the `sd-forge-neo-prompt-agent` IndexedDB database and its new Python
storage paths.
