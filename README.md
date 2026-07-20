# SD Forge Neo Prompt Agent

Single-agent prompt assistant for Forge Neo. The browser owns the Pi agent loop
and IndexedDB chat history; Python owns profiles, secrets, provider streaming,
local-model lifecycle, and privileged Forge tools.

Image reverse prompting is a separate sibling extension:
`sd_forge_reverse_prompt`.

## Features

- Floating assistant for composition, layout, and prompt rewriting
- Frontend Pi runtime: stream, reason, tool calls, abort, terminal recovery
- Python-authoritative Model Profiles (HTTP + local llama.cpp)
- Server-owned secrets; browser never receives plaintext keys or local paths
- IndexedDB sessions with interrupted-message recovery after refresh
- Hash-guarded positive/negative prompt reads and edits
- Forge resource discovery: styles, wildcards, LoRAs, checkpoints, embeddings
- Local reference-image analysis via a configured llama.cpp VLM

## Architecture

API prefix: `/prompt-agent/api`.

| Layer | Owns |
| --- | --- |
| Browser | `PromptAgentRuntime`, UI, IndexedDB sessions, profile selection |
| Python | Extension registration, profiles, secrets, provider proxy, llama.cpp, Forge tools |

No managed sidecar, server-owned chat session, execution lease, or refresh-time
tool replay. Refresh keeps partial content, marks unfinished messages
`interrupted`, and never re-runs an old request.

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

The model only sees these Forge tools (frontend registry + Python validation):

| Tool | Access | Purpose |
| --- | --- | --- |
| `read_prompt` | read | Read positive prompt + hash |
| `edit_prompt` | write | Patch positive prompt with current hash |
| `read_negative_prompt` | read | Read negative prompt + hash |
| `edit_negative_prompt` | write | Patch negative prompt with current hash |
| `read_generation_parameters` | read | Read allowlisted generation controls + hash |
| `apply_generation_parameters` | write | Apply allowlisted generation controls with hash |
| `list_resources` | read | List styles / wildcards / LoRAs (logical IDs) |
| `read_resource_metadata` | read | Bounded metadata for one resource |
| `list_models` | read | Checkpoint IDs/labels (no filesystem paths) |
| `list_loras` | read | LoRA IDs/labels |
| `list_embeddings` | read | Embedding IDs/labels |
| `ask_teacher` | read | One-shot question to a selected teacher profile |

Write tools require a fresh hash from a prior read. Browser arguments are
revalidated by Python before any Forge DOM access. Resource listing is
read-only until an explicit apply/edit tool runs.

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

### Fast local loop

```powershell
python -m compileall -q backend prompt_agent scripts install.py tests
python tests/run_suite.py --max-skips 20
node --check javascript/prompt_agent.js
node --check javascript/prompt_agent_01_i18n.js
node --check javascript/prompt_agent_02_resources.js
node --check javascript/prompt_agent_07_host.js
node --check javascript/prompt_agent_90_ui.js
node --check javascript/prompt_agent_99_boot.js
```

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
python -m coverage run --branch -m unittest discover -s tests
python -m coverage report --fail-under=70
node --test tests/test_frontend_*.js
npx --yes --package node@22.17.0 --package pnpm@10.12.4 pnpm --dir frontend run test:coverage
npx --yes --package node@22.17.0 --package pnpm@10.12.4 pnpm --dir frontend run test:e2e
```

CI runs path-filtered jobs (backend / frontend / e2e) so unrelated changes skip
heavy steps. `workflow_dispatch` and pushes to `main` run the full set.

### Real Forge (local only)

Requires an already-running Forge Neo instance:

```powershell
npx --yes --package node@22.17.0 --package pnpm@10.12.4 pnpm --dir frontend run test:e2e:forge
```

Optional: `FORGE_BASE_URL`, HTTP basic-auth vars, `FORGE_MODEL_PROFILE_ID`.
