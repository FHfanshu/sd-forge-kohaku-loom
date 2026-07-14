from __future__ import annotations

from typing import Any

MODEL_FILENAME = "model.onnx"
LABEL_FILENAME = "selected_tags.csv"

DEFAULT_GGUF_REPO = "HauhauCS/Qwen3.5-9B-Uncensored-HauhauCS-Aggressive"
DEFAULT_GGUF_DIR = "Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-GGUF"
DEFAULT_GGUF_MODEL = "Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-Q6_K.gguf"
DEFAULT_GGUF_MMPROJ = "mmproj-Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-BF16.gguf"
DEFAULT_LLAMA_SERVER_CANDIDATES = [
    r"E:\AI\lmcpp\llama.cpp\llama-server.exe",
]
LLAMA_CPP_RELEASE_API = "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest"
DEFAULT_ASSISTANT_BACKEND = "moyuu"
DEFAULT_ASSISTANT_ENDPOINT = "https://moyuu.cc"
DEFAULT_ASSISTANT_FALLBACK_ENDPOINT = "https://hk-api.moyuu.cc"
DEFAULT_ASSISTANT_MODEL = "gemini-3.5-flash-preview"
DEFAULT_LOCAL_ASSISTANT_ENDPOINT = "http://127.0.0.1:8080/v1"
DEFAULT_LOCAL_ASSISTANT_MODEL = "hauhau-qwen3.5-9b-uncensored"
DEFAULT_LOCAL_CONTEXT_TOKENS = 16384
DEFAULT_LOCAL_TEXT_PRESET = "Qwen3.5 原版 9B"
VISION_MODEL_PRESET_CUSTOM = "自定义"
DEFAULT_VISION_MODEL_PRESET = "Qwen3.5 原版 9B"
VISION_MODEL_PRESETS: dict[str, dict[str, Any]] = {
    "Gemma 4 12B": {
        "alias": "gemma-4-12b-it",
        "model_globs": [
            "gemma-4-12b-it-UD-Q8_K_XL.gguf",
            "**/gemma-4-12b-it-UD-Q8_K_XL.gguf",
            "**/*gemma*4*12b*it*.gguf",
        ],
        "mmproj_globs": [
            "mmproj-gemma-4-12B-it-BF16.gguf",
            "**/mmproj-gemma-4-12B-it-BF16.gguf",
            "mmproj-BF16.gguf",
            "**/*gemma*mmproj*.gguf",
            "**/*mmproj*gemma*.gguf",
            "**/mmproj-BF16.gguf",
        ],
        "auto_download": False,
    },
    "Qwen3.5 原版 9B": {
        "alias": "qwen3.5-9b-vlm",
        "model_globs": [
            "Qwen3.5-9B-GGUF/Qwen3.5-9B-UD-Q6_K_XL.gguf",
            "**/Qwen3.5-9B-GGUF/Qwen3.5-9B-UD-Q6_K_XL.gguf",
            "**/Qwen3.5-9B-UD-Q6_K_XL.gguf",
        ],
        "mmproj_globs": [
            "Qwen3.5-9B-GGUF/mmproj-F16.gguf",
            "**/Qwen3.5-9B-GGUF/mmproj-F16.gguf",
            "**/mmproj-F16.gguf",
        ],
        "auto_download": False,
    },
    "Qwen3.5 破限版 9B": {
        "alias": "hauhau-qwen3.5-9b-uncensored",
        "model_globs": [
            "Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-GGUF/Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-Q6_K.gguf",
            "**/Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-Q6_K.gguf",
        ],
        "mmproj_globs": [
            "Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-GGUF/mmproj-Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-BF16.gguf",
            "**/mmproj-Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-BF16.gguf",
        ],
        "auto_download": True,
    },
}

PROMPT_ASSISTANT_SYSTEM = """You are an expert AI image prompt engineer for Stable Diffusion / Flux style image generation.

Primary job: write and revise production-ready image-generation prompts, especially prompts involving multiple characters, role distinction, spatial relationships, and scene composition.

Rules:
- Match the user's language for normal chat, greetings, explanations, summaries, and tool-result follow-up. If the user writes Chinese, reply in Chinese.
- When outputting a final image-generation prompt intended to be copied into txt2img/img2img, output only one concise production-ready English prompt unless the user explicitly asks for another prompt language or explanation.
- A good final prompt starts with the exact subject/count, then composition, spatial layout, pose/action, visible details, background, lighting, camera/framing, medium/style, and quality/aesthetic terms. Avoid vague filler and avoid explaining your choices.
- If the user only greets you or asks a meta question, answer naturally in the user's language instead of generating an image prompt.
- For group scenes, state the exact count first, then describe spatial positions such as left, center, right, foreground, background, behind, beside, facing camera, looking at each other, interaction, and relative scale.
- Keep characters visually distinguishable. Assign clear traits per position instead of blending attributes.
- Preserve the user's core idea, but improve clarity, composition, style terms, and model-friendly wording.
- Use Danbooru rules and live lookup only when the user requests a Danbooru/Gelbooru/booru tag list or tag-style prompt. For ordinary natural-language prompts, be direct and clear; do not spend turns validating each phrase against Danbooru.
- For a Danbooru/Gelbooru/booru tag request, the first action is mandatory preflight: extract 2-12 short English visual concepts from the user's request, then call search_danbooru_tags once with `queries`. Do not write a final tag prompt or edit the WebUI prompt until that candidate result is available. This is required even when the user writes Chinese or uses unfamiliar terms; translate the visual concepts for lookup, not the final prompt.
- Positive prompts must never use an English "no ..." phrase (for example, "no hat" or "no background"). Describe only desired visible content in the positive prompt; put exclusions in the negative prompt instead.
- If reference-image observations are present, use them as factual visual context and reusable style guidance. Do not mention that an image was analyzed in the final prompt.
- You are paired with a stronger Gemini teacher. If you are uncertain about composition, ambiguous user intent, difficult image interpretation, sensitive placeholder handling, or the exact edit plan, proactively call ask_teacher with sanitized context before finalizing. Do not guess when teacher consultation would materially improve the result.
- When revising an existing prompt, return the improved prompt only unless the user asks for explanation.
- Avoid moralizing or unrelated commentary. Do not include markdown unless asked.

Available UI tools:
- If native tool calling is available, use tool calls instead of writing tool JSON in normal text.
- If native tool calling is not available through the current API relay, emit the tool request as JSON text. It may be preceded by one short natural-language sentence, but the JSON must be complete and valid.
- Some prompt text may contain SAFE_SLOT_### placeholders. Treat them as opaque exact text: preserve them in SEARCH/REPLACE blocks, never expand or reinterpret them.
- To consult the remote Gemini teacher after local redaction, use ask_teacher with a sanitized question and relevant context. Use it proactively when confidence is low. Never send raw sensitive text; preserve SAFE_SLOT_### placeholders exactly.
- To read the current prompt, reply with exactly: {"tool":"read_prompt","arguments":{"target":"active"}}
- To inspect the active WebUI style template or determine whether character/style text comes from selected Styles or Forge's positive template, call read_style_template with the relevant target. Do not infer template contents from read_prompt alone.
- To edit the prompt, use edit_prompt with base_hash and a diff. Preferred diff format is a SEARCH/REPLACE block with markers named SEARCH, separator line =======, and ending marker REPLACE.
- target can be "active", "txt2img", or "img2img".
- read_prompt returns prompt, prompt_hash, and current UI context. It also includes a style summary for convenience.
- read_style_template returns the complete selected Styles details, including every positive/negative template, plus Forge's positive template and a combined style_template value.
- read_prompt also returns positive_prompt, negative_prompt, their hashes, a context_hash, the current Forge preset/checkpoint, and loaded prompt skills.
- edit_prompt also accepts patches with operations "replace", "replace_all", "replace_n", "insert_after", "insert_before", "append", "prepend", and "delete". Use exact text from read_prompt. For replace/insert, find text must be unique unless allow_multiple is true. If you cannot make a precise diff, pass the complete clean new prompt as "prompt" with the latest base_hash.
- edit_prompt accepts field "positive" or "negative"; the default is "positive" for backward compatibility. Use the matching hash returned by read_prompt. Never place "no ..." phrases in field "positive"; use field "negative" for exclusions.
- You must call read_prompt before edit_prompt. edit_prompt must include the base_hash returned by the latest read_prompt for the same concrete target.
- Never use whole-prompt replacement tools. For an empty prompt, use edit_prompt with operation "append" and the base_hash from read_prompt.
- Use tools when the user asks to inspect, rewrite, replace, append to, or send a prompt/template. Do not invent current UI text if you need to see it; call read_prompt first.
- If the user asks to change the current WebUI prompt, never claim it was changed and never stop with only a rewritten prompt. Call read_prompt if needed, then edit_prompt, and only say it is done after edit_prompt returns ok:true.
- Diff syntax is only a tool argument format. The actual prompt text written into WebUI must never contain git diff markers, patch headers, SEARCH/REPLACE markers, conflict markers, or fenced diff blocks.
- After a tool result is provided, continue with the requested concise final answer.
- Use search_resources to discover installed wildcard, Style, or LoRA resources. Use inspect_resource before relying on full contents or metadata. Search alone never changes the UI.
- For canonical Danbooru/Gelbooru tags, batch related concepts in one search_danbooru_tags call using `queries`; it returns autocomplete and prefix candidates for each. Use related_danbooru_tags to expand one verified seed, then inspect_danbooru_tags for several selected tags at once. Their `name` and `prompt_tag` fields are Anima-ready space-separated output; `canonical_name` is a lookup key only and must never be copied into a prompt. These tools are read-only and only search Danbooru; never claim they create or edit tags.
- Only call apply_resource when the user explicitly asks to apply/add/use a resource. Call read_prompt first and pass its latest context_hash. Wildcards remain __name__, LoRAs remain <lora:alias:weight>, and Styles remain native WebUI selections.
- Only call initialize_prompt when the user explicitly asks to initialize an empty generation prompt. It fills empty positive/negative fields and never overwrites existing content.
- Anima-specific guidance is injected automatically when the active Forge preset or checkpoint is Anima. Preserve wildcards, dynamic choices, and LoRA tags exactly.

Example structure:
Group selfie of three muscular anthropomorphic dragon men. Left: white fur, blue horns, blue goatee, white shirt, loose striped tie. Center: white fur, yellow horns, casual jacket. Right: dark fur, blue horns, open jacket revealing a bare muscular chest. Furry art, bara, all smiling and looking at the camera. Beautiful background with a clear mountain lake and lush green hills, highly detailed, daylight."""

REFERENCE_IMAGE_ANALYSIS_SYSTEM = """你是一名本地图像视觉分析子代理，只根据输入图片本身工作。

不要参考用户聊天文字，不要延展用户意图。输出需要同时包含精确的图像内容 caption 和可复用的风格描述，供后续文本模型整合提示词。"""

REFERENCE_IMAGE_STYLE_PROMPT = """请作为一名顶级的 AI 绘画提示词专家，为我分析这张图片。

任务目标：输出两部分信息，第一部分是精确详尽的图像 caption，第二部分是剥离主体后的通用风格 Prompt。你只能根据图片本身描述，不要引入用户额外要求。

第一部分：图像内容详述（必须保留主体）
- 客观描述画面中可见的主体数量、外观差异、服装/道具、表情、姿态、视线、动作、互动关系。
- 精确描述空间关系与构图：左/中/右、前景/中景/背景、遮挡、距离、透视、镜头角度、裁切、画幅、主体占比。
- 描述场景环境、背景元素、可见文字/符号、材质、光源方向、阴影和色彩关系。
- 这一部分必须保留原图中的具体主体内容，因为它用于后续上下文理解。不要把主体替换成占位符，不要省略主体身份、数量、外观、位置和互动。

第二部分：通用风格 Prompt
- 提取并反推这张图片的艺术风格，生成一份通用的 Prompt。
- 这一部分必须剥离原图中的具体角色、文字、身份或特定情节，仅保留其美学灵魂。

分析维度（请务必涵盖以下 15 个方面）：
基础维度：画面风格、画面成分组成、构图方式、分镜类型、光影特质、色调与色彩科学、媒介与材质纹理、情绪与氛围、渲染/拍摄参数。
进阶维度：时代感与文化语境、空间逻辑与透视关系、信息密度与留白、动态状态（瞬时感）、后期处理与数字痕迹、符号化特征。

输出要求：
1. 使用中文输出。
2. 请按以下两个标题输出：
【图像内容详述】
【通用风格 Prompt】
3. 【图像内容详述】要具体、细致、保留主体、可用于还原空间关系。
4. 【通用风格 Prompt】必须在开头或核心位置使用“[在此处替换为您想要生成的主体内容]”作为占位符。
5. 【通用风格 Prompt】要高度通用，用户只需更换占位符内容，即可在保持原图质感的同时生成全新的画面。
6. 不要输出推理过程、免责声明或与图片无关的内容。"""

ASSISTANT_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "ask_teacher",
            "description": "Ask the remote Gemini teacher for a second opinion after local Qwen redaction, especially when local Qwen is uncertain. Send only sanitized context and preserve SAFE_SLOT_### placeholders.",
            "parameters": {
                "type": "object",
                "properties": {
                    "question": {"type": "string", "description": "Specific question for the Gemini teacher."},
                    "context": {"type": "string", "description": "Sanitized prompt/context for the teacher. Keep SAFE_SLOT_### placeholders exactly."},
                    "goal": {"type": "string", "description": "Optional desired outcome, such as critique, rewrite, or edit plan."},
                },
                "required": ["question"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_prompt",
            "description": "Read the current txt2img/img2img prompt, prompt_hash, and selected WebUI Styles details. Must be called before edit_prompt.",
            "parameters": {
                "type": "object",
                "properties": {
                    "target": {"type": "string", "enum": ["active", "txt2img", "img2img"]},
                },
                "required": ["target"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "edit_prompt",
            "description": "Patch the prompt after read_prompt. Prefer diff using SEARCH/REPLACE blocks; include base_hash from read_prompt.",
            "parameters": {
                "type": "object",
                "properties": {
                    "target": {"type": "string", "enum": ["active", "txt2img", "img2img"]},
                    "field": {"type": "string", "enum": ["positive", "negative"], "description": "Prompt field to edit; defaults to positive."},
                    "base_hash": {"type": "string", "description": "prompt_hash returned by the latest read_prompt for this target"},
                    "diff": {
                        "type": "string",
                        "description": "One or more blocks: <<<<<<< SEARCH\nold exact text\n=======\nnew exact text\n>>>>>>> REPLACE",
                    },
                    "patches": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "operation": {"type": "string", "enum": ["replace", "replace_all", "replace_n", "insert_after", "insert_before", "append", "prepend", "delete"]},
                                "find": {"type": "string"},
                                "replace": {"type": "string"},
                                "text": {"type": "string"},
                                "separator": {"type": "string"},
                                "count": {"type": "integer"},
                                "allow_multiple": {"type": "boolean"},
                            },
                            "required": ["operation"],
                        },
                    },
                    "operations": {
                        "type": "array",
                        "description": "Alias for patches, accepted for local models that call patch lists operations.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "operation": {"type": "string", "enum": ["replace", "replace_all", "replace_n", "insert_after", "insert_before", "append", "prepend", "delete"]},
                                "find": {"type": "string"},
                                "replace": {"type": "string"},
                                "text": {"type": "string"},
                                "separator": {"type": "string"},
                                "count": {"type": "integer"},
                                "allow_multiple": {"type": "boolean"},
                            },
                            "required": ["operation"],
                        },
                    },
                    "patch": {
                        "type": "object",
                        "description": "Single patch object, accepted as a shortcut for patches with one item.",
                    },
                    "prompt": {
                        "type": "string",
                        "description": "Complete clean replacement prompt, used only when a precise diff/patch is not practical. Do not include diff markers.",
                    },
                    "return_prompt": {"type": "boolean"},
                },
                "required": ["target", "base_hash"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_style_template",
            "description": "Read all active WebUI style-template sources for txt2img/img2img. Returns the selected Style names and their positive/negative templates, Forge's positive template, and a combined style_template. Use this to inspect style or character settings before explaining them.",
            "parameters": {
                "type": "object",
                "properties": {
                    "target": {"type": "string", "enum": ["active", "txt2img", "img2img"]},
                },
                "required": ["target"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_resources",
            "description": "Search installed Forge wildcard, Style, or LoRA resources without changing the UI.",
            "parameters": {
                "type": "object",
                "properties": {
                    "kind": {"type": "string", "enum": ["wildcard", "style", "lora"]},
                    "query": {"type": "string", "description": "Case-insensitive fuzzy query. Terms separated by spaces are ANDed; use | to OR groups, for example 'dragon boy | xiuran'."},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 50},
                    "cursor": {"type": "string", "description": "next_cursor from the previous result."},
                },
                "required": ["kind"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "inspect_resource",
            "description": "Inspect one installed resource. Wildcard values are queryable and paginated.",
            "parameters": {
                "type": "object",
                "properties": {
                    "kind": {"type": "string", "enum": ["wildcard", "style", "lora"]},
                    "id": {"type": "string", "description": "Logical id returned by search_resources; never a filesystem path."},
                    "query": {"type": "string"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 100},
                    "cursor": {"type": "string"},
                },
                "required": ["kind", "id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "apply_resource",
            "description": "Apply an installed wildcard, Style, or LoRA using native Forge syntax after read_prompt. Only use after an explicit user apply request.",
            "parameters": {
                "type": "object",
                "properties": {
                    "kind": {"type": "string", "enum": ["wildcard", "style", "lora"]},
                    "id": {"type": "string"},
                    "target": {"type": "string", "enum": ["active", "txt2img", "img2img"]},
                    "context_hash": {"type": "string", "description": "Latest context_hash returned by read_prompt."},
                    "weight": {"type": "number", "minimum": -10, "maximum": 10},
                },
                "required": ["kind", "id", "target", "context_hash"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "initialize_prompt",
            "description": "Fill empty positive and negative prompt fields without overwriting existing text. Only use after an explicit user initialization request.",
            "parameters": {
                "type": "object",
                "properties": {
                    "target": {"type": "string", "enum": ["active", "txt2img", "img2img"]},
                    "context_hash": {"type": "string"},
                    "positive_prompt": {"type": "string"},
                    "negative_prompt": {"type": "string"},
                },
                "required": ["target", "context_hash", "positive_prompt", "negative_prompt"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_danbooru_tags",
            "description": "Search Danbooru's live public tag database for canonical names, categories, usage counts, and deprecation status. Returned name and prompt_tag fields use Anima-ready spaces; canonical_name is lookup-only. Use before asserting unfamiliar, ambiguous, or qualified booru tags. Read-only; never creates a tag.",
            "parameters": {
                "type": "object",
                "properties": {
                    "queries": {"type": "array", "description": "Batch of up to 12 tag concepts. Use this for a scene instead of one search call per concept.", "items": {"type": "string"}, "maxItems": 12},
                    "category": {"type": "string", "enum": ["general", "artist", "copyright", "character", "meta"], "description": "Optional category filter."},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 30},
                },
                "required": ["queries"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "inspect_danbooru_tag",
            "description": "Fetch one exact canonical Danbooru tag and its live wiki definition. Call search_danbooru_tags first when the spelling is uncertain. Read-only; never creates or modifies a tag.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Exact tag selected from search_danbooru_tags. Both its prompt-ready name and canonical_name are accepted."},
                },
                "required": ["name"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "inspect_danbooru_tags",
            "description": "Inspect up to 12 selected Danbooru tags in parallel. Returns category, usage, and deprecation information; request wiki only when definitions are genuinely needed. Read-only.",
            "parameters": {
                "type": "object",
                "properties": {
                    "names": {"type": "array", "items": {"type": "string"}, "minItems": 1, "maxItems": 12},
                    "include_wiki": {"type": "boolean", "description": "Fetch each selected tag's wiki definition. Use sparingly for ambiguous terms."},
                },
                "required": ["names"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "related_danbooru_tags",
            "description": "Get live co-occurring tags and wiki-linked suggestions for one verified Danbooru tag. Use as candidate ideas only; add a suggestion only when it matches the requested or visible content. Read-only.",
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "Verified seed tag, in prompt-ready or canonical form."},
                    "category": {"type": "string", "enum": ["general", "artist", "copyright", "character", "meta"]},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 30},
                },
                "required": ["name"],
            },
        },
    },
]

TAGGER_MODELS = {
    "WD EVA02 large v3": "SmilingWolf/wd-eva02-large-tagger-v3",
    "WD ViT v3": "SmilingWolf/wd-vit-tagger-v3",
    "WD ViT large v3": "SmilingWolf/wd-vit-large-tagger-v3",
    "WD SwinV2 v3": "SmilingWolf/wd-swinv2-tagger-v3",
    "WD ConvNeXt v3": "SmilingWolf/wd-convnext-tagger-v3",
}

KAOMOJI_TAGS = {
    "0_0",
    "(o)_(o)",
    "+_+",
    "+_-",
    "._.",
    "_",
    "<|>_<|>",
    "=_=",
    ">_<",
    "3_3",
    "6_9",
    ">_o",
    "@_@",
    "^_^",
    "o_o",
    "u_u",
    "x_x",
    "|_|",
    "||_||",
}
STYLE_EXTRACTION_TEMPLATE = """Act as a top-tier AI image prompt specialist and analyze the visual style of the provided image.

Goal: extract and reverse-engineer the image's artistic style into a universal prompt. The prompt must remove the original image's specific character, readable text, named identity, and concrete story event, keeping only its aesthetic essence.

Hard subject-removal rule: do not name or describe the original subject category, species, role, clothing, props, pose, facial features, body parts, character identity, or any concrete object that would recreate the source content. Replace the whole subject with the exact placeholder "[replace with your desired subject here]" and describe only how that placeholder should be rendered.

Required style dimensions: image style, visual component structure, composition method, shot/framing type, light and shadow qualities, tone and color science, medium and material texture, emotion and atmosphere, rendering or camera parameters, period feeling and cultural context, spatial logic and perspective, information density and negative space, dynamic instantaneity, post-processing and digital artifacts, symbolic visual traits.

Output requirements:
1. Output one complete, high-quality English prompt only.
2. Put the placeholder "[replace with your desired subject here]" at the beginning or core position of the prompt.
3. Make the prompt highly reusable: the user should only need to replace the placeholder to generate a new image with the same visual texture.
4. Do not output analysis, headings, labels, markdown, or explanations; output the final prompt text only."""


NL_PROMPT_TEMPLATES = {
    "通用图像提示词": "standard",
    "美学风格抽取（Anima 英文）": STYLE_EXTRACTION_TEMPLATE,
}
