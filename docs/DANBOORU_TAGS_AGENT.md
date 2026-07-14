# Danbooru Tags Agent Reference

Purpose: produce, normalize, review, or explain Danbooru-compatible image tags. This is a compact operational index, not a replacement for a tag's own live wiki page.

Sources retrieved 2026-07-12:

- https://danbooru.donmai.us/wiki_pages/help:home
- https://danbooru.donmai.us/wiki_pages/howto%3Atag
- https://danbooru.donmai.us/wiki_pages/tag_groups

## Operating Contract

Use this reference only when the user explicitly asks for Danbooru, Gelbooru, booru tags, tag normalization, tag review, tag-style prompts, or tag-wiki guidance. Do not force tag syntax into an ordinary natural-language prompt unless requested. Natural-language prompts do not need a Danbooru lookup; keep them direct and visually clear.

Tag requests have a mandatory preflight gate: before writing a final tag prompt or editing the WebUI, extract 2-12 short English visual concepts from the user's request and make one `search_danbooru_tags` call with `queries`. This applies to Chinese requests and unfamiliar terminology. Use the resulting candidates to form the prompt; do not bypass the search because a term seems familiar.

For tag output:

1. Describe visible facts only. Do not tag facts known from canon, filenames, metadata, or prior context unless they are visible or the user explicitly asks for catalog metadata.
2. Prefer established canonical tags. Do not invent plausible tags; flag an uncertain term for live wiki/tag search instead.
3. Output lowercase, space-separated terms in a comma-separated list for Anima prompts. Never copy Danbooru's underscore database keys to the prompt: output `blue hair`, not `blue_hair`; output `black rock shooter (character)`, not `black_rock_shooter_(character)`.
4. The lookup tools return `name` and `prompt_tag` in prompt-ready space-separated form. `canonical_name` contains the underscore database key solely for a follow-up lookup; never reproduce it in prompt text.
5. Use singular object nouns when creating or normalizing a general tag: `wispberry`, not `wispberries`.
6. Do not use subjective tags such as `sexy`, `cute`, or `hot`. They express opinion rather than a stable visual fact.
7. Do not duplicate tags or add synonymous near-duplicates. Prefer the most specific verified tag; retain broader tags only when they independently convey useful information.
8. Separate an uncertain identification from visual description. A character or copyright that cannot be identified should not prevent tagging visible clothing, pose, objects, composition, and setting.

## Tagging Order

For a complete cataloging pass, inspect in this order. Stop when the requested detail level is reached.

1. Artist, character, copyright, source, rating, and spoilers when known or applicable.
2. Subject count and subject type.
3. Framing, viewpoint, orientation, and composition.
4. Visible anatomy, hair, face, expression, pose, gesture, and action.
5. Clothing, accessories, held/worn objects, and other objects.
6. Environment, background, lighting, color, style, text, and effects.
7. Required blacklist-sensitive tags and other high-impact content tags.

For image-generation prompts that accept Danbooru-style tags, use only user-requested, desired visual content. Exclusions belong in a negative prompt, not as `no ...` prose in a positive prompt.

## Evidence Boundary

### Tag What Is Visible

- Tag visible elements, even if they seem obvious from a character's identity.
- Do not tag obscured or off-frame parts. A waist-up view does not establish legwear or footwear.
- Do not apply a trait merely because it is canonical. For example, use `vampire` only when visible vampire characteristics support it.
- Canonical relationships may be tagged only where they convey meaningful, established information, such as `siblings`; do not infer subjective relationship labels from appearance alone.
- If an image has visible but unidentifiable content, describe the visible fact. In Danbooru upload work, `tagme`, `character_request`, `copyright_request`, or `source_request` indicate missing information; do not use these request tags as substitutes for ordinary visual tagging.

### Required High-Impact Tags

Danbooru's tagging guide calls out these tags as necessary on upload so blacklist filtering works: `furry`, `guro`, `incest`, `loli`, `shota`, `peeing`, `rape`, `scat`, `spoilers`, `vomit`, `yaoi`, and `male_focus`.

Apply only when the criterion is visibly and unambiguously met. Do not silently omit an applicable tag in a cataloging task. For image-generation tasks, follow the user's requested safety scope and platform policy.

## Tag Classes And Naming

Danbooru tag classes are artist, character, copyright, general, and meta. Existing tags normally appear without a prefix in exported tag lists. Prefixes are for creation or reclassification:

| Class | Creation prefix | Agent rule |
| --- | --- | --- |
| Artist | `artist:` or `art:` | Use a verified artist tag; do not guess attribution. |
| Character | `character:` or `char:` | Identify every featured character when possible. |
| Copyright | `copyright:` or `copy:` | Add the originating work for identified characters; use `original` for non-franchise art. |
| General | `general:` or `gen:` | Default class for visible concepts, objects, appearance, actions, and scenes. |
| Meta | `meta:` | Administrative or cross-cutting tags; use only established terms. |

Use the work's original name where Danbooru has established it. Preserve conventional name order: commonly `surname_givenname` for Asian names and `givenname_surname` for Western names. Use a full character name when possible.

Resolve a genuine ambiguity with a qualifier in parentheses. Examples: `black_rock_shooter` is the copyright, while `black_rock_shooter_(character)` is the protagonist. Do not add qualifiers speculatively; verify the canonical form first.

## Review Checklist

Before returning a tag list, check:

- Each tag corresponds to an observable or explicitly requested catalog fact.
- Character and copyright are present when identification is reliable.
- Counts, body visibility, orientation, action, interaction, and framing match the image.
- Apparel, accessories, props, and environment are only present when visible.
- No subjective, speculative, duplicate, pluralized-new-tag, misspelled, or fabricated tag appears.
- Applicable blacklist-sensitive tags are not missing.
- Unknown identities are marked separately from the visible tag list when the task is upload/catalog review.

## Tag Group Navigation

Use this index to decide where a disputed term belongs, then consult the linked live tag-group wiki for exact definitions, aliases, implications, and exceptions. A term may belong to more than one group.

### Composition And Style

- Artistic license, image composition, backgrounds, censorship, character count, colors, fine art parody, focus tags, lighting, prints, visual aesthetic, patterns, symbols, text, Japanese dialects, year tags.
- Live index: https://danbooru.donmai.us/wiki_pages/tag_group%3Aimage_composition

### Body And Appearance

- Body parts, ass, breasts tags, face tags, ears tags, eyes tags, hair, hair color, hair styles, hands, gestures, feet, neck and neckwear, posture, pussy, shoulders, skin color, wings, injury.
- Live index: https://danbooru.donmai.us/wiki_pages/tag_group%3Abody_parts

### Clothing And Accessories

- Accessories, attire, handwear, headwear, legwear, neck and neckwear, sexual attire, sleeves, embellishment, eyewear, fashion style, makeup, covering, nudity, mask, swimsuit.
- Live index: https://danbooru.donmai.us/wiki_pages/tag_group%3Aattire

### Actions, Sex, And Relationships

- Sex acts, simulated sex acts, sexual positions, BDSM and torture, dances, family relationships, groups, phrases, verbs and gerunds, transgender, gender nonconformity.
- Live index: https://danbooru.donmai.us/wiki_pages/tag_group%3Asex_acts

### Objects And Environments

- Audio tags, holding tags, cards, doors and gates, piercings, sex objects, weapons, vehicles, ships, aircraft, armor, technology, fire, water, locations, real-world locations.
- Live index: https://danbooru.donmai.us/wiki_pages/tag_group%3Aholding_tags

### Creatures, Plants, Food, And Activities

- Animals, birds, cats, dogs, legendary creatures, flowers, food tags, board games, sports, video games, game activities.
- Live index: https://danbooru.donmai.us/wiki_pages/list_of_animals

### Themes And Real World

- Companies and brand names, holidays and celebrations, jobs, people, history, theme, subjective, technology.
- `subjective` is a navigation group, not permission to apply opinion-based tags in ordinary image tagging.
- Live index: https://danbooru.donmai.us/wiki_pages/tag_group%3Atheme

### Characters, Media, And Meta

- Character lists are organized by copyright, including common series such as Arknights, Fate, Genshin-related media, Pokemon, Touhou, Umamusume, Vocaloid, and many others.
- Meta groups include metatags and drawing software.
- Live index: https://danbooru.donmai.us/wiki_pages/tag_groups

## Escalation

Use the `search_danbooru_tags` tool before asserting a tag when any of these are true. It is a read-only lookup against the live public tag database. It accepts up to 12 concepts in `queries`, combines autocomplete, prefix, and multiword wildcard candidate recall, then returns candidates grouped per query. Use `related_danbooru_tags` to expand one verified seed with co-occurring and wiki-linked candidates. Use `inspect_danbooru_tags` to validate up to 12 selected tags in parallel; set `include_wiki` only for terms whose definitions matter.

Search before asserting a tag when any of these are true:

- The concept could map to several near-synonyms or a qualifier.
- The object, clothing construction, pose, action, character, artist, or copyright is unfamiliar.
- A tag is likely aliased, deprecated, implication-heavy, or unusually sensitive.
- The user asks for an exhaustive upload-ready tag set rather than a generation-oriented list.

When live lookup is unavailable, state the uncertainty briefly and return only high-confidence visible tags. Never fabricate a canonical tag name to make the list look complete.
