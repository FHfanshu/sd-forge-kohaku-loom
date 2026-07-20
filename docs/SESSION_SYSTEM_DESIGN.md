# Prompt Agent Session System Design

## Authority

The browser owns new chat history in IndexedDB database `sd-forge-neo-prompt-agent`. Python does not own assistant sessions and does not continue a browser request after refresh.

`PromptAgentRuntime` is the only generation-state authority. Svelte stores render runtime state but do not create another execution state machine.

## Stores

The versioned database contains:

- `sessions`: session metadata, selected profile, timestamps, and preview text;
- `messages`: user, assistant, reasoning, and tool display records;
- `attachments`: persisted attachment metadata and blobs when supported;
- `preferences`: active session and runtime preferences;
- `profile-cache`: secret-free public profile metadata.

Provider credentials, decrypted secrets, executable paths, model paths, and privileged Forge state never enter IndexedDB.

## Lifecycle

1. Mount opens IndexedDB and applies schema migrations.
2. Any message left in `streaming` state is marked `interrupted`.
3. The last selected session and its persisted messages are restored.
4. Only completed model-context messages are loaded into a new Pi runtime.
5. A user submission creates one active browser request.
6. Runtime snapshots are serialized to prevent older writes from replacing newer content.
7. Completion, failure, or cancellation produces a terminal message state and restores the composer.
8. Refresh or tab closure never reconnects to or re-executes the previous request.

## Message Rules

- Stable message IDs make streaming updates idempotent `put` operations.
- A tool call and its result remain paired in model context.
- Reasoning may be displayed and persisted as UI metadata, but is not added to later model context by default.
- Partial assistant content is preserved when a request fails or is cancelled.
- Deleting a session also removes its messages and attachment records.

## Multi-Tab Behavior

Tabs may announce that another tab changed session data. They do not claim execution ownership, coordinate request continuation, or prevent another tab from starting an independent request. Database upgrade blocking is reported as an actionable informational state.

## Recovery

- Provider failure: persist partial content as failed and leave the composer usable.
- User cancellation: abort provider and tool work, persist partial content as cancelled, and leave the composer usable.
- Refresh: mark unfinished content interrupted without continuing it.
- Stale persistence write: serialize writes and bind each snapshot to its originating session.
- Failed storage transaction: report the error without leaving generation state active.

## Acceptance Criteria

- Session, message, attachment, preference, and profile-cache CRUD are covered.
- Streaming updates keep one logical record per message.
- Refresh restores history and selection and marks unfinished output interrupted.
- No provider stream or tool call resumes after refresh.
- Multi-tab behavior is informational only.
- Browser persistence contains no secrets or local filesystem paths.

The mock-host Playwright suite exercises the refresh boundary against real
IndexedDB: it waits for a partial streaming record, reloads, verifies the record
is interrupted, confirms no stored tool call or provider request resumes, then
submits a new turn through the recovered composer.
