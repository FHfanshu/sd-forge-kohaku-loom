from __future__ import annotations

import base64
import io
import json
import gc
import os
import re
import shutil
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import huggingface_hub
import numpy as np
import onnxruntime as ort
import pandas as pd
import requests
from PIL import Image


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
DEFAULT_ASSISTANT_ENDPOINT = "https://api.deepseek.com"
DEFAULT_ASSISTANT_MODEL = "deepseek-v4-pro"
DEFAULT_LOCAL_ASSISTANT_ENDPOINT = "http://127.0.0.1:8080/v1"
DEFAULT_LOCAL_ASSISTANT_MODEL = "hauhau-qwen3.5-9b-uncensored"

PROMPT_ASSISTANT_SYSTEM = """You are an expert AI image prompt engineer.

Primary job: help write and revise image-generation prompts, especially prompts involving multiple characters, role distinction, spatial relationships, and scene composition.

Rules:
- Match the user's language for normal chat, greetings, explanations, summaries, and tool-result follow-up. If the user writes Chinese, reply in Chinese.
- When outputting a final image-generation prompt intended to be copied into txt2img/img2img, use concise production-ready English unless the user explicitly asks for another prompt language.
- If the user only greets you or asks a meta question, answer naturally in the user's language instead of generating an image prompt.
- For group scenes, state the exact count first, then describe spatial positions such as left, center, right, foreground, background, behind, beside, facing camera, looking at each other, interaction, and relative scale.
- Keep characters visually distinguishable. Assign clear traits per position instead of blending attributes.
- Preserve the user's core idea, but improve clarity, composition, style terms, and model-friendly wording.
- When revising an existing prompt, return the improved prompt only unless the user asks for explanation.
- Avoid moralizing or unrelated commentary. Do not include markdown unless asked.

Available UI tools:
- If native tool calling is available, use tool calls instead of writing tool JSON in normal text.
- To read the current prompt, reply with exactly: {"tool":"read_prompt","arguments":{"target":"active"}}
- To edit the prompt, use edit_prompt with base_hash and a diff. Preferred diff format is a SEARCH/REPLACE block with markers named SEARCH, separator line =======, and ending marker REPLACE.
- target can be "active", "txt2img", or "img2img".
- read_prompt returns prompt, prompt_hash, and style_template when the WebUI style template field is found.
- edit_prompt also accepts patches with operations "replace", "replace_all", "replace_n", "insert_after", "insert_before", "append", "prepend", and "delete". Use exact text from read_prompt. For replace/insert, find text must be unique unless allow_multiple is true.
- You must call read_prompt before edit_prompt. edit_prompt must include the base_hash returned by the latest read_prompt for the same concrete target.
- Never use whole-prompt replacement tools. For an empty prompt, use edit_prompt with operation "append" and the base_hash from read_prompt.
- Use tools when the user asks to inspect, rewrite, replace, append to, or send a prompt/template. Do not invent current UI text if you need to see it; call read_prompt first.
- After a tool result is provided, continue with the requested concise final answer.

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
            "name": "read_prompt",
            "description": "Read the current txt2img/img2img prompt and return prompt_hash. Must be called before edit_prompt.",
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
                    "return_prompt": {"type": "boolean"},
                },
                "required": ["target", "base_hash"],
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


@dataclass(slots=True)
class TaggerResult:
    tags: str
    characters: str
    rating: str
    raw_json: str


def _load_labels(dataframe: pd.DataFrame):
    name_series = dataframe["name"].map(lambda value: value if value in KAOMOJI_TAGS else value.replace("_", " "))
    tag_names = name_series.tolist()
    rating_indexes = list(np.where(dataframe["category"] == 9)[0])
    general_indexes = list(np.where(dataframe["category"] == 0)[0])
    character_indexes = list(np.where(dataframe["category"] == 4)[0])
    return tag_names, rating_indexes, general_indexes, character_indexes


def _mcut_threshold(probs: np.ndarray) -> float:
    sorted_probs = probs[probs.argsort()[::-1]]
    if len(sorted_probs) < 2:
        return 0.0
    difs = sorted_probs[:-1] - sorted_probs[1:]
    t = int(difs.argmax())
    return float((sorted_probs[t] + sorted_probs[t + 1]) / 2)


class WDTagger:
    def __init__(self):
        self.lock = threading.Lock()
        self.session: ort.InferenceSession | None = None
        self.loaded_repo: str | None = None
        self.model_target_size = 448
        self.tag_names: list[str] = []
        self.rating_indexes: list[int] = []
        self.general_indexes: list[int] = []
        self.character_indexes: list[int] = []

    def load(self, repo: str) -> str:
        with self.lock:
            if repo == self.loaded_repo and self.session is not None:
                return f"loaded: {repo}"

            csv_path = huggingface_hub.hf_hub_download(repo, LABEL_FILENAME)
            model_path = huggingface_hub.hf_hub_download(repo, MODEL_FILENAME)
            labels = _load_labels(pd.read_csv(csv_path))

            available = ort.get_available_providers()
            providers = [
                provider
                for provider in ("CUDAExecutionProvider", "DmlExecutionProvider", "CPUExecutionProvider")
                if provider in available
            ] or available

            session = ort.InferenceSession(model_path, providers=providers)
            _, height, _, _ = session.get_inputs()[0].shape

            self.session = session
            self.loaded_repo = repo
            self.model_target_size = int(height)
            self.tag_names, self.rating_indexes, self.general_indexes, self.character_indexes = labels
            return f"loaded: {repo} · {self.model_target_size}px · {', '.join(session.get_providers())}"

    def unload(self) -> str:
        with self.lock:
            self.session = None
            self.loaded_repo = None
            return "tagger unloaded"

    def _prepare_image(self, image: Image.Image) -> np.ndarray:
        target_size = self.model_target_size
        image = image.convert("RGBA")
        canvas = Image.new("RGBA", image.size, (255, 255, 255, 255))
        canvas.alpha_composite(image)
        image = canvas.convert("RGB")

        max_dim = max(image.size)
        pad_left = (max_dim - image.size[0]) // 2
        pad_top = (max_dim - image.size[1]) // 2
        padded = Image.new("RGB", (max_dim, max_dim), (255, 255, 255))
        padded.paste(image, (pad_left, pad_top))
        if max_dim != target_size:
            padded = padded.resize((target_size, target_size), Image.BICUBIC)

        image_array = np.asarray(padded, dtype=np.float32)
        image_array = image_array[:, :, ::-1]
        return np.expand_dims(image_array, axis=0)

    def predict(
        self,
        image: Image.Image,
        repo: str,
        general_threshold: float,
        general_mcut: bool,
        character_threshold: float,
        character_mcut: bool,
        include_character_tags: bool,
        limit_tags: int,
    ) -> TaggerResult:
        if image is None:
            raise RuntimeError("请先放入一张图片。")

        self.load(repo)
        if self.session is None:
            raise RuntimeError("Tagger model is not loaded.")

        input_name = self.session.get_inputs()[0].name
        output_name = self.session.get_outputs()[0].name
        preds = self.session.run([output_name], {input_name: self._prepare_image(image)})[0][0].astype(float)
        labels = list(zip(self.tag_names, preds))

        rating_items = [labels[index] for index in self.rating_indexes]
        rating = max(rating_items, key=lambda item: item[1])[0] if rating_items else ""

        general_items = [labels[index] for index in self.general_indexes]
        if general_mcut:
            general_threshold = _mcut_threshold(np.array([score for _, score in general_items]))
        general = [(name, score) for name, score in general_items if score > float(general_threshold)]
        general.sort(key=lambda item: item[1], reverse=True)

        character_items = [labels[index] for index in self.character_indexes]
        if character_mcut:
            character_threshold = max(0.15, _mcut_threshold(np.array([score for _, score in character_items])))
        characters = [(name, score) for name, score in character_items if score > float(character_threshold)]
        characters.sort(key=lambda item: item[1], reverse=True)

        if int(limit_tags) > 0:
            general = general[: int(limit_tags)]

        tag_names = [name for name, _ in general]
        if include_character_tags:
            tag_names = [name for name, _ in characters] + tag_names

        raw = {
            "rating": rating,
            "characters": [{"tag": name, "score": round(float(score), 4)} for name, score in characters],
            "general": [{"tag": name, "score": round(float(score), 4)} for name, score in general],
        }
        return TaggerResult(
            tags=", ".join(tag_names),
            characters=", ".join(name for name, _ in characters),
            rating=rating,
            raw_json=json.dumps(raw, ensure_ascii=False, indent=2),
        )


TAGGER = WDTagger()


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


def repo_from_label(label_or_repo: str) -> str:
    return TAGGER_MODELS.get(label_or_repo, label_or_repo)


def _nl_messages(tags: str, characters: str, rating: str, guidance: str, language: str, prompt_template: str):
    if not tags.strip() and not characters.strip():
        raise RuntimeError("请先生成 tags，或手动填入 tags。")
    template = NL_PROMPT_TEMPLATES.get(prompt_template, "standard")
    if template != "standard":
        system_prompt = (
            "You are a precise image-prompt specialist. Follow the user's template exactly. "
            "Do not output analysis, markdown, labels, or reasoning. Remove the source subject completely."
        )
        user_prompt = (
            f"{template}\n\n"
            "Tag hints extracted from the image:\n"
            f"Rating tag: {rating or 'unknown'}\n"
            f"Character tags: {characters or 'none'}\n"
            f"General tags: {tags}\n"
        )
        if guidance.strip():
            user_prompt += f"\n额外要求（必须遵守，优先级最高）：{guidance.strip()}\n"
        return [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ]

    system_prompt = (
        "You convert Danbooru-style image tags into one natural-language image prompt. "
        "Return only the prompt. Do not add markdown, labels, commentary, reasoning, or analysis. "
        "Preserve visible subjects, composition, lighting, materials, style, and mood implied by the tags. "
        "Do not invent identities, artists, copyrighted titles, or details not supported by the tags. "
        "Any additional user direction is mandatory and overrides the default style."
    )
    user_prompt = (
        f"Output language: {language}\n"
        f"Rating tag: {rating or 'unknown'}\n"
        f"Character tags: {characters or 'none'}\n"
        f"General tags: {tags}\n"
    )
    if guidance.strip():
        user_prompt += f"Mandatory additional direction: {guidance.strip()}\n"
    user_prompt += "\nReturn one fluent natural-language prompt."
    return [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]


def build_nl_from_endpoint(
    tags: str,
    characters: str,
    rating: str,
    guidance: str,
    image: Image.Image | None,
    prompt_template: str,
    endpoint: str,
    model: str,
    language: str,
    max_tokens: int,
    temperature: float,
    top_p: float,
    timeout: int,
    enable_thinking: bool,
) -> str:
    endpoint = endpoint.strip().rstrip("/")
    if not endpoint:
        raise RuntimeError("请填写 llama.cpp/OpenAI-compatible endpoint。")
    if endpoint.endswith("/chat/completions"):
        url = endpoint
    elif endpoint.endswith("/v1"):
        url = endpoint + "/chat/completions"
    else:
        url = endpoint + "/v1/chat/completions"

    payload: dict[str, Any] = {
        "messages": _prompt_messages(tags, characters, rating, guidance, image, language, prompt_template),
        "temperature": float(temperature),
        "top_p": float(top_p),
        "max_tokens": int(max_tokens),
        "stream": False,
        "chat_template_kwargs": {"enable_thinking": bool(enable_thinking)},
    }
    if model.strip():
        payload["model"] = model.strip()

    response = requests.post(url, json=payload, timeout=int(timeout))
    response.raise_for_status()
    return _postprocess_prompt(_extract_message_text(response.json()["choices"][0]["message"]), prompt_template)


def prompt_assistant_chat(payload: dict[str, Any]) -> dict[str, Any]:
    backend = str(payload.get("backend") or "deepseek").strip()
    if backend == "local-lmcpp":
        endpoint = str(payload.get("local_endpoint") or DEFAULT_LOCAL_ASSISTANT_ENDPOINT).strip().rstrip("/")
        model = str(payload.get("local_model") or DEFAULT_LOCAL_ASSISTANT_MODEL).strip()
        api_key = ""
    else:
        endpoint = str(payload.get("endpoint") or DEFAULT_ASSISTANT_ENDPOINT).strip().rstrip("/")
        model = str(payload.get("model") or DEFAULT_ASSISTANT_MODEL).strip()
        api_key = str(payload.get("api_key") or "").strip()
    messages = payload.get("messages") or []
    if not isinstance(messages, list):
        raise RuntimeError("messages must be a list")
    if not endpoint:
        raise RuntimeError("OpenAI-compatible endpoint is empty")
    if not model:
        raise RuntimeError("model is empty")
    url = _assistant_chat_url(endpoint)

    request_messages = [{"role": "system", "content": PROMPT_ASSISTANT_SYSTEM}]
    for item in messages[-20:]:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "").strip()
        content = str(item.get("content") or "").strip()
        if role in {"user", "assistant"} and content:
            request_messages.append({"role": role, "content": content})
    if len(request_messages) == 1:
        raise RuntimeError("message is empty")

    body = {
        "model": model,
        "messages": request_messages,
        "temperature": float(payload.get("temperature") or 0.35),
        "top_p": float(payload.get("top_p") or 0.9),
        "max_tokens": int(payload.get("max_tokens") or 8192),
        "stream": False,
    }
    if backend != "local-lmcpp":
        body["tools"] = ASSISTANT_TOOLS
        body["tool_choice"] = "auto"
    if urllib.parse.urlparse(endpoint).netloc.lower() == "api.deepseek.com":
        body["thinking"] = {"type": "enabled"}
        body["reasoning_effort"] = str(payload.get("reasoning_effort") or "high")
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    response = requests.post(url, json=body, headers=headers, timeout=int(payload.get("timeout") or 120))
    if response.status_code >= 400:
        detail = response.text.strip()
        raise RuntimeError(f"Assistant API {response.status_code} error from {url}: {detail or response.reason}")
    data = response.json()
    message = data["choices"][0]["message"]
    tool_calls = _extract_tool_calls(message)
    if tool_calls:
        text = _clean_response_text(message.get("content", ""))
    else:
        text = _extract_message_text(message)
    return {"text": text, "tool_calls": tool_calls, "model": model, "endpoint": endpoint}


def _extract_tool_calls(message: dict[str, Any]) -> list[dict[str, Any]]:
    calls = message.get("tool_calls") or []
    result = []
    for call in calls:
        if not isinstance(call, dict):
            continue
        function = call.get("function") or {}
        name = str(function.get("name") or call.get("name") or "").strip()
        raw_args = function.get("arguments") if isinstance(function, dict) else call.get("arguments")
        if not name:
            continue
        arguments: Any = raw_args or {}
        if isinstance(raw_args, str):
            try:
                arguments = json.loads(raw_args) if raw_args.strip() else {}
            except json.JSONDecodeError:
                arguments = {"diff": raw_args}
        if not isinstance(arguments, dict):
            arguments = {}
        result.append({"tool": name, "arguments": arguments})
    return result


def _assistant_chat_url(endpoint: str) -> str:
    endpoint = endpoint.strip().rstrip("/")
    if endpoint.endswith("/chat/completions"):
        return endpoint
    parsed = urllib.parse.urlparse(endpoint)
    if parsed.netloc.lower() == "api.deepseek.com":
        base_path = parsed.path.rstrip("/")
        path = f"{base_path}/chat/completions"
        return urllib.parse.urlunparse((parsed.scheme or "https", parsed.netloc, path, "", "", ""))
    if endpoint.endswith("/v1"):
        return endpoint + "/chat/completions"
    return endpoint + "/v1/chat/completions"


def analyze_reference_image(payload: dict[str, Any]) -> dict[str, Any]:
    image_data = str(payload.get("image") or payload.get("data_url") or "").strip()
    if not image_data:
        raise RuntimeError("missing reference image")
    image = _image_from_data_url(image_data)
    messages = _reference_image_messages(image)
    timeout = int(payload.get("timeout") or 120)
    max_tokens = int(payload.get("max_tokens") or 700)
    temperature = float(payload.get("temperature") or 0.15)
    top_p = float(payload.get("top_p") or 0.9)

    local_endpoint = str(payload.get("local_endpoint") or "").strip().rstrip("/")
    if local_endpoint and _local_endpoint_ready(local_endpoint):
        try:
            response = _post_local_chat(
                local_endpoint,
                messages,
                max_tokens,
                temperature,
                top_p,
                timeout,
                False,
                str(payload.get("local_model") or DEFAULT_LOCAL_ASSISTANT_MODEL).strip() or DEFAULT_LOCAL_ASSISTANT_MODEL,
            )
            text = _extract_message_text(response["choices"][0]["message"])
            return {
                "text": text,
                "model": str(payload.get("local_model") or DEFAULT_LOCAL_ASSISTANT_MODEL).strip() or DEFAULT_LOCAL_ASSISTANT_MODEL,
                "endpoint": local_endpoint,
                "source": "existing-local-endpoint",
            }
        except Exception:
            pass

    llama_server_path = resolve_llama_server(str(payload.get("llama_server_path") or ""))
    model_path, mmproj_path = ensure_local_gguf_pair(
        str(payload.get("model_path") or ""),
        str(payload.get("mmproj_path") or ""),
        True,
    )

    port = _free_port()
    proc: subprocess.Popen | None = None
    try:
        args = [
            llama_server_path,
            "-m",
            model_path,
            "-mm",
            mmproj_path,
            "-ngl",
            "all",
            "-c",
            str(int(payload.get("n_ctx") or 8192)),
            "-fa",
            "on",
            "-np",
            "1",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--alias",
            "local-qwen-vision-once",
            "--jinja",
        ]
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=creationflags)
        endpoint = f"http://127.0.0.1:{port}/v1"
        _wait_server(endpoint, timeout)
        response = _post_local_chat(
            endpoint,
            messages,
            max_tokens,
            temperature,
            top_p,
            timeout,
            False,
        )
        text = _extract_message_text(response["choices"][0]["message"])
        return {
            "text": text,
            "model": Path(model_path).name,
            "mmproj": Path(mmproj_path).name,
            "source": "one-shot-local-gguf",
        }
    finally:
        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        gc.collect()


def _image_from_data_url(data_url: str) -> Image.Image:
    raw = data_url.strip()
    if raw.startswith("data:"):
        if ";base64," not in raw:
            raise RuntimeError("reference image must be base64 data URL")
        raw = raw.split(",", 1)[1]
    try:
        binary = base64.b64decode(raw, validate=True)
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError("invalid reference image data") from exc
    if len(binary) > 24 * 1024 * 1024:
        raise RuntimeError("reference image is too large; use an image under 24 MB")
    try:
        return Image.open(io.BytesIO(binary)).convert("RGB")
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError("could not decode reference image") from exc


def _local_endpoint_ready(endpoint: str) -> bool:
    try:
        with urllib.request.urlopen(endpoint.rstrip("/") + "/models", timeout=2) as resp:
            return resp.status < 500
    except Exception:
        return False


def _reference_image_messages(image: Image.Image) -> list[dict[str, Any]]:
    return [
        {"role": "system", "content": REFERENCE_IMAGE_ANALYSIS_SYSTEM},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": REFERENCE_IMAGE_STYLE_PROMPT},
                {"type": "image_url", "image_url": {"url": _image_data_url(image, max_side=1024)}},
            ],
        },
    ]


def ensure_local_gguf_pair(model_path: str, mmproj_path: str, need_mmproj: bool) -> tuple[str, str]:
    model = model_path.strip().strip('"')
    mmproj = mmproj_path.strip().strip('"')
    model_exists = bool(model) and Path(model).exists()
    mmproj_exists = bool(mmproj) and Path(mmproj).exists()
    if model_exists and (mmproj_exists or not need_mmproj):
        return model, mmproj

    target_dir = _forge_root() / "models" / "LLM" / DEFAULT_GGUF_DIR
    target_dir.mkdir(parents=True, exist_ok=True)
    if not model_exists:
        model = str(_download_hf_file(DEFAULT_GGUF_REPO, DEFAULT_GGUF_MODEL, target_dir))
    if need_mmproj and not mmproj_exists:
        mmproj = str(_download_hf_file(DEFAULT_GGUF_REPO, DEFAULT_GGUF_MMPROJ, target_dir))
    return model, mmproj


def find_default_llama_server() -> str:
    env_path = os.environ.get("LLAMA_SERVER_EXE", "").strip().strip('"')
    if env_path and Path(env_path).exists():
        return env_path
    bundled = _llama_cpp_bin_dir() / "llama-server.exe"
    if bundled.exists():
        return str(bundled)
    for candidate in DEFAULT_LLAMA_SERVER_CANDIDATES:
        path = Path(candidate)
        if path.exists():
            return str(path)
    found = shutil.which("llama-server.exe") or shutil.which("llama-server")
    return found or ""


def resolve_llama_server(path: str) -> str:
    cleaned = path.strip().strip('"')
    if cleaned and Path(cleaned).exists():
        return cleaned
    found = find_default_llama_server()
    if found:
        return found
    return str(download_llama_server())


def _forge_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _extension_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _llama_cpp_bin_dir() -> Path:
    return _extension_root() / "bin" / "llama.cpp"


def download_llama_server() -> Path:
    if os.name != "nt":
        raise RuntimeError("自动下载 llama.cpp 后端目前只支持 Windows；请手动填写 llama-server 路径。")
    target_dir = _llama_cpp_bin_dir()
    target = target_dir / "llama-server.exe"
    if target.exists():
        return target
    target_dir.mkdir(parents=True, exist_ok=True)
    asset = _select_llama_cpp_windows_asset()
    zip_path = target_dir / asset["name"]
    if not zip_path.exists() or zip_path.stat().st_size == 0:
        _download_url(asset["browser_download_url"], zip_path)
    _safe_extract_zip(zip_path, target_dir)
    found = next(target_dir.rglob("llama-server.exe"), None)
    if found is None:
        raise RuntimeError(f"llama.cpp release 解压后没有找到 llama-server.exe: {zip_path}")
    if found != target:
        if target.exists():
            target.unlink()
        shutil.copy2(found, target)
    return target


def _select_llama_cpp_windows_asset() -> dict[str, str]:
    req = urllib.request.Request(LLAMA_CPP_RELEASE_API, headers={"User-Agent": "forge-qwen3vl-prompt-tools"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        release = json.loads(resp.read().decode("utf-8"))
    assets = release.get("assets") or []
    candidates: list[tuple[int, dict[str, str]]] = []
    for asset in assets:
        name = str(asset.get("name") or "")
        lowered = name.lower()
        if not lowered.endswith(".zip"):
            continue
        if "win" not in lowered or "x64" not in lowered or "bin" not in lowered:
            continue
        score = 0
        if "cuda" in lowered:
            score += 100
        if "cu12" in lowered or "cu13" in lowered:
            score += 20
        if "vulkan" in lowered:
            score += 10
        if "cpu" in lowered:
            score += 1
        if "server" in lowered:
            score += 1
        candidates.append((score, asset))
    if not candidates:
        raise RuntimeError("没有在 llama.cpp 最新 release 中找到 Windows x64 zip 后端。")
    candidates.sort(key=lambda item: item[0], reverse=True)
    selected = candidates[0][1]
    if not selected.get("browser_download_url"):
        raise RuntimeError(f"llama.cpp release asset 缺少下载 URL: {selected.get('name')}")
    return selected


def _download_url(url: str, target: Path) -> None:
    tmp = target.with_suffix(target.suffix + ".tmp")
    if tmp.exists():
        tmp.unlink()
    req = urllib.request.Request(url, headers={"User-Agent": "forge-qwen3vl-prompt-tools"})
    with urllib.request.urlopen(req, timeout=120) as resp, tmp.open("wb") as f:
        shutil.copyfileobj(resp, f)
    tmp.replace(target)


def _safe_extract_zip(zip_path: Path, target_dir: Path) -> None:
    root = target_dir.resolve()
    with zipfile.ZipFile(zip_path) as zf:
        for member in zf.infolist():
            destination = (target_dir / member.filename).resolve()
            if root not in destination.parents and destination != root:
                raise RuntimeError(f"拒绝解压可疑路径: {member.filename}")
        zf.extractall(target_dir)


def _download_hf_file(repo: str, filename: str, target_dir: Path) -> Path:
    target = target_dir / filename
    if target.exists() and target.stat().st_size > 0:
        return target
    cached = Path(huggingface_hub.hf_hub_download(repo, filename)).resolve()
    tmp = target.with_suffix(target.suffix + ".tmp")
    if tmp.exists():
        tmp.unlink()
    try:
        os.link(cached, tmp)
    except OSError:
        shutil.copy2(cached, tmp)
    tmp.replace(target)
    return target


def build_nl_from_local_gguf(
    tags: str,
    characters: str,
    rating: str,
    guidance: str,
    image: Image.Image | None,
    prompt_template: str,
    model_path: str,
    mmproj_path: str,
    llama_server_path: str,
    language: str,
    max_tokens: int,
    temperature: float,
    top_p: float,
    n_ctx: int,
    n_gpu_layers: int,
    chat_format: str,
    timeout: int,
    enable_thinking: bool,
) -> str:
    model_path, mmproj_path = ensure_local_gguf_pair(model_path, mmproj_path, image is not None)

    llama_server_path = resolve_llama_server(llama_server_path)

    port = _free_port()
    proc: subprocess.Popen | None = None
    try:
        args = [
            llama_server_path,
            "-m",
            model_path,
            "-ngl",
            "all" if int(n_gpu_layers) < 0 else str(int(n_gpu_layers)),
            "-c",
            str(int(n_ctx)),
            "-fa",
            "on",
            "-np",
            "1",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--alias",
            "local-gguf-once",
            "--jinja",
        ]
        if mmproj_path:
            args[3:3] = ["-mm", mmproj_path]
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=creationflags)
        endpoint = f"http://127.0.0.1:{port}/v1"
        _wait_server(endpoint, int(timeout))
        response = _post_local_chat(
            endpoint,
            _prompt_messages(tags, characters, rating, guidance, image, language, prompt_template),
            max_tokens,
            temperature,
            top_p,
            int(timeout),
            bool(enable_thinking),
        )
        return _postprocess_prompt(_extract_message_text(response["choices"][0]["message"]), prompt_template)
    finally:
        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        gc.collect()


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _wait_server(endpoint: str, timeout: int) -> None:
    deadline = time.time() + max(10, timeout)
    last_error: Exception | None = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(endpoint.rstrip("/") + "/models", timeout=2) as resp:
                if resp.status < 500:
                    return
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            time.sleep(0.5)
    raise RuntimeError(f"llama-server 未就绪: {last_error}")


def _post_local_chat(
    endpoint: str,
    messages: list[dict[str, Any]],
    max_tokens: int,
    temperature: float,
    top_p: float,
    timeout: int,
    enable_thinking: bool,
    model: str = "local-gguf-once",
) -> dict[str, Any]:
    payload = {
        "model": model,
        "messages": messages,
        "temperature": float(temperature),
        "top_p": float(top_p),
        "max_tokens": int(max_tokens),
        "stream": False,
        "chat_template_kwargs": {"enable_thinking": bool(enable_thinking)},
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        endpoint.rstrip("/") + "/chat/completions",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=int(timeout)) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"llama-server HTTP {exc.code}: {body}") from exc


def _clean_response_text(text: str) -> str:
    text = re.sub(r"<think>.*?</think>", "", str(text), flags=re.DOTALL | re.IGNORECASE)
    text = text.replace("<|im_end|>", "").replace("<|endoftext|>", "")
    return text.strip().strip('"')


def _extract_message_text(message: dict[str, Any]) -> str:
    text = _clean_response_text(message.get("content", ""))
    if text:
        return text
    reasoning = _clean_response_text(message.get("reasoning_content") or message.get("reasoning") or "")
    if reasoning:
        raise RuntimeError(
            "模型只返回了 reasoning_content，没有最终答案。请关闭 '启用 thinking'，或显著提高 Max tokens 后重试。"
        )
    raise RuntimeError("模型返回了空结果。请降低模板复杂度、提高 Max tokens，或换 9B/4B 模型重试。")


def _postprocess_prompt(text: str, prompt_template: str) -> str:
    if NL_PROMPT_TEMPLATES.get(prompt_template, "standard") == "standard":
        return text
    placeholder = "[replace with your desired subject here]"
    cleaned = text
    cleaned = re.sub(r"\[(?:replace|insert).*?subject.*?\]", placeholder, cleaned, flags=re.IGNORECASE)
    subject_patterns = [
        r"\b(?:anthropomorphic|furry)\s+(?:wolf|fox|dog|cat|tiger|dragon|animal)\s+(?:boy|girl|man|woman|character)\b",
        r"\b(?:wolf|fox|dog|cat|tiger|dragon)\s+(?:boy|girl|man|woman|character)\b",
        r"\b(?:anime|manga)\s+(?:boy|girl|man|woman|character)\b",
        r"\b(?:boy|girl|man|woman|character|person|figure)\s+(?:with|wearing|holding)\b[^,;.]*",
        r"\bwearing\s+(?:a\s+)?(?:white\s+)?(?:collared\s+)?shirt\b[^,;.]*",
        r"\b(?:necktie|tie|shirt|collar|sweater|jacket)\b",
        r"\b(?:wolf|fox|dog|cat|tiger|dragon|animal ears|blue eyes|fur|snout|tail|sweat drop)\b",
    ]
    for pattern in subject_patterns:
        cleaned = re.sub(pattern, placeholder, cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(rf"(?:{re.escape(placeholder)}\s*,\s*)+", f"{placeholder}, ", cleaned)
    cleaned = re.sub(rf"(?:{re.escape(placeholder)}\s+)+", f"{placeholder} ", cleaned)
    if placeholder not in cleaned:
        cleaned = f"{placeholder}, {cleaned}"
    return " ".join(cleaned.split()).strip()


def _prompt_messages(
    tags: str,
    characters: str,
    rating: str,
    guidance: str,
    image: Image.Image | None,
    language: str,
    prompt_template: str,
) -> list[dict[str, Any]]:
    if image is None:
        return _nl_messages(tags, characters, rating, guidance, language, prompt_template)

    template = NL_PROMPT_TEMPLATES.get(prompt_template, "standard")
    if template != "standard":
        system_prompt = (
            "You are a top-tier AI image-prompt specialist. Follow the user's template exactly. "
            "Use the image as the primary source for style only. Remove the source subject completely. "
            "Do not output analysis, markdown, labels, or reasoning."
        )
        user_text = (
            f"{template}\n\n"
            "Style-only tag hints. Use these only to infer aesthetics; do not copy subject nouns into the output:\n"
            f"Rating tag hint: {rating or 'unknown'}\n"
            f"Character tag hints: {characters or 'none'}\n"
            f"General tag hints: {tags or 'none'}\n"
        )
        if guidance.strip():
            user_text += f"\n额外要求（必须遵守，优先级最高）：{guidance.strip()}\n"
        return [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": user_text},
                    {"type": "image_url", "image_url": {"url": _image_data_url(image)}},
                ],
            },
        ]

    system_prompt = (
        "You are a visual prompt editor. Return only one faithful natural-language image prompt, "
        "with no labels, markdown, quotation marks, reasoning, or analysis. "
        "Any additional user direction is mandatory and overrides the default style."
    )
    user_text = (
        "Describe the provided image as a production-ready text-to-image prompt. "
        "Trust the image over the tag hints. Cover subject, pose, composition, lighting, palette, style, and visible text. "
        "Do not invent identities or facts that are not visible.\n\n"
        f"Output language: {language}\n"
        f"Rating tag hint: {rating or 'unknown'}\n"
        f"Character tag hints: {characters or 'none'}\n"
        f"General tag hints: {tags or 'none'}\n"
    )
    if guidance.strip():
        user_text += f"Mandatory additional direction: {guidance.strip()}\n"
    return [
        {"role": "system", "content": system_prompt},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": user_text},
                {"type": "image_url", "image_url": {"url": _image_data_url(image)}},
            ],
        },
    ]


def _image_data_url(image: Image.Image, max_side: int = 768) -> str:
    prepared = image.convert("RGB")
    prepared.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    buffer = io.BytesIO()
    prepared.save(buffer, format="JPEG", quality=95, optimize=True)
    data = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/jpeg;base64,{data}"


def combine_prompt(tags: str, nl: str, mode: str) -> str:
    tags = tags.strip()
    nl = nl.strip()
    if mode == "Tags only":
        return tags
    if mode == "NL only":
        return nl
    if tags and nl:
        return f"{tags}\n\n{_strip_subject_placeholders(nl)}"
    return tags or nl


def _strip_subject_placeholders(text: str) -> str:
    text = re.sub(r"\[[^\]]*(?:replace|insert|subject|character|主体|角色)[^\]]*\]", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s+([,.;:])", r"\1", text)
    text = re.sub(r"^[\s,.;:]+", "", text)
    return " ".join(text.split()).strip()
