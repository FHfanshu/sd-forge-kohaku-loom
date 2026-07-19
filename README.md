# Forge Neo Kohaku Loom

Kohaku Loom is a single-agent prompt assistant for Forge Neo. It provides a floating assistant, Model Profiles, KohakuTerrarium sidecar integration, reference-image analysis, Danbooru lookup, installed-resource discovery, and hash-guarded prompt editing.

Image reverse prompting is intentionally separate. Install or enable the sibling `sd_forge_reverse_prompt` extension for the WD Tagger workbench, Krea2/Qwen3-VL captioning, natural-language reverse prompts, and inline refine/expand/stylize buttons.

## Features

- Floating prompt assistant for composition, character layout, spatial relationships, and prompt rewriting.
- Versioned Model Profiles for Gemini native, OpenAI Chat Completions, remote HTTP, resident llama.cpp endpoints, and one-shot local models.
- Hash-guarded positive/negative txt2img and img2img prompt reads and edits.
- Read-only discovery of installed Wildcards, WebUI Styles, and LoRAs, with explicit native application tools.
- Live Danbooru tag search, inspection, and related-tag lookup for booru-style prompt requests.
- Local reference-image analysis and local Qwen teacher redaction before remote Gemini calls.
- Isolated KohakuTerrarium controller runtime with resumable `.kohakutr` sessions, durable FIFO follow-ups, live mid-turn guidance, and same-origin Forge proxying.
- Provider-aware recovery with visible retry state, partial-output preservation, session token totals, and idempotent guarded Forge mutations.

## Model Profiles

The assistant ships editable profiles for Gemini-native relays, OpenAI-compatible services, resident llama.cpp endpoints, and one-shot local GGUF models. Each profile owns its model ID, protocol, runtime, endpoint list, capabilities, generation parameters, and local model paths.

Profile API keys are encrypted by Windows DPAPI in the sidecar and scrubbed from browser storage after import. New requests do not infer protocol or runtime from model names. Fallback endpoints retry the same profile and model rather than silently switching models.

Local one-shot profiles start `llama-server.exe` for one turn, reuse it through tool round trips, and terminate it when the turn completes, fails, or is cancelled. Set `LLAMA_SERVER_EXE` to configure a trusted local backend path.

## Prompt Tools

The assistant can read and patch the active txt2img/img2img prompt. It must call `read_prompt` before `edit_prompt`; edits require the latest matching hash and are rejected if the user changed the field in between.

Resource discovery is read-only. When the assistant applies a selected Wildcard, LoRA, or Style, it first verifies the latest Forge context hash; Wildcards remain `__name__`, LoRAs remain `<lora:alias:weight>`, and Styles use Forge's native selector.

Danbooru tools query the public tag database and return prompt-ready space-separated names while keeping canonical underscore names for lookup only.

## Reference Images

Attached images can be analyzed locally by the configured VLM. In the default teacher workflow, the local model creates visual notes and a sanitized briefing before Gemini is called. `SAFE_SLOT_###` placeholders stay local and are restored in returned tool arguments.

## KohakuTerrarium

The managed sidecar is installed under `.loom/` and does not modify Forge's Python environment. It binds to localhost on a random port with a random bearer token; the browser communicates only through Forge's same-origin `/kohaku-loom/kt/` proxy.

Runtime files are stored under:

```text
.loom/
  venv/
  config/
  sessions/
  cache/
  runtime/
  secrets/
```

The product remains a single-agent, one-creature Loom surface. It does not expose Terrarium Studio or graph-management UI.

Powered by [KohakuTerrarium](https://github.com/Kohaku-Lab/KohakuTerrarium). Kohaku Loom is distributed under the included [KohakuTerrarium License 1.0](LICENSE).

## API Prefix

Forge routes use `/kohaku-loom`. Assistant Profiles, sessions, turns, tool replies, and SSE events use the `/kohaku-loom/kt/` proxy. Legacy SQLite chats are available through read-only `/kohaku-loom/legacy-sessions` GET routes.

## Verification

```powershell
python tools/test_runner.py --max-skips 20
python -m coverage run --branch -m unittest discover -s tests
python -m coverage report --fail-under=70
node --check javascript/kohaku_loom.js
node --check javascript/kohaku_loom_01_i18n.js
node --check javascript/kohaku_loom_02_resources.js
node --check javascript/kohaku_loom_03_profiles.js
node --check javascript/kohaku_loom_07_host.js
node --check javascript/kohaku_loom_90_ui.js
node --check javascript/kohaku_loom_99_boot.js
cd frontend
npm run check
npm test
npm run test:coverage
npm run build
npm run test:e2e
```

The real-Forge Playwright check is local-only and is intentionally excluded
from the GitHub Actions browser job. It requires an already-running Forge Neo
instance with Kohaku Loom loaded. It verifies the production prompt bridge,
tablet floating settings, the selected profile's real connection test, and a
real composer/tool turn that changes and then restores the `txt2img` prompt:

```powershell
npx --yes --package node@22.17.0 --package pnpm@10.12.4 pnpm --dir frontend run test:e2e:forge
```

Use `FORGE_BASE_URL` to target a NATFRP or other Forge URL. Set
`FORGE_HTTP_USERNAME` and `FORGE_HTTP_PASSWORD` when the origin uses HTTP basic
authentication, and set `FORGE_MODEL_PROFILE_ID` to select the profile that must
pass the real model/composer check. The test does not start the mock Vite host or
a second Forge process. Provider failures are expected to fail this suite; the
UI must still return the Test control to a usable state within its bounded
deadline and report the redacted direct/system-proxy route.

For local runtime tests, the expected model and backend can be configured with Model Profiles or `LLAMA_SERVER_EXE`. Downloaded models, llama.cpp binaries, logs, caches, and sidecar state are excluded from Git.
