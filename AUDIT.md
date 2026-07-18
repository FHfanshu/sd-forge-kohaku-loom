# Audit Log

## 2026-07-18 Recoverable Svelte Host Bootstrap and Server-Authoritative Sessions

- Visible problem: the generated Svelte bundle synchronously required a complete
  Forge host API while it was evaluating, and the final boot script had only one
  chance to observe both the bundle and `onUiLoaded`. A harmless script-order
  delay could therefore leave no UI. The Surface also treated a missing host as
  a permanent disconnected state and previously allowed no-op/local fallback
  behavior instead of waiting for the real controller.
- Bootstrap fix: `frontend/src/bootstrap.ts` always installs
  `window.KohakuLoomSvelteUi`, exposes the host through a dynamic getter, and
  emits `kohaku-loom:svelte-ready` without validating host readiness. The
  generated bundle can mount before host registration and reuses one mount
  target. `javascript/kohaku_loom_99_boot.js` is now a bounded retry state
  machine with a small non-Svelte fatal panel and Retry action. It still requires
  Forge's `onUiLoaded` callback before mounting, so delayed ordering does not
  bypass the host lifecycle gate.
- Connection fix: `waitForHostApi()` provides cancellable 15-second polling.
  `frontend/src/runtime-connection.ts` owns async controller creation, while
  `Surface.svelte` renders connecting/failed/retry states, aborts pending work on
  teardown, and preserves drafts and attachments on connection failure. Opening
  the launcher only opens and focuses the UI; the first send lazily adopts or
  creates a session. Production send no longer silently falls through to a no-op
  or locally fabricated user message.
- Bridge degradation: validation now requires only the core profile, lease,
  assistant-config, and session-runtime capabilities/functions. Missing legacy
  history and locale integrations degrade to an empty archive or browser locale;
  unavailable optional prompt/profile utilities fail only when invoked. No
  second renderer or controller was added.
- Session fix: `openSessionInternal()` reads `/runtime` first, directly resumes a
  matching active session, closes a different active session before opening the
  target, and applies conversation state only after an epoch check. Destroy and
  explicit new-session transitions invalidate late responses. The focused
  `runtime-session.ts` helper handles `/sessions/open` HTTP 409 by rereading the
  server runtime, adopting the matching session or closing the conflicting
  session and retrying once. KT endpoints, payloads, provider code, sidecar
  persistence, and durable session formats are unchanged.
- Regression coverage: bootstrap tests install the Svelte contract before the
  host exists; bridge tests cover 500 ms late registration and optional
  capability degradation; runtime tests cover active-session adoption, matching
  history resume, different-session close/open ordering, destroy versus late
  responses, first-send ordering, and 409 recovery. A Node script test verifies
  boot retries without mounting before `onUiLoaded`. Mock Chromium delays host
  registration by 2.5 seconds and observes connecting to ready while all existing
  desktop, attachment, queue, phone, and tablet scenarios remain green.
- Verification with Node `22.17.0` and pnpm `10.12.4`: Vitest coverage passed 126
  tests at 83.92% lines/statements, 71.96% branches, and 72.55% functions;
  `svelte-check` reported 0 errors and 0 warnings; Python passed 225 tests with
  20 expected skips; Vite built 4,017 modules; all eight browser scripts passed
  syntax checks; six mock Chromium E2E tests and the bundle-size check passed.
  The generated bundle is 595,422 raw bytes and 167,459 gzip bytes. Source limits
  remain valid: `runtime-controller.ts` is 994 lines and the new connection and
  session helpers are 15 and 31 lines.

## 2026-07-18 Frontend Review Recovery and First-Send Session Ordering

- Review root causes: reopening the launcher implicitly replaced the current
  session and draft; disconnected UI exposed mock history; failed or paused
  queue state had no recovery affordance; an initial tool-bridge claim rejection
  could escape its async task; Forge snapshots grew without a bound; profile
  field edits synchronized on every event; legacy i18n boot duplicated the
  Svelte locale requests; and `replace` accepted an ambiguous
  `allow_multiple` flag.
- Fix: `frontend/src/components/Surface.svelte` now restores the existing chat
  when the launcher opens, exposes disconnected state, and offers retry for
  failed queue entries while preserving the existing explicit new-chat action.
  `frontend/src/runtime-controller.ts` recovers bridge-claim failures, supports
  synchronous or asynchronous lease release, caps Forge snapshots at 32, and
  keeps queue recovery on the existing KT retry endpoint. Profile updates are
  coalesced for 250 ms, legacy i18n no longer preloads unused bundles, and
  ambiguous prompt replacement now directs callers to `replace_all` or
  `replace_n`. KT endpoints, provider code, sidecar persistence, and request
  protocols were not changed.
- Browser regression found during verification: a first send without an
  in-memory session set `activeRun` before lazy session creation. The session
  switch guard then rejected that same unsubmitted run with `Cannot switch
  sessions while a turn is active`, leaving the composer populated. Session
  creation now completes before the run becomes active; the active-run check is
  repeated afterward so a concurrent accepted turn still routes the message to
  the existing queue path.
- Regression coverage: Surface tests cover launcher draft/session preservation,
  disconnected state, failed queue retry, and explicit new-session ordering.
  Runtime tests cover initial bridge rejection, snapshot bounds, profile sync
  coalescing, and first-send session creation before `/turns`. Node-backed host
  tests assert legacy i18n performs no load-time fetch and ambiguous replace is
  rejected. Mock Chromium verifies first send, attachment wire payloads, active
  turn queueing, cancellation, and phone/tablet layouts.
- Verification with Node `22.17.0` and pnpm `10.12.4`: Vitest coverage passed 117
  tests at 83.49% lines/statements, 71.45% branches, and 72.19% functions;
  `svelte-check` reported 0 errors and 0 warnings; Python passed 224 tests with
  20 expected skips; Vite production build, all eight browser syntax checks,
  bundle-size checks, and all five mock Chromium E2E tests passed. The generated
  bundle is 592,607 raw bytes and 166,636 gzip bytes. Source limits remain valid
  at 996 lines for `runtime-controller.ts` and 989 lines for `styles.css`.

## 2026-07-18 Frontend-Only Attachment Refactor and Edit-Rerun Recovery

- Attachment root cause: selecting an image immediately converted the optimized
  file to a Base64 data URL, then copied that expanded string through reactive
  composer state, request JSON, queue payloads, and durable message state. Queue
  create/edit requests also repeated the same image in both `content` and a
  top-level `attachments` field.
- Scope: this refactor changes only frontend source, tests, and generated UI
  output. KT endpoints, sidecar code, provider code, session persistence, and the
  existing structured `content` request format are unchanged.
- Fix: new browser attachments use an explicit local `Blob`/object-URL type while
  persisted attachments retain the existing `data:` representation. Base64
  materialization is deferred until send, queue, or edit-rerun crosses the
  existing KT request boundary and is cached per attachment. The chat store owns
  message previews through reference counts, so accepted messages keep a `blob:`
  preview without retaining a Base64 copy in reactive UI state. Object URLs are
  released when their final composer/message/edit owner is removed. Rejected
  sends and failed session creation preserve the draft and attachment preview.
  Browser queue state and `localStorage` retain only attachment counts, never
  Base64 image bodies; KT remains the authoritative durable queue source. Queue
  create and edit requests carry the image once in the unchanged `content` field.
- Regression coverage: attachment tests verify blob preview, deferred and
  one-time Base64 encoding, idempotent revocation, and old `data:` compatibility.
  Surface tests cover accepted and rejected sends, remove, replace, teardown, and
  persisted previews, shared message ownership, failed session creation, and
  Base64-free queue storage. Runtime tests assert exactly one image copy in queue
  POST and PATCH bodies. Mock Chromium verifies a real file input produces and
  retains a `blob:` message preview while sending one wire image.
- Same-page Chromium measurement: for an 8 MiB Blob over 12 warm samples,
  immediate `FileReader.readAsDataURL()` measured 13.9-30.9 ms with a 15.2 ms
  median and produced 11,184,812 Base64 characters; object-URL preview creation
  measured 0.2-0.3 ms with a 0.3 ms median. This isolates preview preparation and
  does not claim end-to-end image decode or resize time.
- Real Forge acceptance: opened the latest non-empty KT session after the
  launcher-created empty session, edited its persisted user message through the
  existing Send button, and observed HTTP 200 from
  `/sessions/{id}/edit-rerun`. The selected branch persisted the edited text and
  existing image, the UI showed message version 2/2, and switching to 1/2 and
  back confirmed the original branch remained intact. The local provider marked
  the new branch failed, but no active turn or queue item remained and the
  composer recovered; full generated-answer acceptance remains blocked by the
  configured local provider failure rather than edit/session integrity.
- Verification: pinned Node `22.17.0` / pnpm `10.12.4` `pnpm test` passed 111
  tests; `pnpm check` reported 0 errors and 0 warnings; `python -m unittest
  discover -s tests` passed 222 tests with 20 expected skips; production build,
  browser-script syntax checks, all five mock Chromium E2E tests, and bundle-size
  checks passed. The generated bundle is 591,245 raw bytes and 166,304 gzip bytes.

## 2026-07-18 Proxy Diagnostics, Connection Recovery, and Tablet Windows

- Real reproduction: a touch tablet was classified as mobile solely because it
  exposed a coarse pointer, so Model Profiles was forced to the full visual
  viewport. The production profile connection test had no browser or server
  deadline and could leave the Test action busy indefinitely.
- Proxy diagnosis: Windows WinINET and WinHTTP both resolve to
  `127.0.0.1:7890`; the managed sidecar's Python/HTTPX environment resolved the
  same HTTP/HTTPS proxy plus loopback bypass, the proxy port accepted TCP, and a
  sidecar-interpreter HTTPS request to the configured remote host returned HTTP
  200. The Forge-to-sidecar loopback HTTPX client now sets `trust_env=False`,
  while provider SDK clients retain system/environment proxy discovery.
- Connection fix: the frontend sends a bounded test timeout and an abort signal;
  the sidecar enforces the deadline, cleans up cancelled providers, and reports a
  credential-safe error plus a redacted direct/system-proxy route. Live checks
  now report the configured `grok` profile as HTTP 401 through
  `system/environment proxy http://127.0.0.1:7890`, while `moyuu-gemini` reaches
  the explicit timeout on the same route. Controls recover after both failures.
- Tablet fix: coarse-pointer devices with a short edge of at least 600px reuse
  the existing floating desktop layouts; narrow portrait phones and short-edge
  landscape phones remain mobile/full-screen. No persisted layout schema was
  added. Model Profiles now also tracks visual-viewport resize/scroll events.
- Local-only Playwright now accepts NATFRP/basic-auth origin variables, verifies
  tablet floating settings, runs the selected profile's real connection test,
  and attempts a real composer/tool prompt edit with `finally` restoration. The
  direct production prompt-bridge case passes; the full model case currently
  fails because no configured remote profile returns a usable response, rather
  than because of the proxy or UI lifecycle.
- Verification: `python -m unittest discover -s tests` passed 222 tests with 20
  expected skips; Vitest passed 102 tests; `svelte-check` reported 0 errors and
  0 warnings; all five mock Chromium E2E cases passed, including phone and
  tablet layouts. Vite produced a 588,170-byte bundle at 165,385 gzip bytes and
  browser syntax checks passed. The real-Forge prompt mutation/restoration case
  passed; the intentionally strict model acceptance remains blocked by the live
  profile responses described above.

## 2026-07-18 Forge Startup and Composer State Recovery

- Startup symptom: Forge bound `127.0.0.1:7860`, but Gradio failed while
  generating its API schema and then reported localhost as inaccessible.
  Root cause was a polluted Forge venv: Pydantic had been upgraded to `2.12.5`
  while Forge pins `2.10.6`; Gradio `4.40.0` cannot parse the newer boolean JSON
  Schema shape. Restored Pydantic `2.10.6` and pydantic-core `2.27.2`; a real
  `webui-user.bat` launch returned HTTP 200 with the Loom bundle present and no
  stderr output.
- Composer root cause: one `activeRequestId` represented submission, acceptance,
  generation, tools, and cancellation. The UI therefore showed Thinking before
  `/turns` was accepted, retained the submitted draft until the whole turn ended,
  and exposed queue submission as the primary send action while active.
- Refactored the frontend lifecycle to distinguish submitting, thinking,
  generating, tool, and cancelling. `/turns` is no longer blocked by the Forge
  tool-bridge lease; the draft clears only after the turn or queue API accepts it,
  without deleting text typed while acceptance was pending. The active primary
  action is Stop, with a separate explicit Queue action.
- Queue cancellation now removes the item optimistically, reconciles failed or
  ambiguous cancellation against the authoritative session, and rolls back only
  when state cannot be recovered. Queue responses and SSE events share one
  ID/sequence-aware reducer so duplicate or stale updates cannot recreate items.
- Changed frontend state/controller/components, added `frontend/src/runtime-state.ts`,
  updated English/Chinese working labels, regenerated
  `javascript/kohaku_loom_90_ui.js`, and expanded focused unit/E2E coverage.
- Verification: 217 Python tests passed with 0 skips; Svelte check reported 0
  errors/warnings; 92 frontend unit tests passed; frontend coverage passed at
  80.35% lines/statements, 69.58% branches, and 67.72% functions before the
  no-behavior helper extraction; production build and 165,071-byte gzip bundle
  budget passed; all 4 Chromium E2E tests passed; browser bundle syntax passed.

## 2026-07-17 Project-Local Node and pnpm Environment

- Dependency inspection confirmed that `frontend/package.json` requires Node 22
  and pnpm 10, with pnpm `10.12.4` already pinned, while the host exposed Node
  `25.5.0` and no global pnpm, Corepack, or Volta.
- Added `frontend/.node-version` to pin Node `22.17.0` and `frontend/.npmrc` to
  enforce package engines and keep the pnpm store under `frontend/.pnpm-store/`.
- Updated `frontend/.gitignore` and `AGENTS.md` so agents use the project-local
  versions and can invoke them through an isolated npm `npx` toolchain without
  installing or changing global Node/pnpm state.
- Verification: isolated `node --version` returned `v22.17.0`; isolated
  `pnpm --version` returned `10.12.4`; dependency installation and frontend
  checks were run with these pinned versions.

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

## 2026-07-17 Frontend Transition and Viewport Verification

- Root causes addressed: the architecture line-limit scan included ignored frontend coverage HTML; mobile profile settings were constrained to a desktop-style inset; the launcher/session transition needed to preserve the submitted payload while session creation completed.
- Changed `tests/test_architecture.py`, `frontend/src/components/Surface.svelte`, `frontend/src/styles.css`, and regenerated `javascript/kohaku_loom_90_ui.js`.
- `python -m unittest discover -s tests`: 207 passed, 20 skipped.
- `python tools/test_runner.py --max-skips 20`: 207 passed, 20 skipped; skip budget passed.
- Python coverage: 71% line coverage; `--fail-under=70` passed.
- Frontend checks: 79 tests passed with 79.58% lines, 69% branches, and 66.27% functions; all configured thresholds passed.
- Svelte check, production build, bundle-size check, browser-script syntax checks, and 4 Chromium E2E tests passed.

## 2026-07-17 Active Session Recovery and CI Audit

- Symptom: the first composer submission could fail with HTTP 409 and
  `{"detail":"A Loom session is already active"}`, leaving the send path unusable.
- Root cause: the browser runtime could lose its in-memory session id after a
  reload/remount while the sidecar still owned an active session. The client then
  tried to open a duplicate session. A launcher-created fresh session could also
  race an immediate composer submission.
- Fix: `frontend/src/runtime-controller.ts` now adopts the sidecar's active
  session before opening a new one and re-checks restored run state before
  starting a turn. `frontend/src/components/Surface.svelte` serializes launcher
  session creation with submission while preserving text entered during that
  transition.
- Regression coverage: runtime and surface tests cover active-session adoption,
  the absence of a duplicate `/sessions/open`, and immediate send during launcher
  session creation. Profile settings tests now reset locale and portal body state
  so the suite is repeatable rather than order-dependent.
- Frontend CI: 79 unit tests passed; line/statement coverage was 79.73%, branch
  coverage 68.94%, and function coverage 66.27%. Svelte check reported 0 errors
  and 0 warnings. Vite built 4,012 modules, the bundle-size check passed at
  162,383 bytes, all 8 browser scripts passed syntax checks, and 4 Chromium E2E
  tests passed.
- Backend CI: Python 3.11, 3.12, and 3.13 each passed 207 tests with 20 expected
  skips for the separately isolated KohakuTerrarium contract. Python 3.12 line
  coverage was 71%, above the 70% threshold.
- Dependency audit: PyPI stable KohakuTerrarium did not expose the capability
  level required by the contract tests. `requirements-kt-test.txt` now pins the
  known working upstream commit `f22b739d19785b9a065ac839a83eda457daba030`;
  the isolated required-KT job passed all 20 tests with 0 skips.
- Toolchain audit: the installed default Node/pnpm versions do not match the
  repository's Node 22/pnpm 10 engine declaration, so frontend verification used
  Node 22.17.0 explicitly. Source diffs pass `git diff --check`; the regenerated
  Vite bundle retains a generated line-2 whitespace warning and was not edited by
  hand.

## 2026-07-17 Long-Term Roadmap Governance

- Root issue: repository architecture and test rules were defined, but agents had
  no product-level execution order or measurable completion standard centered on
  user experience, performance, and stability.
- Added `ROADMAP.md` with product boundaries, agent decision rules, continuous
  quality gates, current CI budgets, measurement requirements, phased workstreams,
  exit criteria, work-intake questions, and a definition of done.
- Updated `AGENTS.md` to make the roadmap mandatory for non-trivial planning and
  to prioritize user experience, stability/data integrity, performance,
  maintainability, and only then new capability, while keeping security and
  privacy invariant.
- Verification: `python -m unittest tests.test_architecture` passed 3 tests;
  `ROADMAP.md` is 450 lines; the three changed documentation files passed a
  trailing-whitespace scan. Full-worktree `git diff --check` still reports the
  pre-existing generated `javascript/kohaku_loom_90_ui.js` line-2 warning noted
  above. No runtime source or generated frontend output changed, so broader
  application suites were not required for this documentation-only update.

## 2026-07-17 Composer, Runtime Isolation, and Lifecycle Recovery

- Composer symptom: the focused textarea showed a second border/outline outside
  the rounded composer shell. The cause was the textarea's independent focus
  styling combined with visible overflow. `frontend/src/styles.css` now keeps
  focus styling on the outer shell, removes the textarea outline/border/shadow,
  and clips all composer controls inside one rounded form. `frontend/tests/surface.test.ts`
  covers containment, and the rebuilt `javascript/kohaku_loom_90_ui.js` was
  verified against the live Forge DOM.
- Sidecar installation symptom: Forge's global `--uv` hook rewrote managed
  sidecar `pip` subprocesses and a broad reinstall attempted to replace locked
  compiled files in the active Forge environment. `kohaku_loom/sidecar_manager.py`
  now bypasses the hook through the original subprocess runner, serializes
  Windows installations with `.loom/runtime/install.lock`, pins the audited
  KohakuTerrarium commit, uses `--no-deps`, and reports actionable access-denied
  recovery instructions. `tests/test_loom_runtime.py` covers the hook bypass,
  pinning, lock diagnostics, and install command.
- Lifecycle symptom: malformed bridge claims were converted to `{}` and treated
  as successful leases; ownership loss during approval did not cancel an
  accepted turn; teardown could race a late bridge claim and start `/turns`.
  `frontend/src/runtime-controller.ts` now validates lease records, cancels the
  accepted turn on lease loss, and checks disposal before submitting. Focused
  regression coverage is in `frontend/tests/runtime-controller.test.ts`.
- Runtime state after repair: `.loom/runtime/runtime-lock.json` is ready and
  pinned to commit `f22b739d19785b9a065ac839a83eda457daba030`; managed-sidecar
  and main-Forge `lxml` imports both succeeded while Forge remained running.
- Verification: `python -m unittest discover -s tests` passed 215 tests with 20
  expected skips; `.loom/venv/Scripts/python.exe tools/test_runner.py
  --require-kt --max-skips 0` passed 215 tests with 0 skips; `svelte-check`
  passed with 0 errors and 0 warnings; Vitest passed 84 tests; the Vite build
  transformed 4,014 modules and produced a 582,660-byte bundle; bundle-size
  reported 163,843 gzip bytes; all 4 Chromium E2E tests passed; browser-script
  syntax checks passed; and `git diff --check` reported only the known generated
  bundle line-2 whitespace warning.

## 2026-07-17 Model Picker Border Normalization

- Symptom: model picker controls rendered inconsistent square black outlines when
  opened inside Forge.
- Root cause: the picker popover is positioned under `body`, outside the surface
  button reset, so Forge's native button border remained on the picker controls.
- Changed `frontend/src/selector-styles.css` to explicitly remove borders from
  the trigger, add-provider button, model row buttons, and favorite button while
  retaining rounded row corners and focus-visible styling. Added a Chromium E2E
  assertion in `frontend/tests/e2e/mock-host.spec.ts` for the computed borders.
- Verification: Node `22.17.0` / pnpm `10.12.4` `pnpm install --frozen-lockfile`,
  `pnpm test` passed 86 tests, `pnpm check` passed with 0 errors and warnings,
  `pnpm build` passed, `pnpm bundle:size` reported 163,977 gzip bytes, all 4
  Chromium E2E tests passed, and browser-script syntax checks passed.

## 2026-07-17 Sidecar Startup Recovery and CI Contract Setup

- User-visible symptom: the first profile import could receive HTTP 503 while the
  sidecar was starting, and the composer could show a terminal-looking runtime
  error even though a later request would succeed.
- Root cause: profile import is a non-idempotent POST and was excluded from the
  proxy's transport retry path; the proxy also returned an upstream 503 without
  a short readiness retry. The frontend had only a generic loading flag, so it
  could not distinguish sidecar startup from a terminal mount error.
- Fix: `kohaku_loom/kt_proxy.py` retries only `POST /profiles/import` for one
  bounded readiness retry; `javascript/kohaku_loom_07_host.js` adds two short
  retries for 503/network bootstrap failures; and the runtime store/controller
  expose `idle`, `starting`, `ready`, and `error` startup states. The Svelte
  surface shows the existing localized runtime-retry message while startup is
  in progress. No turn or mutation POST was made retryable.
- CI root cause: the isolated contract workflow installed KohakuTerrarium but did
  not install this repository as the `kohaku-loom` Terrarium package, so the
  package contract failed with `PackageNotInstalledError` while the other 19
  contract tests passed. `.github/workflows/test.yml` now installs the workspace
  package in editable mode before the contract suite.
- Regression coverage: `tests/test_kt_proxy.py` covers recovery from an upstream
  profile-import 503; `tests/test_host_bridge.py` covers browser bootstrap retry;
  `frontend/tests/runtime-controller.test.ts` covers startup-to-ready state;
  `frontend/tests/surface.test.ts` covers the visible startup status and
  recoverable startup messaging.
- Verification: `python -m unittest discover -s tests` passed 217 tests with 20
  expected skips; `.loom/venv/Scripts/python.exe tools/test_runner.py --pattern
  test_loom_kt_contract.py --require-kt` passed 20 tests with 0 skips;
  `svelte-check` passed with 0 errors and 0 warnings; Vitest coverage passed 86
  tests with 81.15% lines, 70.22% branches, and 67.67% functions; the Vite build
  transformed 4,014 modules and produced a 583,705-byte bundle; bundle-size
  reported 164,079 gzip bytes; and browser-script syntax checks passed.

## 2026-07-18 Local Real-Forge Playwright Coverage

- Real Forge reproduction: the production `edit_prompt` path wrote the prompt
  through the Forge DOM but then raised `ReferenceError: truncateAssistantText is
  not defined` while compacting the successful tool result. The real test also
  confirmed the sidecar and profile import were healthy; the separate local-model
  chat attempt failed earlier with a provider native-tool stream error.
- Fix: added the small missing `truncateAssistantText` helper in
  `javascript/kohaku_loom.js`.
- Added `frontend/playwright.real-forge.config.ts` and
  `frontend/tests/e2e/real-forge.spec.ts`. This suite is opt-in through
  `pnpm run test:e2e:forge`, targets an already-running local Forge at
  `FORGE_BASE_URL` or `http://127.0.0.1:7860`, uses the production
  `read_prompt -> edit_prompt` host bridge against the real `txt2img` DOM, and
  restores the original prompt in a `finally` path. It is not referenced by the
  GitHub Actions workflow and does not start the mock Vite server.
- Verification: browser syntax checks and the local real-Forge Playwright test
  passed; the test changed the live `txt2img` prompt, verified the marker through
  a second production read, and restored the original value. The default
  `playwright.config.ts` explicitly ignores this spec, so GitHub Actions keeps
  running only the mock-host suite.

## 2026-07-18 Late Forge UI Boot Recovery

- Symptom: when `kohaku_loom_99_boot.js` loaded after Forge had already fired its
  one-shot `onUiLoaded` callbacks, the Svelte UI never mounted and Retry could
  not recover because the late callback was never replayed.
- Root cause: the boot state machine trusted only its callback-owned
  `forgeUiLoaded` flag and did not recognize an already-present Forge prompt UI.
- Changed `javascript/kohaku_loom_99_boot.js` to detect the real
  `#txt2img_prompt` through `gradioApp()` when available, fall back to `document`,
  and attempt the initial mount before scheduling retries. Added the late-load
  regression to `tests/test_host_bridge.py`; the existing pre-load ordering test
  still verifies that mounting does not happen before Forge is ready.
- Verification: `python -m unittest tests.test_host_bridge` passed 6 tests;
  `python -m unittest discover -s tests` passed 226 tests with 20 expected skips;
  `node --check javascript/kohaku_loom_99_boot.js` and `git diff --check` passed.

## 2026-07-18 Immediate Send Feedback and Provider Auth Failure

- Reproduction: a live `moyuu-gemini` turn returned no text or reasoning and
  ended after about 117 seconds. Its runtime snapshot recorded five provider
  retries followed by `401 Invalid token`; the composer stayed populated until
  remote turn acceptance, retry events were ignored, and a zero-output terminal
  failure produced no visible chat error.
- Root cause: Google SDK client errors expose HTTP status through `code` (and
  sometimes only their message), while the retry classifier inspected
  `status_code` only. The Svelte submit path also cleared the draft after its
  awaited send, and the runtime controller did not handle `provider_retry` or
  render terminal errors without assistant output.
- Changed `kohaku_loom/provider_errors.py`, `kohaku_loom/kt_providers.py`, and
  `kohaku_loom/sidecar/app.py` to normalize provider statuses, fail 4xx requests
  immediately except retryable 408/429, and sanitize 401/403 diagnostics.
  Changed the Svelte surface, runtime controller/formatter/store, working
  indicator, and generated `javascript/kohaku_loom_90_ui.js` so clicks clear the
  composer synchronously, failed submissions restore unsent content, real
  retries are visible, and zero-output failures append an actionable error card.
  Added a generated-bundle whitespace attribute because an upstream dependency
  contains a semantic multiline whitespace literal that otherwise produces a
  false-positive trailing-whitespace diagnostic on the regenerated line.
- Regression coverage: `tests/test_loom_kt_contract.py` covers Google-style
  401/403 non-retry classification and retryable 429/503; profile connection
  tests cover `.code` status extraction; frontend controller/surface tests cover
  pending-send responsiveness, retry status, safe auth errors, and draft or
  attachment recovery.
- Verification: `python -m unittest discover -s tests` passed 228 tests with 21
  expected skips; the required-KT contract runner passed 21 tests with 0 skips;
  Svelte check passed with 0 errors and 0 warnings; Vitest passed 128 tests; Vite
  transformed 4,017 modules and generated a 596,259-byte bundle (167,825 gzip
  bytes); all `kohaku_loom*.js` browser syntax checks and `git diff --check`
  passed. npm emitted only its existing future `store-dir` compatibility warning.

## 2026-07-18 Explicit Profile Save Confirmation

- Symptom: profile edits immediately displayed `Saved` even though the debounced
  sidecar sync could fail silently. An API key then existed only in the current
  browser memory and disappeared after refresh; a stale browser
  `has_api_key=true` flag could also make the public profile look configured
  while the DPAPI secret file was empty.
- Root cause: the settings UI treated the local store mutation as durable, the
  autosave path swallowed sidecar failures, and profile import persisted the
  browser-provided `has_api_key` marker instead of deriving it exclusively from
  encrypted secret storage.
- Changed `frontend/src/components/ProfileSettings.svelte` and
  `frontend/src/styles.css` to add a top-right Save button that awaits profile
  sync, stays retryable on failure, and reports success only after the sidecar
  confirms the selected profile and its required API key. Ordinary edits now
  retain the honest autosave status instead of claiming durable success.
  Changed `kohaku_loom/profile_store.py` to remove untrusted `has_api_key` from
  public persistence, added localized save states in `kohaku_loom/i18n.py`, and
  regenerated `javascript/kohaku_loom_90_ui.js`.
- Regression coverage: `frontend/tests/profile-settings.test.ts` covers button
  placement, failed-save retry, confirmed success, and rejection of a phantom
  encrypted-key claim. A follow-up corrected the UI guard so every remote profile
  requires sidecar-confirmed secret storage, including profiles whose frontend
  state never claimed to have a key. `tests/test_loom_runtime.py` verifies that
  profile import neither persists nor returns a positive API-key flag without a
  real secret.
- Follow-up input reproduction: the API-key field was a host-backed controlled
  input, so each keystroke crossed the browser profile-store normalization and
  reload boundary where credential scrubbing could replace the value. The field
  now owns a per-profile Svelte draft, sends the complete key only on explicit
  Save, preserves it after failed saves, and clears it only after sidecar
  confirmation. Focused UI tests type a complete key, verify that no host update
  or sync occurs before Save, and confirm that a failed save keeps the draft for
  a successful retry.
- Verification: focused profile settings passed 14 tests; focused profile store
  passed 7 tests; `python -m unittest discover -s tests` passed 229 tests with 21
  expected skips; Svelte check passed with 0 errors and 0 warnings; Vitest passed
  131 tests; Vite transformed 4,017 modules and generated a 598,963-byte bundle
  (168,569 gzip bytes); bundle-size passed; the required-KT contract runner
  passed 21 tests with 0 skips; all `kohaku_loom*.js` browser syntax checks and
  `git diff --check` passed. npm emitted only its existing future `store-dir`
  compatibility warning and Git emitted only line-ending conversion notices.

## 2026-07-18 Forge Context and Tablet Interaction Recovery

- Symptoms: the Loom agent described itself like a detached prompt assistant
  instead of recognizing the surrounding Forge Neo UI; a tablet virtual
  keyboard could leave the chat window clamped to its transient visual viewport;
  touch users could not reveal hover-only message Copy/Edit actions; and the
  direct-edit confirmation shaded the entire Forge page instead of the chat
  window that owned the control.
- Root causes: the KT creature prompt mentioned Forge only as an optional tool
  source, the Svelte surface used `visualViewport` for every viewport refresh,
  message actions became static only below phone-sized media queries, and the
  direct-edit `AlertDialog` was portalled to a fixed page-level overlay.
- Changed `creatures/loom/prompts/system.md` and
  `kohaku_loom/constants.py` to state the Forge Neo host and bridge authority
  explicitly. Changed `frontend/src/window-interactions.ts` and
  `frontend/src/components/Surface.svelte` so visual-viewport keyboard clamping
  is temporary while a text control owns focus and blur restores the stable
  layout viewport without persisting the reduced height. Changed
  `frontend/src/styles.css` and `Surface.svelte` to keep message actions visible
  for coarse/no-hover pointers and render the direct-edit confirmation inside
  `.kl-window`. Regenerated `javascript/kohaku_loom_90_ui.js`.
- Regression coverage: `tests/test_prompts.py` checks both agent prompt paths;
  frontend window/surface tests cover keyboard shrink-and-restore, persisted
  height, touch-action CSS, and chat-window dialog ownership; the tablet
  Playwright test sends a message, verifies Copy is visible, and verifies the
  direct-edit overlay is contained by the chat window. The provider retry
  assertions were folded into an existing KT contract so the standard suite
  remains within its hard 20-skip budget.
- Verification: `python -m compileall -q kohaku_loom scripts install.py tools`
  passed; `python tools/test_runner.py --max-skips 20` passed 229 tests with 20
  expected skips; coverage passed at 72%; the required-KT runner passed 20 tests
  with 0 skips. Under Node 22.17.0 and pnpm 10.12.4, Svelte check reported 0
  errors and 0 warnings, Vitest passed 133 tests with 84.39% statements/lines,
  72.01% branches, and 73.66% functions, Vite transformed 4,017 modules, and the
  regenerated bundle measured 599,929 raw / 168,878 gzip bytes. Playwright
  passed 6 tests; all `kohaku_loom*.js` syntax checks and `git diff --check`
  passed. Residual output was limited to npm's existing future `store-dir`
  warning and Git's LF-to-CRLF notices.

## 2026-07-18 Tablet Composer, YOLO Propagation, and Compact Tool Activity

- Visible symptoms: after a tablet virtual keyboard closed, the composer could
  remain below the actually visible page edge or be squeezed by a long message
  list; a session displayed as YOLO still opened approval for standard tools
  such as `edit_prompt`; completed and running tool activity consumed excessive
  vertical space on touch devices.
- Root causes: blur recovery switched from the visual viewport to the larger
  layout viewport, the composer retained the default flex shrink behavior, and
  coarse-pointer CSS made both redundant tool headings and footers permanent.
  Separately, only the two YOLO-exclusive tools received the session mode;
  ordinary Forge bridge tools always reached the browser as normal mode.
- Changed `frontend/src/window-interactions.ts`, `Surface.svelte`, and
  `styles.css` to cache the pre-keyboard visual viewport, ignore a stale
  keyboard-height viewport after blur, classify against the actual visual
  bounds, and make the composer non-shrinking. Assistant responses now have a
  compact collapse control. Completed and running tool calls use a Codex-style
  single-line disclosure row and expand details only on request.
- Changed `kohaku_loom/forge_tools.py` and `sidecar/runtime.py` so all standard
  bridge tools snapshot the active session mode at issuance. The hidden YOLO
  authorization marker is stripped from model arguments before the runtime may
  add it, so a normal-mode call cannot self-authorize. The mode toggle now waits
  for sidecar confirmation before changing the visible UI state.
- Regression coverage: viewport tests distinguish an oversized layout viewport
  from the stable visual viewport and cover stale keyboard recovery; surface
  tests cover assistant/tool disclosure state and retained persisted size; the
  KT contract proves `edit_prompt` bypasses approval in YOLO mode while a
  model-supplied marker is rejected in normal mode.
- Verification: `python -m compileall -q kohaku_loom scripts install.py tools`
  passed; `tools/test_runner.py --max-skips 20` passed 229 tests with 0 skips in
  the installed KT environment; system-Python branch coverage passed at 72%
  with the expected 20 KT skips. Under the isolated Node 22.17.0 / pnpm 10.12.4
  toolchain, Svelte check reported 0 errors and 0 warnings, Vitest passed 134
  tests with 84.71% statements/lines, 72.35% branches, and 74.23% functions,
  Playwright passed 6 tests, Vite transformed 4,017 modules, all generated
  browser scripts passed syntax checks, and the bundle measured 601,608 raw /
  169,319 gzip bytes. The `.loom` venv does not include `coverage`, so coverage
  used the system test environment; residual output was limited to the existing
  Starlette `httpx` deprecation, npm `store-dir`, and Git line-ending warnings.
