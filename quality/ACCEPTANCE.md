# Critical Acceptance Registry

`quality/acceptance.json` is the machine-readable authority for critical
user-visible behavior, lifecycle contracts, provider/tool boundaries, security,
and data integrity. Ordinary unit tests are intentionally outside this registry.

## Workflow

- During development, run `python tools/test_gate.py affected`.
- Before delivery, run `python tools/test_gate.py full`.
- When product behavior intentionally changes, update the requirement revision
  and run `python tools/test_gate.py behavior-change <REQUIREMENT-ID>` before
  updating mapped acceptance tests.
- A stale acceptance test is a warning in `affected` mode and a failure in
  `full` mode.
- Flaky acceptance tests may be listed in `quality/waivers.json` for at most 14
  days. Expired waivers fail the full gate.

## Assertion Policy

Acceptance tests assert observable semantics. Exact pixel coordinates, fixed
dimensions, private DOM structure, timer counts, or internal promise ordering
are not valid unless the matching registry entry explicitly requires them.

The generated requirement table is verified by `tools/test_gate.py preflight`.

<!-- acceptance-table:start -->
| Requirement | Rev | Area | Title | Required scenarios |
| --- | ---: | --- | --- | --- |
| AGENT-LOOKUP-001 | 1 | agent | Verified named-entity background lookup | style-first, fallback, unverified-hidden |
| AGENT-TOOLS-001 | 1 | agent | Forge tool authority and freshness | surface, revalidation, freshness |
| DATA-INTEGRITY-001 | 1 | data | Stale writes and replay are prevented | freshness, stale-recovery, no-replay |
| LOCAL-RUNTIME-001 | 1 | lifecycle | On-demand llama.cpp lifecycle | loading, abort, privacy |
| MODEL-PROFILE-001 | 3 | provider | Stable model profile identity and recovery | connection-modes, adapter-selection, edit-stability, hot-reload, touch-delete, failure-recovery |
| PROMPT-DIFF-001 | 1 | ui | Confirmed prompt mutation diff | confirmed-diff, negative-disabled |
| PROMPT-STATE-001 | 1 | data | Negative prompt activation freshness | activation, stale-activation, effective-evidence |
| PROMPT-TOOLKIT-001 | 1 | agent | Hybrid prompt toolkit and enforced write order | hybrid-preservation, deterministic-operations, toolkit-before-write |
| PROVIDER-TOOLS-001 | 2 | provider | Provider-native tool execution contract | forced-choice, normalization, abort |
| SECURITY-PRIVACY-001 | 1 | security | Secrets and local paths remain server-owned | projection, request-rejection, path-rejection |
| SESSION-LIFECYCLE-001 | 2 | session | Terminal request recovery | retry, failure, abort, recovery |
| SESSION-REFRESH-001 | 1 | session | Refresh interruption without replay | interruption, no-replay, recovery |
| SESSION-SYNC-001 | 1 | session | Cross-browser durable session synchronization | cross-device, offline-cache, conflict, validation |
| UI-BOOT-001 | 1 | ui | Forge-controlled UI boot | boot-gate, late-host |
| UI-FEEDBACK-001 | 3 | ui | Compact lifecycle and process feedback | loading, recovery, process |
| UI-WINDOW-001 | 3 | ui | Responsive floating windows and focus | phone, tablet, focus, launcher |
<!-- acceptance-table:end -->
