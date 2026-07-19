# Kohaku Loom Long-Term Roadmap

## Purpose

This roadmap governs product and engineering decisions for Kohaku Loom. It is
written for maintainers and coding agents, and should be consulted before
planning non-trivial work.

The current priority order is:

1. User experience: the intended action is clear, responsive, reversible where
   possible, and recoverable when something fails.
2. Stability and data integrity: sessions, prompts, queues, profiles, secrets,
   and tool outcomes are not lost, duplicated, or silently corrupted.
3. Performance: interaction and streaming stay responsive without weakening
   correctness or recovery behavior.
4. Maintainability and operability: changes remain small, observable, testable,
   and easy to diagnose inside Forge Neo.
5. New capability: add features only when the preceding concerns are understood
   and protected by acceptance criteria.

Security and privacy are invariants, not a lower-ranked tradeoff. Never improve
convenience or speed by exposing secrets, bypassing prompt/context guards,
weakening sidecar isolation, or sending unsanitized private content remotely.

## Product Boundary

Kohaku Loom remains a single-agent prompt assistant embedded in Forge Neo. The
Svelte UI and KohakuTerrarium sidecar are established foundations, not migration
tasks. Model Profiles, prompt/resource tools, reference-image analysis,
teacher/redaction, Danbooru research, reconnectable sessions, durable follow-up
queues, and branch operations are part of the current baseline.

Do not expand this repository into:

- a multi-agent or graph-management product;
- Terrarium Studio, marketplace, or privileged-node UI;
- a general Forge settings replacement;
- the reverse-prompt workbench owned by `sd_forge_reverse_prompt`;
- a second renderer or fallback controller alongside Svelte and the sidecar.

Any proposed boundary change requires an explicit roadmap update before code is
written.

## Agent Decision Rules

Before implementing non-trivial work, an agent must:

1. State the user-visible problem or measured engineering problem. Do not begin
   from a preferred library, abstraction, or rewrite.
2. Reproduce bugs against the real state transition when feasible. Record the
   trigger, visible symptom, expected behavior, and recovery behavior.
3. Check whether the work belongs to the current roadmap phase. Unrelated
   refactors and speculative infrastructure are out of scope by default.
4. Identify the smallest boundary that can solve the problem without creating a
   parallel source of truth or compatibility path.
5. Define acceptance criteria before editing. Include failure and recovery paths,
   not only the happy path.
6. Add focused regression coverage when the affected boundary is testable.
7. Run checks that cover every changed layer and record results in `AUDIT.md`.

When priorities conflict, use this order:

- Prevent data loss, duplicate mutation, secret exposure, and unrecoverable UI.
- Preserve the user's ability to understand, cancel, retry, resume, or repair.
- Keep input, scrolling, streaming, and window movement responsive.
- Prefer less code, less state, fewer dependencies, and fewer protocol variants.
- Defer new features that lack evidence, ownership, or a verifiable completion
  condition.

An agent must not call a task complete because it compiles, because the happy
path works once, or because a timeout/retry hides the failure. Completion means
the observable behavior and the relevant recovery path meet their acceptance
criteria.

## Quality Gates

These gates apply continuously, including during feature work.

### User Experience

- A primary action has one clear result and immediate visible feedback.
- Disabled controls explain the blocking state when it is not obvious.
- A failed request must return the composer and affected controls to a usable
  state unless user action is genuinely required.
- Long-running actions expose meaningful states such as connecting, queued,
  running, retrying, waiting, interrupted, cancelled, or failed.
- Destructive and Forge-mutating actions remain explicit and guarded. Stale
  prompt/context hashes never become silent last-write-wins behavior.
- Keyboard use, focus restoration, narrow viewports, and reduced-motion behavior
  are part of feature acceptance, not optional polish.
- User-authored text, attachments, and unsent drafts are not discarded by a
  recoverable UI transition.

### Stability

- Session and queue operations are idempotent across retries, reconnects, stale
  responses, duplicate submissions, and browser remounts.
- A completed unsafe tool or Forge mutation is never repeated solely because a
  response or event was lost.
- Cancellation, provider failure, sidecar restart, and SSE reconnect preserve a
  truthful outcome: completed, resumable, retryable, or failed with action.
- Repair and upgrade operations preserve sessions, profiles, and secrets.
- Browser storage is never the authoritative source for session history or API
  keys.
- New state machines define valid transitions and reject stale events rather
  than relying on timing assumptions.
- New dependencies need a concrete benefit, an owner, a pin or compatibility
  policy, and coverage at the integration boundary.

### Performance

- Do not optimize by dropping events, hiding retries, truncating valid state, or
  weakening persistence and safety guards.
- Streaming updates remain frame-coalesced or equivalently bounded; avoid
  expensive Markdown parsing and full-history reconstruction for every delta.
- Large sessions, attachments, tool results, and profile catalogs must have
  explicit bounds, pagination, compaction, virtualization, or deferred work as
  appropriate.
- Work not required for first interaction should leave the critical boot and
  first-open path when doing so is compatible with Forge's single-IIFE loader.
- Performance work must include before/after measurements under the same
  workload. A subjective claim that code is "faster" is not sufficient.

### Engineering

- Preserve the dependency direction and file-size rules in `AGENTS.md`.
- Maintain one source of truth for each session, profile, queue item, and UI
  state. Do not add dual writes or hidden fallback runtimes.
- Generated `javascript/kohaku_loom_90_ui.js` is changed only by rebuilding
  `frontend/`.
- Coverage percentages are guardrails, not substitutes for state-transition,
  contract, integration, and failure-injection tests.
- Logs and audit entries must not contain secrets, raw private attachments, or
  unnecessary user content.

## Metrics And Budgets

Do not invent precision before measurement. Phase 1 establishes reproducible
baselines; later phases may tighten budgets through reviewed changes to this
section.

Current hard repository budgets:

- Source and documentation files: at most 1000 lines, except the generated UI
  bundle allowed by `AGENTS.md`.
- Python line coverage: at least 70% in CI.
- Frontend coverage: at least 75% lines/statements, 65% branches, and 60%
  functions.
- Generated frontend bundle: at most 350,000 gzip bytes.
- Standard Python suite: at most 20 documented skips; the isolated KT contract
  suite must not skip its required contract.

Track these product measurements for representative cold and warm runs:

- panel boot-to-interactive and first-open latency;
- session open/resume and history-load latency;
- submit-to-visible-acknowledgement and submit-to-first-token latency;
- streaming render cadence, long-task rate, and dropped-frame symptoms;
- cancellation acknowledgement and reconnect recovery time;
- sidecar cold start, health recovery, repair, and idle shutdown behavior;
- memory growth during a long session and repeated open/close cycles;
- raw/gzip bundle size and generated-module count;
- error, retry, duplicate-operation, stale-event, and unrecoverable-session rates.

Baseline records must name the machine/runtime, model or mock provider, workload,
sample count, percentile or range, and commit. Never compare measurements from
different workloads as if they were a regression result.

## Roadmap Phases

Phases are ordered by dependency, not calendar date. Agents should finish the
earliest incomplete exit criteria relevant to their area before starting a later
phase. Small bug fixes may land at any time when they follow the quality gates.

### Phase 0: Preserve The Baseline

Goal: keep the completed architecture and migration work from regressing while
new work continues.

Workstreams:

- Keep Svelte as the only UI renderer and KT as the only controller runtime.
- Keep profile secrets encrypted and absent from browser/session/log payloads.
- Preserve prompt/context hash guards, active-tab leases, and idempotent browser
  operation IDs.
- Keep generated frontend output reproducible and CI-equivalent checks green.
- Convert every production bug into a focused regression test when feasible.

Exit criteria:

- CI covers the supported Python, Node, browser-script, frontend, and KT contract
  boundaries.
- Architecture tests reject cycles, facade misuse, oversized source files, and
  accidental generated artifacts.
- `AUDIT.md` records root cause, changed files, verification commands, and
  outcomes for bug fixes and boundary changes.

Status: established; this phase remains a permanent gate.

### Phase 1: Observable Product Baseline

Goal: make UX, performance, and reliability changes evidence-driven.

Workstreams:

- Add a repeatable benchmark harness for boot, session open/resume, first visible
  acknowledgement, first token, stream completion, cancellation, reconnect, and
  queue drain.
- Extend `tools/assistant_workload_eval.py` or add focused companion tooling for
  deterministic mock workloads and optional real local-model runs.
- Add development diagnostics for sidecar lifecycle, event cursor, queue depth,
  retry attempt, active operation, and timings without exposing secrets or raw
  private content.
- Define a compact manual release smoke matrix covering desktop, portrait mobile,
  landscape mobile, remote provider, resident endpoint, llama-once, attachment,
  prompt mutation, cancellation, and refresh/reconnect.
- Store baseline reports as concise audit artifacts or documentation, not as
  large generated logs in Git.

Exit criteria:

- The same command can produce comparable timing and outcome data for a fixed
  mock workload.
- At least one long-session workload and one failure-injection workload are
  reproducible.
- Every later performance proposal can name a baseline, target, and regression
  threshold.

### Phase 2: Recovery-First Experience

Goal: make failures understandable and recoverable without page reloads, lost
drafts, duplicate turns, or permanently disabled controls.

Workstreams:

- Provide explicit recovery actions where state permits: reconnect, retry turn,
  resume queue, repair sidecar, or start a clean session.
- Make queued, live-guidance, retrying, interrupted, cancelled, and unknown-tool
  outcomes visually distinct and accessible.
- Preserve text and attachments across session creation, adoption, reconnect,
  profile validation, and recoverable submission failures.
- Verify stale/duplicate session responses, stale SSE events, multiple tabs,
  provider disconnects, sidecar restart, rejected browser tools, and lost tool
  replies.
- Improve error messages so they say what failed, what was preserved, and what
  the user can do next. Do not expose stack traces as the primary UI.

Exit criteria:

- The composer recovers after every tested rejected, stale, duplicate-session,
  provider, and reconnect failure unless the session is explicitly waiting for
  user action.
- Refreshing or remounting during a turn does not duplicate text, turns, queue
  items, tool execution, or Forge mutation.
- Cancellation has a bounded acknowledgement path and leaves a truthful,
  resumable or terminal state.
- Production-like E2E tests cover the critical Forge bridge and managed-sidecar
  recovery paths, not only mocked frontend endpoints.

### Phase 3: Interaction And Streaming Performance

Goal: keep the assistant responsive under realistic messages, attachments, and
long-running streams.

Workstreams:

- Profile the boot path, generated bundle, store subscriptions, message rendering,
  Markdown finalization, popovers, drag/resize behavior, and attachment preview.
- Bound per-delta work and prevent whole-conversation rerenders during streaming.
- Add long-conversation rendering strategies only when measurements justify
  them, such as pagination, windowing, deferred history, or artifact summaries.
- Move optional profile catalogs, history details, and heavy diagnostics out of
  first interaction where the single-IIFE runtime permits it.
- Measure attachment resize/encode cost and keep the UI cancellable during image
  work.
- Treat bundle growth as a reviewed cost; remove unused dependencies and code
  before raising the gzip budget.

Exit criteria:

- Representative desktop and mobile workloads have reviewed latency and
  responsiveness budgets recorded in this roadmap or an adjacent benchmark doc.
- Streaming, dragging, scrolling, typing, and cancellation stay responsive under
  the agreed long-session workload.
- CI or a repeatable release check detects material regressions in bundle size
  and the selected deterministic performance measures.

### Phase 4: Session Completeness And Long-Run Durability

Goal: make sessions safe and manageable over weeks of normal use, not only one
active browser visit.

Workstreams:

- Decide product scope for rename, archive, delete with confirmation, export,
  retention, and explicit resume controls before implementing them.
- Add pagination or incremental loading for histories, events, branches, and
  large tool artifacts.
- Preserve paired tool calls/results and current intent through context
  compaction; summaries must be committed before replacing covered history.
- Test many sessions, long conversations, branch/regenerate/edit cycles, queue
  pressure, interrupted writes, corrupted metadata, and disk-full behavior.
- Define cleanup and retention behavior for sessions, cache, runtime logs, and
  temporary attachments without deleting secrets or recoverable user data.

Exit criteria:

- History operations remain bounded and responsive at the documented stress
  scale.
- Export/deletion/retention behavior, if adopted, is versioned, secret-free,
  transactional where required, and covered by recovery tests.
- Restart and repair preserve valid sessions and report damaged sessions without
  blocking access to unaffected data.

### Phase 5: Accessibility And Workflow Polish

Goal: make the established feature set efficient and understandable across input
methods and viewport sizes.

Workstreams:

- Add automated accessibility checks plus manual keyboard and screen-reader
  smoke tests for the launcher, composer, settings, history, dialogs, menus,
  tool states, and error recovery.
- Standardize focus entry, focus restoration, escape behavior, labels, live
  regions, reduced motion, contrast, and touch target sizing.
- Reduce avoidable steps in high-frequency flows using observed usage and user
  feedback, not speculative UI redesigns.
- Keep advanced profile/runtime controls discoverable without crowding the main
  prompt workflow.
- Review localization for status, error, recovery, and destructive-action text,
  including layout expansion in both supported locales.

Exit criteria:

- Critical workflows pass the selected automated accessibility rules and the
  documented keyboard-only smoke matrix.
- Desktop, portrait mobile, and landscape mobile workflows remain usable without
  clipped primary controls or inaccessible portals.
- UX changes demonstrate fewer steps, clearer recovery, or improved task success
  against a stated scenario.

### Phase 6: Runtime Operations And Supported Environments

Goal: make dependency and platform behavior predictable for maintainers and
users.

Workstreams:

- Define the KohakuTerrarium compatibility and upgrade policy: pinned capability
  contract, upgrade probe, rollback path, session compatibility, and repair
  behavior.
- Make the local Qwen plus `llama-server.exe` smoke test reproducible on an
  opt-in or self-hosted environment without committing model artifacts.
- Improve diagnostics for missing binaries/models, incompatible runtime versions,
  port/auth failures, antivirus interference, and broken virtual environments.
- Keep Windows support explicit. Cross-platform support requires a separate
  design covering secret storage, process lifecycle, paths, packaging, and CI;
  it must not degrade the Windows security model.
- Define release readiness and rollback notes for generated UI, sidecar runtime,
  profile schema, and session schema changes.

Exit criteria:

- Supported and unsupported environments fail with actionable diagnostics.
- Runtime upgrades are tested against the non-skippable contract and recovery
  matrix before becoming the managed default.
- A maintainer can reproduce the local-model smoke path from documented commands
  and receive a secret-free result summary.

## Work Intake

Every non-trivial proposal should answer:

- Problem: what user-visible failure, friction, risk, or measured regression
  exists?
- Evidence: reproduction, user report pattern, trace, benchmark, or failing test.
- Scope: affected layer, current roadmap phase, and explicit non-goals.
- Invariants: data, security, protocol, and UX behavior that must not regress.
- Acceptance: observable happy path, failure path, recovery path, and target
  measurement when performance is involved.
- Verification: unit, contract, integration, E2E, manual smoke, and generated
  output checks that apply.
- Rollback: how to disable or revert the change without losing user data when the
  change touches persistence, runtime installation, or provider protocols.

Reject or defer proposals that primarily offer novelty, abstraction, dependency
replacement, or visual churn without evidence and acceptance criteria.

## Definition Of Done

A roadmap item is done only when:

- the user-visible outcome and non-goals are documented;
- the smallest correct implementation is complete;
- relevant happy, failure, stale, duplicate, cancellation, and recovery paths
  have been considered and tested where applicable;
- no new secret, data-loss, duplicate-mutation, or hidden-fallback path exists;
- accessibility and responsive behavior were checked for changed UI;
- before/after evidence exists for performance claims;
- generated assets were rebuilt rather than hand-edited;
- applicable CI-equivalent commands pass;
- `AUDIT.md` records the root cause or goal, changed files, commands, outcomes,
  and any residual risk;
- this roadmap is updated if priorities, budgets, phases, or product boundaries
  changed.

## Verification Matrix

Use the smallest applicable set, but cover every changed layer:

```powershell
python -m compileall -q kohaku_loom scripts install.py tools
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
```

For frontend source changes, run from `frontend/`:

```powershell
pnpm run check
pnpm run test:coverage
pnpm run build
pnpm run bundle:size
pnpm run test:e2e
```

For KT boundary changes, also run the non-skippable contract suite with
`requirements-kt-test.txt`. For local runtime changes, perform the documented
Qwen/llama.cpp smoke test when the required local assets are available.

## Maintenance

Review this roadmap after a major reliability incident, a product-boundary
change, a persistence/protocol migration, or completion of a phase. Prefer
updating priorities and exit criteria over appending an unbounded backlog.

`README.md` describes the product, `AGENTS.md` defines repository rules,
`docs/` holds focused designs, `AUDIT.md` records verified changes, and this file
defines long-term execution order and completion standards.
