---
name: danbooru-prompting
description: Build visible-facts Danbooru tag prompts with canonical names and conservative identity claims.
---

# Danbooru Prompting

Use this skill only when the user explicitly requests Danbooru, Gelbooru,
booru-style tags, tag syntax, or tag-based prompt construction.

## Contract

- Describe visible facts before inferred identity or story.
- Prefer canonical underscore-separated tag names.
- Keep character, rating, composition, clothing, action, expression, lighting,
  background, and style concepts distinguishable.
- Do not invent a named character when the evidence is insufficient.
- Avoid mutually contradictory tags unless the user explicitly wants variants.
- Verify uncertain or easily-confused canonical names with the available
  Danbooru lookup tools.
- Return a compact usable tag sequence before optional explanation.

The full project reference remains in `docs/DANBOORU_TAGS_AGENT.md` for the Forge
extension and future package-tool integration.
