# Audit Log

## 2026-07-16 Svelte UI Cutover

- Svelte 5 is now the only assistant and Model Profiles renderer.
- Removed the browser-managed assistant loop, legacy session UI, duplicate
  attachment/reasoning helpers, legacy settings/model-catalog UI, and the
  accumulated root `style.css`.
- Retained filename-ordered browser scripts only for the Forge host bridge,
  prompt/resource tools, profile persistence, locale hints, and generated
  Svelte boot.
- Added browser-side image optimization and payload limits, frame-coalesced
  streaming updates, final-only Markdown rendering, localized tab-safe prompt
  targeting, and active KT risk-mode synchronization.

## 2026-07-09 Architecture Split

Goal: split oversized backend and browser files, keep files under 1000 lines, and lock the package DAG against circular imports.

### Backend Split

- Commit `71f4652` split `kohaku_loom/generic.py` into focused modules.
- `generic.py` is now a compatibility facade for existing imports.
- New low-level modules: `constants.py`, `utils.py`, `image_payloads.py`, `response_text.py`.
- Runtime/model modules: `model_paths.py`, `llama_runtime.py`.
- Assistant modules: `assistant_common.py`, `assistant_gemini.py`, `assistant_local.py`, `assistant.py`, `reference_image.py`.

### Browser Split

- Commit `7e98d28` split the browser assistant script into ordered files.
- `kohaku_loom.js`: core namespace, config, prompt patch tools.
- `kohaku_loom_assistant.js`: assistant parsing, markdown, streaming, tool loop.
- `kohaku_loom_boot.js`: UI creation, drag behavior, mobile pull-refresh guard, boot hooks.

### Constraints

- Single-file limit: 1000 lines.
- Python package imports must remain acyclic.
- Package modules must not import from `kohaku_loom.generic`; use focused modules directly.

### Verification Notes

- Backend import/unit check passed after the split: `python -m unittest discover -s tests`.
- Browser syntax check passed after the split: `node --check javascript/kohaku_loom*.js`.
- Local model directory confirmed present: `E:\AI\lmcpp\models\Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-GGUF`.
- Local llama-server binary confirmed present: `E:\AI\lmcpp\llama.cpp\llama-server.exe`.
- Final unittest/compile/browser checks passed after all commits.
- Local Qwen one-shot assistant was exercised with `local-qwen-once` and returned `local qwen assistant ok` from source `one-shot-local-qwen`.
- Moyuu/Gemini route was exercised without a token and reached the remote API, which returned 401 `Invalid token`; live Gemini teacher inquiry requires a configured API key.

## 2026-07-09 Local Qwen Teacher Redaction

- Gemini teacher mode now defaults to local Qwen redaction before remote calls.
- Browser attachments no longer go directly to Gemini in the default mode; local Qwen VLM analyzes/redacts first.
- `teacher_mode=regex` remains available as an advanced fallback for placeholder-only redaction.
- Default local VLM preset is `Qwen3.5 破限版 9B` to match the local testing model path.

## 2026-07-09 Ask Teacher Tool

- Added `ask_teacher` to the assistant tool schema for local Qwen-to-Gemini teacher consultation.
- Added `/kohaku-loom/ask-teacher`; teacher requests force `teacher_mode=regex` and disable Gemini-side tools to avoid recursion.
- Browser tool execution now posts sanitized `question` / `context` to the teacher endpoint and returns the result to the agent loop.
