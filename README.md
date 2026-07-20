# SD Forge Neo Prompt Agent

SD Forge Neo Prompt Agent is a single-agent prompt assistant embedded in Forge Neo. The browser owns the Pi agent loop and IndexedDB chat history; Python provides profile authority, protected provider credentials, provider streaming, local-model lifecycle, and privileged Forge integrations.

Image reverse prompting is intentionally separate. Install or enable the sibling `sd_forge_reverse_prompt` extension for the WD Tagger workbench, captioning, natural-language reverse prompts, and inline refine/expand/stylize actions.

## Features

- Floating prompt assistant for composition, character layout, spatial relationships, and prompt rewriting.
- Frontend Pi runtime with streaming, reasoning display, cancellation, and terminal failure recovery.
- Python-authoritative Model Profiles for remote HTTP and local llama.cpp runtimes.
- Visible effective-capability limits; unsupported runtimes cannot be selected for agent chat.
- Secrets protected by the server and never returned to browser profile state.
- IndexedDB-owned sessions and messages with interrupted-stream recovery after refresh.
- Hash-guarded positive and negative txt2img/img2img prompt reads and edits.
- Installed Wildcard, WebUI Style, and LoRA discovery.
- Danbooru tag search, inspection, and related-tag lookup.
- Local reference-image analysis through a configured llama.cpp VLM.

## Architecture

The active assistant API is `/prompt-agent/api`.

The browser owns:

- `PromptAgentRuntime` and Pi generation state;
- streaming, reasoning, tool-call, and abort UI;
- IndexedDB session history and preferences;
- profile and model selection.

Python owns:

- Forge extension registration and privileged operations;
- profile storage under `data/prompt-agent/` or `SD_FORGE_NEO_PROMPT_AGENT_DATA`;
- protected provider secrets and request authorization;
- provider stream proxying;
- local model paths and llama.cpp process lifecycle.

There is no managed assistant process, server-owned chat session, execution ownership protocol, follow-up message queue, or refresh-time execution replay. Refresh restores persisted content, marks unfinished messages interrupted, and never re-executes an earlier request.

## Model Profiles

Profiles define the model ID, protocol, runtime, endpoint, capabilities, generation parameters, and local runtime configuration. API keys and local filesystem paths are server-owned. Public responses expose only safe status fields such as whether a key or local path is configured.

Local one-shot profiles use a server-configured `llama-server.exe`. Set `LLAMA_SERVER_EXE` to configure a trusted backend path. Browser requests cannot supply executable or model paths to generation endpoints.

## Prompt Tools

Forge prompt mutations are guarded by a current-state hash. A mutation must read the live Forge state before editing and is rejected if the user changed the field in between. Browser-host prompt and generation tool arguments are revalidated by Python before Forge DOM access. Resource discovery is read-only until an explicit apply request.

## Reference Images

Attached images can be analyzed locally by the configured VLM. Local model files, binaries, logs, caches, and generated image payloads are not committed.

## Attribution

Powered by [KohakuTerrarium](https://github.com/Kohaku-Lab/KohakuTerrarium). This distribution includes the [KohakuTerrarium License 1.0](LICENSE). The archived KohakuTerrarium-based runtime is retained only in Git branch `kt` and tag `kt-final`; it is not part of the active startup path.

## License Status

The repository remains distributed under the root [KohakuTerrarium License 1.0](LICENSE). The technical runtime and identifiers have moved to Prompt Agent, but that license includes naming and visible-attribution terms. A release whose primary branding omits `Kohaku` and `Terrarium`, or a change to MIT, requires permission from the relevant copyright holder or evidence that the remaining implementation is independently licensable. The MIT licenses of the Pi and TypeBox dependencies do not relicense this repository. See [Third-Party Notices](THIRD_PARTY_NOTICES.md) and the [migration licensing gate](docs/kt-runtime-migration.md#licensing-gate).

## Verification

Use the repository-pinned Node `22.17.0` and pnpm `10.12.4` toolchain.

```powershell
python -m compileall -q backend prompt_agent scripts install.py tools
python tools/test_runner.py --max-skips 20
python -m coverage run --branch -m unittest discover -s tests
python -m coverage report --fail-under=70
node --test tests/test_frontend_*.js
node --check javascript/prompt_agent.js
node --check javascript/prompt_agent_01_i18n.js
node --check javascript/prompt_agent_02_resources.js
node --check javascript/prompt_agent_07_host.js
node --check javascript/prompt_agent_90_ui.js
node --check javascript/prompt_agent_99_boot.js
npx --yes --package node@22.17.0 --package pnpm@10.12.4 pnpm --dir frontend run check
npx --yes --package node@22.17.0 --package pnpm@10.12.4 pnpm --dir frontend run test:coverage
npx --yes --package node@22.17.0 --package pnpm@10.12.4 pnpm --dir frontend run build
npx --yes --package node@22.17.0 --package pnpm@10.12.4 pnpm --dir frontend run bundle:size
npx --yes --package node@22.17.0 --package pnpm@10.12.4 pnpm --dir frontend run test:e2e
```

The local-only real Forge check requires an already-running Forge Neo instance:

```powershell
npx --yes --package node@22.17.0 --package pnpm@10.12.4 pnpm --dir frontend run test:e2e:forge
```

Use `FORGE_BASE_URL`, optional HTTP basic-auth variables, and `FORGE_MODEL_PROFILE_ID` to select the real target. The test does not start another Forge process.
