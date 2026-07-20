# Repository Rules

This extension is loaded inside Forge Neo, so keep changes small and easy to audit.

## Roadmap

- Read `ROADMAP.md` before planning non-trivial work.
- Current decision order is user experience, stability/data integrity,
  performance, maintainability, then new capability. Security and privacy remain
  hard invariants.
- Prefer work from the earliest incomplete roadmap phase relevant to the affected
  area. New features need a user-visible problem, explicit acceptance criteria,
  and verified failure/recovery behavior.

## Architecture

- Keep every source/documentation file at or below 1000 lines.
- Preserve the package dependency direction:
  `constants/utils/image_payloads/response_text` -> `model_paths/llama_runtime` -> `reference_image` -> `scripts`, with `backend.prompt_agent` depending only on shared leaf modules such as `provider_errors`.
- Avoid circular imports. Run `python -m unittest discover -s tests` after changing Python module boundaries.

## Frontend

- Browser scripts under `javascript/` are loaded by filename order. Keep `prompt_agent.js` as the Forge adapter initializer, then layer resource, host, generated UI, and boot scripts after it.
- Shared browser state lives on `window.__SD_FORGE_NEO_PROMPT_AGENT__`.
- The frontend toolchain is project-local and pinned by `frontend/.node-version`,
  `frontend/package.json`, and `frontend/.npmrc`: use Node `22.17.0` and pnpm
  `10.12.4`; do not use another global Node or pnpm version for installs,
  checks, tests, or builds.
- When a compatible version manager is unavailable, run frontend commands from
  `frontend/` through npm's temporary isolated toolchain, for example:
  `npx --yes --package node@22.17.0 --package pnpm@10.12.4 pnpm install --frozen-lockfile`
  and
  `npx --yes --package node@22.17.0 --package pnpm@10.12.4 pnpm run check`.
- Keep pnpm's package store in `frontend/.pnpm-store/` as configured by
  `frontend/.npmrc`; never commit the store or `frontend/node_modules/`.
- Run `node --check javascript/prompt_agent*.js` after editing browser scripts when Node is available.
- `javascript/prompt_agent_90_ui.js` is generated Vite output and may exceed the 1000-line source limit; never edit it manually. Regenerate it from `frontend/` instead.
- `javascript/prompt_agent_99_boot.js` is an intentionally tiny generated-UI gate and may only call the Svelte mount after `UI_READY` and `onUiLoaded` both allow it.

## Local Models

- The local Qwen text/VLM path used for testing is `E:\AI\lmcpp\models\Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-GGUF`.
- The expected local backend binary is `E:\AI\lmcpp\llama.cpp\llama-server.exe` or `LLAMA_SERVER_EXE`.
- Do not commit GGUF models, llama.cpp binaries, logs, cache directories, or generated pyc files.

## Git

- Commit in small verified increments.
- Before each commit, inspect `git status --short`, `git diff --stat`, and recent log.
- Stage only files that belong to the current increment.

## Bugfix Verification and Audit

- Reproduce UI bugs against the real frontend state transition before changing code; record the visible symptom and the state or event that caused it.
- For session lifecycle bugs, verify success, failure, abort, refresh interruption, and stale-write recovery. A failed request must not leave the composer permanently disabled.
- Add or update a focused regression test for every bugfix when the affected boundary is testable.
- Run the repository CI-equivalent checks that cover the changed files, including generated frontend output when frontend source changes.
- Append a concise entry to `AUDIT.md` with the root cause, changed files, commands run, and their outcomes. Do not include secrets, model files, caches, or raw user content in audit records.
