# SD Forge Neo Prompt Agent

Single-agent prompt assistant for Forge Neo. The browser owns the Pi agent loop
and keeps an IndexedDB session cache; Python owns durable synchronized chat
history, profiles, secrets, provider streaming, local-model lifecycle, and
privileged Forge tools.

Image reverse prompting is a separate sibling extension:
`sd_forge_reverse_prompt`.

## Features

- Floating assistant for composition, layout, and prompt rewriting
- Frontend Pi runtime: stream, reason, tool calls, abort, terminal recovery
- Python-authoritative Model Profiles (HTTP + local llama.cpp)
- Server-owned secrets; browser never receives plaintext keys or local paths
- Cross-browser sessions with a server-side SQLite authority and IndexedDB cache
- Interrupted-message recovery after refresh without request or tool replay
- Hash-guarded positive/negative prompt reads and edits
- Forge resource discovery: styles, wildcards, LoRAs, checkpoints, embeddings
- Local reference-image analysis via a configured llama.cpp VLM

## Architecture

API prefix: `/prompt-agent/api`.

| Layer | Owns |
| --- | --- |
| Browser | `PromptAgentRuntime`, UI, IndexedDB session cache, profile selection |
| Python | Durable session snapshots, profiles, secrets, provider proxy, llama.cpp, Forge tools |

The server stores history but never owns or resumes agent execution. There is no
managed sidecar, execution lease, or refresh-time tool replay. Refresh keeps
partial content, marks unfinished messages `interrupted`, and never re-runs an
old request. Concurrent stale edits are retained as conflict-copy sessions.

Anyone who can use the Forge web UI can access synchronized Prompt Agent
history. Do not expose Forge to an untrusted network without authentication.

### Layout

```text
backend/prompt_agent/   # API, profiles, provider proxy, Forge tool validation
prompt_agent/           # shared leaf modules (i18n, resources, llama helpers)
scripts/                # Forge extension entry
frontend/               # Svelte 5 source (build only)
javascript/             # Forge-loaded browser scripts (incl. generated UI)
tests/                  # Python + small host-script checks; tests/run_suite.py
docs/                   # active product docs
docs/archive/           # KT migration history (not product surface)
data/                   # local runtime state (gitignored)
```

## Agent tools

The model only sees these tools (frontend registry + Python validation / host):

| Tool | Access | Purpose |
| --- | --- | --- |
| `read_prompt` | read | Read `positive` or `negative` prompt + hash |
| `edit_prompt` | write | Patch selected prompt field; full overwrite only when empty |
| `read_generation_parameters` | read | Read allowlisted generation controls + hash |
| `apply_generation_parameters` | write | Apply allowlisted generation controls with hash |
| `search_resources` | read | Search styles, wildcards, LoRAs, models, embeddings |
| `inspect_resource` | read | Inspect one resource by logical ID |
| `search_danbooru_tags` | read | Live Danbooru tag search for 1–12 concepts |
| `inspect_danbooru_tags` | read | Inspect 1–12 tags (+ optional wiki) |
| `related_danbooru_tags` | read | Related tags for one verified seed |

The model receives 9 tools: 7 read-only and 2 write tools. Write tools require a
fresh hash from a prior read. Non-empty prompt fields must
use `patches` or `diff`; a full `prompt` body is accepted only when the current
field is empty. Browser arguments are revalidated by Python before Forge DOM
access. `ask_teacher` is removed.

## Model profiles

Profiles define model ID, protocol, runtime, endpoint, capabilities, generation
parameters, and local runtime config. Public APIs only expose safe status flags
(for example “has API key / has local path configured”).

Local one-shot profiles use a server-configured `llama-server.exe` via
`LLAMA_SERVER_EXE`. Browser requests cannot inject executable or model paths
into generation endpoints.

## License

[MIT License](LICENSE). Third-party notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Historical KT/Terrarium runtime remains only on branch `kt` / tag `kt-final`.

## Verification

Pinned frontend toolchain: Node `22.17.0`, pnpm `10.12.4`.

Critical user behavior and cross-layer contracts are versioned in
`quality/acceptance.json`. Ordinary unit tests stay lightweight. The acceptance
gate detects stale high-level tests before they can force production code back
to an older design.

### Fast local loop

```powershell
python tools/test_gate.py affected
```

`affected` first checks acceptance versions and then runs tests mapped to the
changed boundaries. A stale acceptance test is reported and skipped during this
development loop instead of forcing an immediate production-code rollback.

### Frontend (when UI/source changes)

```powershell
npx --yes --package node@22.17.0 --package pnpm@10.12.4 pnpm --dir frontend install --frozen-lockfile
npx --yes --package node@22.17.0 --package pnpm@10.12.4 pnpm --dir frontend run check
npx --yes --package node@22.17.0 --package pnpm@10.12.4 pnpm --dir frontend run test
npx --yes --package node@22.17.0 --package pnpm@10.12.4 pnpm --dir frontend run build
npx --yes --package node@22.17.0 --package pnpm@10.12.4 pnpm --dir frontend run bundle:size
```

### Full / CI-equivalent

```powershell
python tools/test_gate.py full
```

The full gate blocks stale acceptance mappings, expired flaky-test waivers,
implementation regressions, generated-bundle drift, browser acceptance failures,
and bundle-budget failures. CI keeps its path-filtered jobs for parallel speed
but runs the same acceptance preflight before dispatching them.

When product behavior intentionally changes, review the current acceptance first:

```powershell
python tools/test_gate.py behavior-change UI-WINDOW-001
python tools/test_gate.py behavior-change UI-WINDOW-001 --bump
```

The bump intentionally makes mapped high-level tests stale until their assertions
are reviewed. Do not bump revisions for a bugfix that restores already-documented
behavior.

### Real Forge (local only)

Requires an already-running Forge Neo instance:

```powershell
npx --yes --package node@22.17.0 --package pnpm@10.12.4 pnpm --dir frontend run test:e2e:forge
```

Or run the release gate, which adds coverage and real-Forge evidence:

```powershell
python tools/test_gate.py release
```

Optional: `FORGE_BASE_URL`, HTTP basic-auth vars, `FORGE_MODEL_PROFILE_ID`.
