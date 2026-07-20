from __future__ import annotations

from pathlib import Path
from typing import Any


ANIMA_DIT_GUIDE = """# Anima DiT prompt guide

Source: https://huggingface.co/circlestone-labs/Anima
Reviewed: 2026-07-11

Use this guide only for Anima image checkpoints.

## Model variants
- Anima Base is flexible and neutral. It benefits most from explicit quality, style, subject, and composition guidance.
- Anima Aesthetic is already quality-tuned. `masterpiece, best quality` is safe, but score tags are optional; remove score tags and lower CFG if the result becomes noisy or over-detailed.
- Anima Turbo is distilled for fast iteration and normally uses CFG 1 and 8-12 steps. At CFG 1, classifier-free guidance reduces to the positive prediction and the negative prompt has no effect. Do not generate or rely on a negative prompt for the normal Turbo setup.

## Prompt grammar
- Anima understands Danbooru/Gelbooru-style tags, natural-language captions, and mixtures of both.
- Write ordinary tags in lowercase and use spaces instead of underscores. Score tags such as `score_7` keep underscores.
- Preferred tag order: quality/meta/year/safety, subject count, character, series, artist, then general appearance/action/composition tags.
- Prefix artist tags with `@`, for example `@artist name`; without `@` the artist effect is weak.
- Prompt weighting works but usually needs stronger values than SDXL, for example `(chibi:2)`.
- Preserve wildcard references such as `__artist_names__`, dynamic choices, and LoRA tags such as `<lora:name:1>` exactly. Never expand, translate, rename, or reformat them unless the user explicitly asks.
- Anima uses a small Qwen3 0.6B text encoder. Assume limited comprehension: use simple tags or short, direct English clauses rather than sophisticated prose.
- Keep the final positive prompt well below 256 tokens whenever possible; 256 tokens is an absolute ceiling, not a target. A shorter prompt with clear subject, action, composition, and style is more reliable.
- Express one visual fact at a time. Avoid nested or dependent clauses, abstract relationships, implied references, long chains of interactions, repeated synonyms, exhaustive tag lists, and conflicting micro-details.
- For complex requests, keep only the highest-priority visible details. Do not try to preserve every instruction by compressing them into a dense paragraph.

## Useful defaults
- Base positive prefix: `masterpiece, best quality, score_7, safe, `.
- Base/Aesthetic negative: `worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, chromatic aberration`.
- Turbo negative prompts have no effect at CFG 1. Omit them. To make a negative prompt participate, CFG must be above 1, which departs from the recommended Turbo setup and may change or degrade its distilled behavior.
- Quality tags are optional on Aesthetic. Do not mechanically stack every score tag.
- Use `safe`, `sensitive`, `nsfw`, or `explicit` only when it matches the user's requested rating.

## Natural language and multi-character scenes
- Natural-language prompts may use two or more short sentences when needed, but each sentence should remain simple and concrete.
- Quality and artist tags may precede natural language.
- For named characters, state the name first and then describe the visible appearance.
- For multiple characters, state the exact count and give each character a position, appearance, pose, gaze, and interaction. Do not provide only a list of names.
- Prefer concrete spatial wording such as left, center, right, foreground, behind, facing the viewer, and looking at each other.

## Limitations
- Anima targets anime, illustration, and other non-photorealistic art; do not promise strong photorealism.
- Short or underspecified prompts can produce unwanted content. Add subject, appearance, composition, and an appropriate safety tag.
- Long rendered text is unreliable.
"""


_DANBOORU_TAGS_GUIDE_PATH = Path(__file__).resolve().parents[1] / "docs" / "DANBOORU_TAGS_AGENT.md"


def _read_danbooru_tags_guide() -> str:
    return _DANBOORU_TAGS_GUIDE_PATH.read_text(encoding="utf-8")


PROMPT_SKILLS = {
    "anima_dit": {
        "name": "anima_dit",
        "title": "Anima DiT prompt guide",
        "guide": ANIMA_DIT_GUIDE,
        "source": "https://huggingface.co/circlestone-labs/Anima",
        "reviewed": "2026-07-11",
    },
    "danbooru_tags": {
        "name": "danbooru_tags",
        "title": "Danbooru tags agent reference",
        "guide": _read_danbooru_tags_guide(),
        "source": "https://danbooru.donmai.us/wiki_pages/tag_groups",
        "reviewed": "2026-07-12",
    },
}


def normalize_prompt_skill_name(name: str) -> str:
    return str(name or "").strip().lower().replace("-", "_").replace(" ", "_")


def load_prompt_skill(name: str) -> dict[str, Any]:
    normalized = normalize_prompt_skill_name(name)
    skill = PROMPT_SKILLS.get(normalized)
    if skill is None:
        return {
            "ok": False,
            "name": normalized,
            "available": sorted(PROMPT_SKILLS),
            "error": f"unknown prompt skill: {normalized or name}",
        }
    return {"ok": True, **skill}


def automatic_prompt_skill(forge_preset: str = "", checkpoint: str = "") -> str:
    text = f"{forge_preset} {checkpoint}".casefold()
    return "anima_dit" if "anima" in text else ""
