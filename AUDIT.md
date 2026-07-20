# Active Audit Log

Historical migration entries through 2026-07-19 are preserved in
`docs/audit-archive-2026-07-19-full.md`. The shorter archive index is in
`docs/audit-archive-2026-07-19.md`.

## 2026-07-19 Phase 9 Runtime Removal

- Removed the managed KT/Terrarium sidecar, installer/configuration, old
  provider runtime, frontend KT client, runtime controller, lease/claim paths,
  session ownership, queue/branch/replay runtime, and their contract tests.
- Removed the tracked legacy session sample and deleted local ignored sidecar
  state, SQLite assistant sessions, coverage reports, Playwright artifacts, and
  stale Python bytecode. The active tree does not contain `.loom`.
- Rewrote the active README and session design around Prompt Agent, Python
  profile/provider authority, Pi frontend state, and IndexedDB sessions.
  Historical migration documents are explicitly labeled as historical.
- Removed stale sidecar, queue, branch, and runtime-retry translations and the
  unused archived SSE fixture. The required KohakuTerrarium attribution remains
  because `LICENSE` and `test_kohaku_attribution.py` require it.
- Profile public projections expose configuration flags instead of local paths;
  local path and API key drafts remain component-local until explicit Save.
- Verification: Python compile and 39 Python tests passed before the audit
  archive split; 10 standalone browser contracts passed; Svelte check passed
  with 0 errors and warnings; focused profile/i18n frontend tests passed 21
  tests; mock Playwright passed all 6 scenarios. The full gates are rerun after
  this archive split and generated-bundle rebuild.

## 2026-07-20 Phases 3-9 Completion Audit

- Completed the single Pi runtime lifecycle, provider proxy, provider adapters,
  Forge Agent Tools, Python profile authority, and IndexedDB v2 session work.
- Root cause of the final Phase 6 failures: `ProfileAuthority` accepted only
  `Path` despite normal path-like callers, catalog output trusted extra internal
  fields, and server validation checked generation/patch containers without
  validating every nested value.
- Changed `backend/prompt_agent/profiles.py`,
  `backend/prompt_agent/forge_tools.py`, `backend/prompt_agent/app.py`, and
  `tests/test_forge_tools.py` to accept path-like roots, allowlist catalog
  projections, validate nested patch/generation values, and prevent upstream
  teacher error text from crossing the public API boundary.
- Added `/prompt-agent/api/forge-tools/validate`; the active browser host now
  revalidates prompt and generation tool arguments in Python before reading or
  mutating Forge DOM. Focused API and browser-host tests cover this boundary.
- Added effective provider capability projection in
  `frontend/src/providers/profile-capabilities.ts`. Unsupported capabilities
  are visible in profile settings, and `llama-once` cannot become the active or
  teacher agent profile while remaining available for local session/naming use.
- Added a real browser refresh regression: partial assistant content is durably
  stored, becomes interrupted after reload, a persisted stale tool call does not
  execute, no provider request resumes, and the next submission succeeds.
- Cleanup removed the orphaned `kohaku_loom/tool_args.py`, five unused UI export
  stubs, a duplicate test dependency, empty migration directories, and local
  bytecode/coverage/Playwright artifacts. Legal attribution and rollback/audit
  documents remain intentionally distributed.
- Regenerated `javascript/kohaku_loom_90_ui.js` from `frontend/`; raw size is
  754,078 bytes and gzip size is 215,832 bytes, within the configured budget.
- `python -m compileall -q backend kohaku_loom scripts install.py tools` and
  `python -m unittest discover -s tests`: 74 tests passed before the final
  active-tree marker guard; the focused architecture suite then passed 3 tests.
- `python tools/test_runner.py --max-skips 20`: 74 tests passed with 0 skipped.
- Python branch coverage gate: 76%, above the required 70%.
- Frontend Svelte check: 0 errors and 0 warnings. Frontend coverage: 120 tests
  passed across 20 files with 87.22% statement coverage.
- Frontend build, bundle budget, seven mock-host Playwright scenarios, and
  `node --check javascript/kohaku_loom*.js` passed.
- Active-tree dependency audit found no archived sidecar, lease, ownership,
  queue, branch, replay, or provider-runtime execution path. An API-registration
  startup sentinel reported `.loom` absent before and after registration. A
  permanent architecture test now enforces the archived-runtime marker budget.
- Remaining risk: real Forge/provider/local-model smoke tests require external
  running services and credentials. Phase 10 naming remains blocked by the
  licensing decision and remote repository administration.

## 2026-07-20 Frontend Prompt Agent Naming And Storage Migration

- Root cause: the active hand-authored frontend still exposed archived Kohaku
  Loom branding through bridge globals, DOM hooks, CSS prefixes, i18n routes,
  UI labels, and persisted localStorage keys even after the runtime and API had
  moved to Prompt Agent.
- Changed the scoped frontend source and tests, `frontend/index.html`,
  `frontend/tailwind.config.ts`, and `frontend/README.md` to use Prompt Agent
  identifiers, including `PromptAgentActionHandlers`, `PromptAgentStore`,
  `prompt-agent-host`, `prompt-agent-ui`, `data-prompt-agent-*`, `pa-*`, and
  `/prompt-agent/api/i18n`.
- Added `frontend/src/storage-migrations.ts` and
  `frontend/tests/storage-migrations.test.ts`. Reads prefer canonical Prompt
  Agent keys and migrate each legacy value once; writes and removals touch only
  canonical keys and remove stale legacy values. No secrets or raw user content
  were added to the audit.
- Generated browser output under `javascript/` was not edited or rebuilt. The
  existing unrelated worktree changes outside this scoped frontend increment
  were preserved.
- Verification: pinned Node `22.17.0` / pnpm `10.12.4` returned the expected
  versions; `pnpm run check` found 0 errors and 0 warnings; `pnpm run test`
  passed 21 files and 123 tests; scoped `git diff --check` passed; scoped
  legacy-identifier search found only the six intentional compatibility keys in
  `LEGACY_STORAGE_KEYS`.
- Residual risk: the roadmap's full distributed naming migration remains gated
  by the licensing decision; the six old storage key literals must remain until
  their compatibility migration window is intentionally retired.

## 2026-07-20 Phase 10 Technical Naming Completion

- Completed the active technical rename to Prompt Agent across the Python
  package and Forge script, `/prompt-agent/api` routes, browser filenames and
  namespace, bridge names, browser events, DOM/data identifiers, `pa-*` CSS,
  package metadata, generated asset, tests, and active documentation.
- Removed the runtime `window.kohakuLoom` and `window.KohakuLoomSvelteUi`
  aliases. Shared browser state is authoritative only at
  `window.__SD_FORGE_NEO_PROMPT_AGENT__`; the generated UI is exposed as its
  `ui` property.
- Preserved shipped UI preferences through canonical-first, one-time migration
  of locale, layouts, launcher position, favorites, and recents. The old keys
  are isolated compatibility literals; all writes use Prompt Agent keys.
- Preserved the required visible KohakuTerrarium attribution and root license.
  Added `THIRD_PARTY_NOTICES.md` for KohakuTerrarium, Pi 0.74.2, and TypeBox
  1.1.24. The technical rename does not relicense the repository: release under
  Prompt Agent-only branding, an MIT relicensing, and remote repository rename
  remain gated by copyright permission or independent-licensing evidence.
- Added an active-tree architecture guard against archived technical names,
  with narrow exceptions for historical/legal records, negative assertions,
  and one-time storage migration constants.
- Startup verification found that `prompt_agent/reference_image.py` still
  imported a deleted assistant-model constant. Removed the dead fallback and
  added import, reference-image message, API registration, and `.loom`
  non-creation regression coverage.
- Verification: Python compile passed; 79 tests passed with 0 skips; Python
  branch coverage was 73%, above the 70% gate. Svelte check reported 0 errors
  and 0 warnings; frontend coverage passed 123 tests across 21 files at 87.33%
  statements. Eleven root browser contracts and seven Chromium Playwright
  scenarios passed.
- Vite generated `javascript/prompt_agent_90_ui.js` at 755,214 raw bytes and
  216,261 gzip bytes, within budget. All six Prompt Agent browser scripts passed
  `node --check`; `git diff --check` reported only line-ending warnings.
- The isolated Forge registration sentinel reported
  `before=False after=False callback=prompt-agent-api callbacks=1`.
- Residual risk: real Forge, provider, and local-model smoke tests still require
  running external services and credentials. GitHub repository rename, default
  branch changes, and old remote branch handling require repository admin
  access. No migration change has been committed or pushed.
