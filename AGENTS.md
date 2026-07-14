# Repository Rules

This extension is loaded inside Forge Neo, so keep changes small and easy to audit.

## Architecture

- Keep every source/documentation file at or below 1000 lines.
- Keep `kohaku_loom.generic` as a compatibility facade only.
- Do not import from `kohaku_loom.generic` inside package modules.
- Preserve the package dependency direction:
  `constants/utils/image_payloads/response_text` -> `model_paths/llama_runtime` -> `assistant_common/assistant_gemini/assistant_local/reference_image` -> `assistant/generic` -> `scripts`.
- Avoid circular imports. Run `python -m unittest discover -s tests` after changing Python module boundaries.

## Frontend

- Browser scripts under `javascript/` are loaded by filename order. Keep `kohaku_loom.js` as the core namespace initializer, then layer assistant and boot scripts after it.
- Shared browser state lives on `window.kohakuLoom`.
- Run `node --check javascript/kohaku_loom*.js` after editing browser scripts when Node is available.

## Local Models

- The local Qwen text/VLM path used for testing is `E:\AI\lmcpp\models\Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-GGUF`.
- The expected local backend binary is `E:\AI\lmcpp\llama.cpp\llama-server.exe` or `LLAMA_SERVER_EXE`.
- Do not commit GGUF models, llama.cpp binaries, logs, cache directories, or generated pyc files.

## Git

- Commit in small verified increments.
- Before each commit, inspect `git status --short`, `git diff --stat`, and recent log.
- Stage only files that belong to the current increment.
