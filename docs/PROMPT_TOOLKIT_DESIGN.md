# Prompt Toolkit And Hybrid Prompt Editing Design

Status: implementation in progress; parser, toolkit, enforced Agent ordering,
negative-state evidence, and confirmed diff UI landed on `main` on 2026-07-21.
Per-profile prompting dialect controls and confirmed inverse-diff undo remain
follow-up work.
Scope: frontend Pi Agent Loop, deterministic prompt operations, and user-visible prompt diffs
Product: SD Forge Neo Prompt Agent

Implementation baseline: develop on `main`. The local
`resident-gemma-llama-once` branch is not the development branch and must not be
used implicitly for this work.

## Purpose

Prompt Agent needs a cohesive toolkit for inspecting, splitting, deduplicating,
sorting, normalizing, validating, and composing prompts. The active image model
accepts both natural-language descriptions and Danbooru-style tags. The product
must preserve both forms instead of treating every comma-separated phrase as a
tag or forcing natural language into tag syntax.

This design adds one aggregate `prompt_toolkit` Agent tool and a hybrid prompt
document model. The toolkit is deterministic and has no Forge write authority.
Actual prompt mutations continue through `edit_prompt`, preserving the existing
hash guard, permission boundary, abort behavior, and stale-write recovery.

The frontend must also show an explicit red/green diff for every successful AI
prompt mutation so the user can see what changed without relying on the final
assistant message.

## Product Principles

1. Natural language and Danbooru tags are first-class, independent prompt pools.
2. Do not convert between natural language and tags unless the user asks.
3. Sort and deduplicate only the selected pool; default to conservative tag-only
   operations.
4. Preserve special syntax, grouping, weights, and unknown content when a safe
   transformation cannot be proven.
5. LLM reasoning chooses the intended operation. Deterministic code parses and
   performs it.
6. `prompt_toolkit` proposes a transformation; `edit_prompt` is the only tool
   that commits prompt text to Forge.
7. A successful mutation is not complete until the frontend has the confirmed
   before/after values and can render their diff.
8. Process detail stays compact so the final answer remains visually primary.
9. Prompt text and prompt effectiveness are different facts. The Agent must know
   when the current negative prompt is disabled even if it contains text.

## Non-Goals

- A second Agent Loop or a server-owned Agent runtime.
- Automatic conversion of every natural-language phrase into Danbooru tags.
- Treating subjective near-synonyms as safe mechanical duplicates.
- Exposing Forge paths, provider credentials, or private prompt content to logs.
- Folding resource search, Danbooru network lookup, or Forge mutations into the
  toolkit.
- A universal prompt order that is silently applied to every model.

## Model Prompting Capability

The active model profile needs an explicit prompting dialect rather than a
global assumption:

```ts
interface PromptingCapabilities {
  dialect: "hybrid_nl_danbooru" | "natural_language" | "danbooru_tags";
  supportsNaturalLanguage: boolean;
  supportsDanbooruTags: boolean;
  preferredLayout: "nl_then_tags" | "tags_then_nl" | "preserve";
  preserveSpecialTokens: true;
}
```

For the current hybrid model, the generated Agent instruction must say:

- The model understands both natural language and Danbooru-style tags.
- Natural language is appropriate for relationships, spatial detail, scene
  intent, atmosphere, and other descriptions that lose meaning as isolated
  tags.
- Tags are appropriate for precise visual attributes, known concepts,
  composition controls, and concise style or quality signals.
- The two pools can complement each other but should not repeat the same fact
  unnecessarily.
- Keep the pools independent while editing and combine them only when composing
  the final Forge prompt.
- Do not rewrite one pool into the other unless requested.
- Treat the current negative-prompt enabled state as live Forge context. Never
  claim that exclusions are active when the negative field is disabled.

This instruction must be derived from the active model/profile so changing to a
tag-only or natural-language-only model does not inherit the hybrid contract.

## Hybrid Prompt Document

The parser produces an ordered document while retaining the exact source text:

```ts
interface HybridPromptDocument {
  version: 1;
  source: string;
  pools: {
    naturalLanguage: NaturalLanguageBlock[];
    tags: PromptTag[];
    special: SpecialPromptToken[];
    unknown: UnknownPromptFragment[];
  };
  layout: PromptLayoutSegment[];
  diagnostics: PromptDiagnostic[];
}
```

### Natural-language pool

Natural-language content is stored as ordered blocks, not comma tokens:

```ts
interface NaturalLanguageBlock {
  id: string;
  text: string;
  role: "subject" | "scene" | "action" | "composition" | "lighting" |
    "atmosphere" | "style" | "other";
  enabled: boolean;
  sourceRange: [number, number];
  confidence: number;
}
```

Block order is stable by default. Sorting tags must never reorder or split these
blocks. A future reusable NL pool can enable or rearrange blocks without losing
their original wording.

### Tag pool

```ts
interface PromptTag {
  id: string;
  text: string;
  canonicalKey?: string;
  weight?: number;
  category: "identity" | "subject" | "composition" | "camera" | "pose" |
    "action" | "appearance" | "clothing" | "environment" | "lighting" |
    "color" | "style" | "quality" | "other";
  group: number;
  sourceRange: [number, number];
  confidence: number;
}
```

`text` is the prompt-ready spelling. `canonicalKey` is only an internal
comparison key. Canonical Danbooru database underscores must not leak into a
prompt when the current model expects space-separated tags.

### Special and unknown pools

Special syntax includes LoRA references, embeddings, wildcards, weighted or
nested expressions, `BREAK`, `AND`, escaped separators, and other recognized
control structures. Unknown fragments remain byte-for-byte stable unless the
user explicitly approves or requests their rewrite.

`layout` records how all pools and structural separators appeared in the source
so a no-op parse/compose round trip reproduces the original prompt.

## Classification Boundary

Classification uses a conservative precedence order:

1. Recognized control syntax becomes a special token.
2. A verified or high-confidence atomic visual concept becomes a tag.
3. A sentence or coherent descriptive clause becomes a natural-language block.
4. Ambiguous content becomes an unknown fragment.

Commas alone do not establish a tag list. For example, `a girl, standing beside
a window, looking outside` may be natural language and must not be mechanically
split without adequate confidence.

The parser may use a bundled/local tag index for classification. Live Danbooru
lookups remain separate Agent tools and are not silently triggered by a pure
toolkit operation. LLM-proposed classification is advisory; uncertain fragments
must remain visible and preserved.

## Negative Prompt Activation State

Forge exposes whether the negative prompt currently participates in generation
through the frontend control state. In the active host, CFG Scale at or below
`1.0` makes the negative prompt textbox non-interactive; changing CFG updates
that state directly. The browser host must read the live field state rather than
infer support from the checkpoint name or from whether negative text is empty.

`read_prompt` must return activation information with either field:

```ts
interface PromptFieldState {
  field: "positive" | "negative";
  prompt: string;
  prompt_hash: string;
  field_enabled: boolean;
  negative_prompt_enabled: boolean | null;
  negative_state_hash?: string;
  activation_source: "live_field" | "forge_state" | "unknown";
  inactive_reason?: "cfg_scale_lte_1" | "field_disabled" | "field_unavailable";
  cfg_scale?: number;
}
```

The browser host should derive the primary truth from the actual negative input
(`disabled`, `aria-disabled`, and the Gradio field state). The visible CFG value
may explain the state but must not override a clearly disabled input. If the
state cannot be determined, return `negative_prompt_enabled: null` with an
explicit diagnostic instead of silently reporting enabled.

`negative_prompt_enabled` must participate in the prompt context hash. A CFG
change that enables or disables the negative field after `read_prompt` is a
stale-context change and must be surfaced before an Agent claims the requested
effect is active. Negative reads also return a bounded `negative_state_hash`.
Negative writes either validate that state hash or return the newly confirmed
live activation state; in both cases the mutation result is the authority for
the final `effective` claim.

Agent behavior:

- Reading or editing the negative prompt must tell the model whether it is
  currently active.
- Analysis, sorting, and deduplication may still operate on disabled negative
  text.
- A user may explicitly ask to prepare or edit disabled negative text; the write
  can succeed, but the final answer and diff must say that it remains inactive.
- If the user's goal depends on exclusions taking effect, the Agent must not
  treat editing a disabled field as completion. It should explain that negative
  prompting is disabled and only change CFG/activation when the user requested
  or clearly authorized that generation-setting change.
- The Agent must not silently enable CFG merely because it generated a negative
  prompt.

## `prompt_toolkit` Contract

One aggregate tool avoids expanding the model's tool surface with many closely
related names:

```ts
type PromptToolkitAction =
  | "analyze"
  | "split_pools"
  | "deduplicate"
  | "sort"
  | "normalize"
  | "validate"
  | "compose";

interface PromptToolkitInput {
  action: PromptToolkitAction;
  prompt?: string;
  document?: HybridPromptDocument;
  pool?: "natural_language" | "tags" | "special" | "all";
  options?: PromptToolkitOptions;
}
```

The tool executes locally in the frontend, accepts an `AbortSignal`, has no
Forge permission, and returns structured data rather than a prose-only result:

```ts
interface PromptToolkitResult {
  ok: true;
  action: PromptToolkitAction;
  document: HybridPromptDocument;
  output: string;
  changed: boolean;
  changes: PromptChange[];
  diagnostics: PromptDiagnostic[];
  summary: {
    added: number;
    removed: number;
    moved: number;
    normalized: number;
    preservedUnknown: number;
  };
}
```

Input and output sizes must be bounded. Invalid structures, unsafe parse states,
and aborted operations return structured errors and never produce a partial
Forge mutation.

## Operation Semantics

### Analyze and split pools

`analyze` returns classifications, weights, groups, duplicates, and diagnostics.
`split_pools` returns the same document with an explicit pool-oriented summary.
Neither operation changes prompt text.

### Deduplicate

Default mode is `safe`:

- Remove exact duplicates within the same structural group.
- Treat verified space/underscore spellings as the same canonical tag.
- Preserve the first occurrence unless another occurrence has a higher explicit
  weight; report which occurrence was retained.
- Never deduplicate across `BREAK`, `AND`, or another semantic group by default.
- Never delete a natural-language block based only on semantic similarity.
- Report cross-pool repetition as a diagnostic instead of deleting it.
- Preserve complex, unknown, or conflicting weighted expressions and report
  them for review.

An optional future `semantic` mode may suggest near-duplicate removals, but they
must be represented as model-authored edits, not deterministic guarantees.

### Sort

Default sort mode is stable: classify tags into categories, reorder categories,
and preserve source order within each category.

Positive tag order:

```text
identity/subject -> composition/camera -> pose/action -> appearance/clothing
-> environment -> lighting/color -> style/quality -> other
```

Negative tag order:

```text
anatomy -> face/hands -> composition -> rendering artifacts -> quality
-> text/watermark -> other
```

Natural-language blocks retain their order unless the user explicitly requests
NL reordering. Special tokens retain their group anchors. Unknown fragments do
not move automatically.

Model profiles may override category order and final pool layout. The current
hybrid default is natural language followed by precise tags while preserving
required special-token anchors.

### Normalize

Normalization may clean redundant separators, blank fragments, and surrounding
whitespace. It must not silently alter tag meaning, weights, sentence wording,
special tokens, or pool membership.

### Validate

Validation detects unbalanced delimiters, malformed weights, empty items,
duplicate special resources, ambiguous fragments, and possible cross-pool
repetition. It reports diagnostics without changing the prompt.

### Compose

Compose renders the document according to the active prompting profile. A
parse/compose operation with no requested transformations must be lossless.

## Agent Loop Integration

For a request such as “deduplicate and sort the current positive prompt”:

```text
read_prompt(field="positive")
  -> prompt_toolkit(action="deduplicate", prompt=current_prompt)
  -> prompt_toolkit(action="sort", document=deduplicated_document)
  -> edit_prompt(base_hash=latest_hash, patches_or_diff=toolkit_change)
  -> render confirmed red/green diff
  -> final assistant answer
```

Rules:

- A request to change the active prompt still requires a successful
  `edit_prompt`; a toolkit result alone is not completion.
- If `edit_prompt` rejects a stale hash, reread the prompt and rerun the
  transformation against the new value.
- Never retry an identical failed write blindly.
- Abort stops the active toolkit/tool round and restores a usable composer.
- A refresh persists interrupted content but never replays the transformation
  or mutation.
- Read-only requests such as “find duplicates” stop after analysis and do not
  invoke `edit_prompt`.
- Tool results must not claim that Forge changed before the confirmed write
  response arrives.
- A negative-prompt mutation result carries both `changed` and `effective`.
  `changed=true, effective=false` is a truthful prepared-but-disabled outcome,
  not an active exclusion.

Toolkit transformations should produce a bounded diff or patch compatible with
`edit_prompt`. The committed diff shown to the user must be derived from the
confirmed before/after prompt values, not merely from the toolkit proposal.

## User-Visible Red/Green Diff

Every successful AI prompt mutation creates a dedicated change presentation.
It is a factual view of the confirmed Forge mutation, not the model's prose
description.

### Information hierarchy

The compact row is always visible above the final answer:

```text
Prompt updated · Positive · +3 added · -2 removed · 4 moved   [View changes]

Negative prompt updated · Disabled · +2 added · -1 removed   [View changes]
```

The full diff is expandable. The final assistant answer follows immediately and
must not be squeezed out by a permanently tall process panel.

On first successful prompt mutation in a turn, the change card may reveal a
short diff preview. Large diffs collapse after a bounded preview and use an
internal scroll area on small screens. The ordinary reasoning/tool process
drawer remains compact and separate.

### Two diff views

Tag changes use semantic tag chips:

```text
- blue eyes        removed duplicate
+ (blue eyes:1.2)  kept stronger weight
↕ cinematic lighting  moved to lighting
```

Natural-language changes use word/phrase diff while retaining sentence context:

```text
- A woman stands in a street.
+ A woman stands beneath neon signs in a rain-soaked street.
```

Mixed prompts show separate `Natural language`, `Tags`, and `Special syntax`
sections. Pure moves are identified as moves rather than misleading delete/add
pairs where the parser can prove identity.

A negative-prompt diff always displays an `Enabled` or `Disabled` status beside
the field label. Disabled uses a neutral warning treatment, not success green;
green remains reserved for added text. Supporting copy states: “Text changed,
but the negative prompt is currently disabled.”

### Visual and accessibility contract

- Removed content uses a restrained red surface, minus icon, `Removed` label,
  and strike-through where readable.
- Added content uses a restrained green surface, plus icon, and `Added` label.
- Moved content uses the existing neutral/accent palette with an arrow and
  `Moved` label; it is not counted as a semantic deletion and addition.
- Unchanged context remains neutral and visually quiet.
- Color is never the only signal. Text labels, icons, and decoration preserve
  meaning for color-vision deficiencies and forced-colors mode.
- Diff text is selectable and copyable. Keyboard focus, screen-reader labels,
  touch targets, reduced motion, light/dark themes, and 200% zoom are required.
- Mobile layout uses one column with normal margins. It must not turn the
  floating chat window into fullscreen or introduce virtual-keyboard jitter.

### Failure and undo

- Failed or stale mutations show no green success diff.
- A failed card states that Forge was unchanged and gives the recoverable next
  action.
- Undo produces a second confirmed inverse diff and marks the original change
  as undone; it does not erase history or pretend the first write never occurred.
- If the final Forge value cannot be read or confirmed, show an explicit
  “change confirmation unavailable” state rather than a proposed diff as fact.

## Persistence And Privacy

Persist structured mutation evidence with the tool message so restored sessions
can render the same diff without rerunning a tool. Store only the prompt content
already present in synchronized chat/tool history and enforce existing payload
limits. Do not log raw prompts, diff bodies, or model-private content in console,
Python logs, request telemetry, or `AUDIT.md`.

The persisted shape needs a schema version and enough information to render:

```ts
interface PromptMutationEvidence {
  version: 1;
  field: "positive" | "negative";
  target: "active" | "txt2img" | "img2img";
  beforeHash: string;
  afterHash: string;
  fieldEnabled: boolean;
  effective: boolean;
  inactiveReason?: string;
  changes: PromptChange[];
  summary: PromptToolkitResult["summary"];
  undone?: boolean;
}
```

If storing full before/after text would exceed history limits, persist bounded
structured changes plus hashes and an explicit truncation flag.

## Proposed Source Boundaries

Keep each source below the repository line limit and separate concerns:

```text
frontend/src/prompts/
  prompt-types.ts          document, change, and diagnostic contracts
  prompt-parser.ts         lossless tokenization and pool classification
  prompt-deduplicate.ts    deterministic duplicate policies
  prompt-sort.ts           stable category ordering
  prompt-compose.ts        lossless/profile-aware rendering
  prompt-diff.ts           semantic changes and bounded display hunks

frontend/src/tools/
  prompt-toolkit.ts        TypeBox schema and AgentTool adapter

frontend/src/components/
  PromptChangeCard.svelte  compact summary and expandable diff
  PromptDiff.svelte        NL/tag/special diff rendering
```

Expected integrations:

- Tool registry: register one `prompt_toolkit` entry alongside Forge tools.
- Controller: generate model-specific prompting instructions and supply the
  prompting profile.
- Forge browser adapter: return the live negative field activation state and
  include it in context freshness checks.
- Runtime: require a successful `edit_prompt` for mutation requests and retain
  confirmed mutation evidence.
- Contracts/session schema: persist versioned diff evidence.
- Process/chat UI: surface the compact change row before the final answer and
  keep ordinary process detail folded.
- Python: only extend validation/response data if confirmed before/after values
  are not already available; do not move toolkit execution to Python.

## Implementation Increments

### Increment 1: contracts and lossless parser

- Add prompting capability types and hybrid document contracts.
- Implement parsing and no-op round-trip composition.
- Cover NL, tags, weights, escapes, LoRA, wildcard, `BREAK`, `AND`, empty input,
  malformed syntax, Unicode, and maximum-size input.

Exit: parse/compose is lossless and never silently drops unknown content.

### Increment 2: deterministic toolkit

- Implement analyze, split, safe deduplicate, stable sort, normalize, validate,
  and compose.
- Register the single aggregate tool.
- Add focused operation and abort tests.

Exit: read-only toolkit calls cannot mutate Forge and return bounded structured
results.

### Increment 3: Agent Loop mutation path

- Teach the active model prompt about hybrid NL/tag capability.
- Route mutation intent through read -> toolkit -> edit.
- Teach the Agent that disabled negative text is editable but not effective, and
  prevent it from claiming active exclusions based only on a successful write.
- Verify stale hash reread/recompute, failure, abort, and later-submit recovery.

Exit: the runtime cannot claim success without confirmed `edit_prompt` success.

### Increment 4: confirmed diff UI and persistence

- Add semantic diff generation and mutation evidence.
- Render compact summary plus expandable red/green diff.
- Persist/restore diff evidence and support confirmed inverse diff on undo.
- Verify desktop, narrow mobile, touch, keyboard, forced colors, and 200% zoom.

Exit: users can identify every added, removed, moved, and normalized item, while
the final answer remains immediately readable.

### Increment 5: model-specific refinement

- Add per-profile category/layout policies.
- Optionally connect verified local tag metadata to classification.
- Consider user-managed reusable NL blocks only after the core mutation and diff
  path is stable.

## Acceptance Criteria

### Hybrid prompt semantics

- A mixed prompt is split without destroying NL sentences or special syntax.
- Safe deduplication removes exact/canonical tag duplicates within a group.
- Different groups and uncertain NL similarities are preserved and reported.
- Stable sorting changes category order only and preserves within-category order.
- NL blocks are not reordered during a tag-only operation.
- The current hybrid profile explicitly tells the LLM that both NL and Danbooru
  tags are supported.
- Reading either prompt field exposes the current negative activation state.
- Existing negative text with CFG at or below `1.0` is reported as disabled, not
  empty or effective.

### Agent and data integrity

- Read-only analysis never writes Forge state.
- Mutation completes only after a hash-guarded `edit_prompt` succeeds.
- A successful edit to disabled negative text is reported as changed but not
  effective and does not silently enable CFG.
- Enabling/disabling the negative field after a read invalidates the relevant
  context before an effective-state claim.
- Stale writes reread and recompute; failed writes leave the composer usable.
- Abort and refresh never replay a transformation or write.
- Persisted session restoration renders prior diff evidence without tool replay.

### Diff UX

- Every confirmed prompt mutation shows field, additions, removals, moves, and
  normalization counts.
- Negative diffs always show an enabled/disabled status; disabled text changes
  use explicit “changed but inactive” copy.
- Expanded content displays red removals and green additions with non-color
  labels/icons.
- Tag, NL, special-token, and move changes remain distinguishable.
- Failed writes never display a success diff.
- Large and mobile diffs remain bounded and do not hide the final answer.
- Undo displays a confirmed inverse diff and preserves truthful history.

## Verification Plan

During each increment:

```powershell
python tools/test_gate.py affected
```

Before delivery:

```powershell
python tools/test_gate.py full
```

Add focused frontend unit tests for parsing, operations, tool contracts, Agent
Loop recovery, serialization, and diff rendering. Add high-level browser tests
only for observable acceptance behavior: confirmed mutation diff, failed write,
stale recovery, abort, refresh restoration without replay, undo, mobile layout,
and keyboard accessibility.

Any implementation must update the matching critical acceptance entries before
the full gate and append a concise `AUDIT.md` record without raw prompt content.
