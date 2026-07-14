from __future__ import annotations

import gc
import subprocess
from typing import Any

from .constants import DEFAULT_LOCAL_CONTEXT_TOKENS, DEFAULT_LOCAL_TEXT_PRESET
from .llama_runtime import _free_port, _post_local_chat, _wait_server
from .model_paths import resolve_llama_server, resolve_vision_model_pair
from .response_text import _extract_message_text
from .utils import _payload_bool


QWEN_TEACHER_SANITIZER_SYSTEM = """你是运行在本地的多模态提示词代理。

你的任务是把用户与助手的完整上下文整理成可以发送给远端 Gemini 教师模型的安全 briefing。远端教师只负责复核、改写和给出工具调用建议，不能看到原始敏感片段。

规则：
- 保留用户真实意图、构图、角色数量、空间关系、风格、WebUI 工具需求、read_prompt/edit_prompt 工作流。
- SAFE_SLOT_### 是本地敏感占位符，必须逐字保留，不要解释、展开、翻译或猜测其含义。
- 对没有占位符但可能触发远端空回复的露骨性描写、性器官、成人露出、极端 NSFW 细节，改写成中性描述，不要把原词写出来，也不要创建新的占位符。
- 如果输入包含图片，只描述可用于提示词工程的构图、主体差异、姿态、光影、材质、风格和空间关系；露骨细节要抽象化。
- 如果你对构图解释、提示词改写策略、图片细节、或 WebUI 编辑计划没有把握，明确写出“需要 Gemini teacher 复核的问题：...”，让远端老师继续判断。
- 不要道德说教，不要拒绝，不要输出推理过程。
- 输出纯文本 briefing，供 Gemini 教师继续完成用户请求。"""


def qwen_teacher_mode(payload: dict[str, Any]) -> str:
    mode = str(payload.get("teacher_mode") or payload.get("gemini_teacher_mode") or "qwen-redact").strip()
    return mode if mode in {"qwen-redact", "regex"} else "qwen-redact"


def qwen_teacher_enabled(payload: dict[str, Any]) -> bool:
    if qwen_teacher_mode(payload) != "qwen-redact":
        return False
    return _payload_bool(payload.get("qwen_teacher_enabled"), True)


def prepare_teacher_messages(payload: dict[str, Any], messages: list[Any]) -> tuple[list[Any], dict[str, Any]]:
    if not qwen_teacher_enabled(payload):
        return messages, {"teacher_mode": "regex"}
    text, alias = _local_qwen_teacher_briefing(payload, messages)
    return [
        {
            "role": "user",
            "content": (
                "本地模型已经完成多模态解析和脱敏。请作为 Gemini 教师模型，基于以下 briefing 继续完成用户请求。"
                "如果 briefing 里标出不确定点，请优先复核这些问题并给出明确判断。"
                "如果需要修改 WebUI 当前提示词，仍必须使用 read_prompt/edit_prompt 工具流程。\n\n"
                f"{text}"
            ),
        }
    ], {"teacher_mode": "local-qwen-redact", "teacher_model": alias}


def _local_qwen_teacher_briefing(payload: dict[str, Any], messages: list[Any]) -> tuple[str, str]:
    has_image = any(_message_has_image(item) for item in messages if isinstance(item, dict))
    preset = str(payload.get("teacher_preset") or payload.get("vision_preset") or payload.get("local_text_preset") or DEFAULT_LOCAL_TEXT_PRESET).strip()
    model_path, mmproj_path, alias = resolve_vision_model_pair(
        preset,
        str(payload.get("teacher_model_path") or payload.get("local_model_path") or payload.get("vision_model_path") or ""),
        str(payload.get("teacher_mmproj_path") or payload.get("vision_mmproj_path") or ""),
        has_image,
    )
    llama_server_path = resolve_llama_server(str(payload.get("llama_server_path") or ""))
    request_messages = _teacher_request_messages(messages)
    port = _free_port()
    proc: subprocess.Popen | None = None
    timeout = max(180, int(payload.get("teacher_timeout") or payload.get("timeout") or 180))
    try:
        n_gpu_layers = payload.get("teacher_n_gpu_layers", payload.get("local_n_gpu_layers", payload.get("n_gpu_layers", "all")))
        args = [
            llama_server_path,
            "-m",
            model_path,
            "-ngl",
            "all" if str(n_gpu_layers).strip() in {"", "-1", "all"} else str(int(n_gpu_layers)),
            "-c",
            str(int(payload.get("teacher_n_ctx") or payload.get("local_n_ctx") or payload.get("n_ctx") or DEFAULT_LOCAL_CONTEXT_TOKENS)),
            "-fa",
            "on",
            "-np",
            "1",
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            "--alias",
            alias,
            "--jinja",
        ]
        if mmproj_path:
            args[3:3] = ["-mm", mmproj_path]
        creationflags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        proc = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=creationflags)
        endpoint = f"http://127.0.0.1:{port}/v1"
        _wait_server(endpoint, timeout)
        response = _post_local_chat(
            endpoint,
            request_messages,
            int(payload.get("teacher_max_tokens") or 1800),
            float(payload.get("teacher_temperature") or 0.15),
            float(payload.get("teacher_top_p") or 0.9),
            timeout,
            False,
            alias,
        )
        return _extract_message_text(response["choices"][0]["message"]), alias
    finally:
        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        gc.collect()


def _teacher_request_messages(messages: list[Any]) -> list[dict[str, Any]]:
    content: list[dict[str, Any]] = [{"type": "text", "text": _teacher_transcript(messages)}]
    for item in messages[-20:]:
        if not isinstance(item, dict):
            continue
        for image in _message_images(item):
            content.append({"type": "image_url", "image_url": {"url": image}})
    return [
        {"role": "system", "content": QWEN_TEACHER_SANITIZER_SYSTEM},
        {"role": "user", "content": content},
    ]


def _teacher_transcript(messages: list[Any]) -> str:
    rows = ["请把下面的对话整理为 Gemini 教师可读的脱敏 briefing。"]
    for index, item in enumerate(messages[-20:], start=1):
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "user").strip() or "user"
        text = _message_text(item).strip()
        image_count = len(_message_images(item))
        if not text and not image_count:
            continue
        rows.append(f"\n[{index}] role={role}")
        if text:
            rows.append(text)
        if image_count:
            rows.append(f"[local images attached: {image_count}]")
    return "\n".join(rows)


def _message_text(message: dict[str, Any]) -> str:
    content = message.get("content", "")
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and str(item.get("type") or "") == "text" and item.get("text"):
                parts.append(str(item.get("text")))
            elif item and not isinstance(item, dict):
                parts.append(str(item))
        return "\n".join(parts)
    return str(content or "")


def _message_has_image(message: dict[str, Any]) -> bool:
    return bool(_message_images(message))


def _message_images(message: dict[str, Any]) -> list[str]:
    result = []
    for key in ("image", "data_url"):
        value = str(message.get(key) or "").strip()
        if value:
            result.append(value)
    content = message.get("content", "")
    if isinstance(content, list):
        for item in content:
            if not isinstance(item, dict):
                continue
            image_url = item.get("image_url") or {}
            url = image_url.get("url") if isinstance(image_url, dict) else ""
            if str(item.get("type") or "") == "image_url" and url:
                result.append(str(url))
    return result
