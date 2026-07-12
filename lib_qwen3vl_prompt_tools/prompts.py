from __future__ import annotations

import re


ENHANCE_TASKS = {
    "refine": (
        "Rewrite the user's idea as one precise image-generation prompt. Preserve every stated subject and constraint, "
        "remove repetition and vague filler, and improve visual clarity. Do not invent new objects."
    ),
    "expand": (
        "Expand the user's idea into one production-ready image-generation prompt. Preserve the concept, then add "
        "coherent composition, lighting, material, color, atmosphere, and camera details where they help."
    ),
    "stylize": (
        "Rewrite the user's idea as one strongly art-directed image-generation prompt. Preserve the subject and action, "
        "then make the medium, visual language, palette, texture, lighting, and finish explicit."
    ),
}


CAPTION_TASKS = {
    "完整反推": (
        "Describe the image as a faithful, production-ready text-to-image prompt. Cover subject, action, composition, "
        "camera/viewpoint, lighting, palette, materials, atmosphere, style, and visible text. Do not guess identities or "
        "facts that are not visible."
    ),
    "主体与构图": (
        "Describe the image with emphasis on subjects, pose or action, object count, spatial relationships, framing, "
        "viewpoint, focal length cues, depth, and background. Keep style notes brief."
    ),
    "风格与材质": (
        "Reverse-engineer the image's visual style. Describe medium, rendering or photographic process, palette, "
        "lighting, contrast, surface texture, materials, era, graphic treatment, and finishing details. Mention content "
        "only when needed to anchor the style."
    ),
    "文字与版式": (
        "Inspect the image for typography and graphic design. Transcribe visible text exactly when legible, and describe "
        "font character, hierarchy, alignment, spacing, layout, colors, print effects, and surrounding imagery. Mark "
        "unreadable text as [illegible] instead of guessing."
    ),
}


SYSTEM_PROMPT = (
    "You are a visual prompt editor working with the Krea 2 text-to-image model. Follow the requested task exactly. "
    "Return only the finished prompt, with no analysis, preface, labels, markdown, or quotation marks. "
    'Describe only desired visible content; never use an English "no ..." phrase.'
)


def _chat(system: str, user: str, *, with_image: bool) -> str:
    image_block = "<|vision_start|><|image_pad|><|vision_end|>\n" if with_image else ""
    return (
        f"<|im_start|>system\n{system}<|im_end|>\n"
        f"<|im_start|>user\n{image_block}{user}<|im_end|>\n"
        "<|im_start|>assistant\n<think>\n\n</think>\n\n"
    )


def build_enhance_chat(text: str, task: str, language: str = "English") -> str:
    instruction = ENHANCE_TASKS.get(task, ENHANCE_TASKS["refine"])
    user = f"{instruction}\n\nOutput language: {language}.\n\nUser idea:\n{text.strip()}"
    return _chat(SYSTEM_PROMPT, user, with_image=False)


def build_caption_chat(task: str, guidance: str = "", language: str = "English") -> str:
    instruction = CAPTION_TASKS.get(task, CAPTION_TASKS["完整反推"])
    if guidance.strip():
        instruction += f"\nAdditional user direction: {guidance.strip()}"
    user = f"{instruction}\n\nOutput language: {language}."
    return _chat(SYSTEM_PROMPT, user, with_image=True)


def clean_generation(text: str) -> str:
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL | re.IGNORECASE)
    text = text.replace("<|im_end|>", "").replace("<|endoftext|>", "")
    text = re.sub(r"^\s*(?:prompt|enhanced prompt|caption)\s*:\s*", "", text, flags=re.IGNORECASE)
    text = text.strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in {'"', "'"}:
        text = text[1:-1].strip()
    return text
