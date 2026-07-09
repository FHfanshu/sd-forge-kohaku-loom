# Audit Log

## 2026-07-09 Architecture Split

Goal: split oversized backend and browser files, keep files under 1000 lines, and lock the package DAG against circular imports.

### Backend Split

- Commit `71f4652` split `lib_qwen3vl_prompt_tools/generic.py` into focused modules.
- `generic.py` is now a compatibility facade for existing imports.
- New low-level modules: `constants.py`, `utils.py`, `image_payloads.py`, `response_text.py`.
- Runtime/model modules: `model_paths.py`, `llama_runtime.py`, `tagger.py`.
- Assistant modules: `assistant_common.py`, `assistant_gemini.py`, `assistant_local.py`, `assistant.py`, `reference_image.py`, `text_prompting.py`.

### Browser Split

- Commit `7e98d28` split the browser assistant script into ordered files.
- `qwen3vl_prompt_tools.js`: core namespace, config, prompt patch tools.
- `qwen3vl_prompt_tools_assistant.js`: assistant parsing, markdown, streaming, tool loop.
- `qwen3vl_prompt_tools_boot.js`: UI creation, drag behavior, mobile pull-refresh guard, boot hooks.

### Constraints

- Single-file limit: 1000 lines.
- Python package imports must remain acyclic.
- Package modules must not import from `lib_qwen3vl_prompt_tools.generic`; use focused modules directly.

### Verification Notes

- Backend import/unit check passed after the split: `python -m unittest discover -s tests`.
- Browser syntax check passed after the split: `node --check javascript/qwen3vl_prompt_tools*.js`.
- Local model directory confirmed present: `E:\AI\lmcpp\models\Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-GGUF`.
- Local llama-server binary confirmed present: `E:\AI\lmcpp\llama.cpp\llama-server.exe`.
