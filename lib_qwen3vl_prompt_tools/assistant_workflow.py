from __future__ import annotations

import copy
import json
import re
from dataclasses import dataclass, field
from typing import Any, Callable

from .assistant import prompt_assistant_chat
from .constants import (
    DEFAULT_ASSISTANT_ENDPOINT,
    DEFAULT_ASSISTANT_MODEL,
    DEFAULT_LOCAL_CONTEXT_TOKENS,
    DEFAULT_LOCAL_TEXT_PRESET,
)

ToolHandler = Callable[[dict[str, Any]], dict[str, Any]]
ChatFunction = Callable[[dict[str, Any]], dict[str, Any]]

ASSISTANT_TOOL_NAMES = {
    "ask_teacher",
    "read_prompt",
    "get_current_prompt",
    "edit_prompt",
    "patch_current_prompt",
    "multi_patch_current_prompt",
    "set_current_prompt",
    "get_style_template",
    "set_style_template",
}


def prompt_hash(text: str) -> str:
    value = str(text or "")
    hash_value = 2166136261
    raw = value.encode("utf-16-le")
    code_units = [int.from_bytes(raw[index : index + 2], "little") for index in range(0, len(raw), 2)]
    for char_code in code_units:
        hash_value ^= char_code
        hash_value = (hash_value * 16777619) & 0xFFFFFFFF
    return f"fnv1a:{hash_value:08x}:{len(code_units)}"


def build_assistant_payload(base_payload: dict[str, Any] | None, messages: list[Any]) -> dict[str, Any]:
    payload = dict(base_payload or {})
    backend = str(payload.get("backend") or "moyuu").strip() or "moyuu"
    payload["backend"] = backend
    payload["messages"] = copy.deepcopy(messages)
    payload["endpoint"] = str(payload.get("endpoint") or DEFAULT_ASSISTANT_ENDPOINT).strip()
    payload["model"] = str(payload.get("model") or DEFAULT_ASSISTANT_MODEL).strip()
    payload["temperature"] = float(payload.get("temperature") or 0.35)
    payload["top_p"] = float(payload.get("top_p") or 0.9)
    payload["max_tokens"] = int(payload.get("max_tokens") or 8192)
    payload["timeout"] = int(payload.get("timeout") or 120)
    return payload


def prompt_edit_messages(user_request: str) -> list[dict[str, str]]:
    request = str(user_request or "").strip()
    if not request:
        raise RuntimeError("user_request is required")
    return [{"role": "user", "content": request}]


def build_prompt_edit_eval_payloads(
    base_payload: dict[str, Any],
    messages: list[Any],
    local_models: list[dict[str, str]] | None = None,
    remote_models: list[dict[str, str]] | None = None,
    include_deepseek: bool = True,
) -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []
    remote = build_assistant_payload(base_payload, messages)
    remote["case_name"] = str(remote.get("case_name") or f"{remote['backend']}:{remote['model']}")
    remote["case_kind"] = "base"
    cases.append(remote)

    for index, model in enumerate(local_models or [], start=1):
        payload = build_assistant_payload(base_payload, messages)
        payload.update(
            {
                "case_name": model.get("case_name") or model.get("name") or f"local-{index}",
                "case_kind": "local",
                "backend": "local-qwen-once",
                "vision_preset": model.get("vision_preset") or DEFAULT_LOCAL_TEXT_PRESET,
                "local_text_preset": model.get("local_text_preset") or model.get("vision_preset") or DEFAULT_LOCAL_TEXT_PRESET,
                "local_model_path": model.get("local_model_path") or model.get("model_path") or "",
                "llama_server_path": model.get("llama_server_path") or str(base_payload.get("llama_server_path") or ""),
                "local_n_ctx": int(model.get("local_n_ctx") or base_payload.get("local_n_ctx") or base_payload.get("n_ctx") or DEFAULT_LOCAL_CONTEXT_TOKENS),
            }
        )
        cases.append(payload)

    for index, model in enumerate(remote_models or [], start=1):
        model_name = str(model.get("model") or model.get("name") or "").strip()
        if not model_name:
            continue
        backend = str(model.get("backend") or ("moyuu" if "gemini" in model_name.lower() else "openai")).strip()
        payload = build_assistant_payload(base_payload, messages)
        payload.update(
            {
                "case_name": model.get("case_name") or f"{backend}:{model_name}",
                "case_kind": "remote",
                "backend": backend,
                "endpoint": model.get("endpoint") or base_payload.get("endpoint") or DEFAULT_ASSISTANT_ENDPOINT,
                "model": model_name,
            }
        )
        if model.get("api_key"):
            payload["api_key"] = model["api_key"]
        cases.append(payload)

    if include_deepseek:
        payload = build_assistant_payload(base_payload, messages)
        payload.update(
            {
                "case_name": "deepseek:deepseek-v4-pro",
                "case_kind": "deepseek",
                "backend": "deepseek",
                "endpoint": "https://api.deepseek.com",
                "model": "deepseek-v4-pro",
                "teacher_mode": "regex",
            }
        )
        cases.append(payload)
    return cases


def normalize_assistant_tool_calls(result: dict[str, Any], text: str | None = None) -> list[dict[str, Any]]:
    calls = result.get("tool_calls") if isinstance(result, dict) else []
    parsed = calls if isinstance(calls, list) and calls else parse_assistant_tools(text if text is not None else result.get("text", ""))
    normalized = []
    seen: set[str] = set()
    for call in parsed:
        normalized_call = _normalize_tool_call(call)
        if not normalized_call:
            continue
        key = normalized_call["tool"] + "\0" + json.dumps(normalized_call["arguments"], ensure_ascii=False, sort_keys=True)
        if key in seen:
            continue
        seen.add(key)
        normalized.append(normalized_call)
    return normalized


def parse_assistant_tools(text: Any) -> list[dict[str, Any]]:
    value = str(text or "").strip()
    result: list[dict[str, Any]] = []
    seen: set[str] = set()

    def push(calls: list[dict[str, Any]]) -> None:
        for call in calls:
            normalized = _normalize_tool_call(call)
            if not normalized:
                continue
            key = normalized["tool"] + "\0" + json.dumps(normalized["arguments"], ensure_ascii=False, sort_keys=True)
            if key in seen:
                continue
            seen.add(key)
            result.append(normalized)

    push(_parse_tool_json(value))
    for match in re.finditer(r"```(?:json|tool|function)?\s*([\s\S]*?)```", str(text or ""), re.IGNORECASE):
        push(_parse_tool_json(match.group(1)))
    for match in re.finditer(r"<tool_call[^>]*>([\s\S]*?)</tool_call>", str(text or ""), re.IGNORECASE):
        push(_parse_tool_json(match.group(1)))
    for segment, start in _balanced_json_segments(str(text or ""), "{", "}"):
        push(_parse_tool_json(segment, _infer_tool_name_before(str(text or ""), start)))
    for segment, _start in _balanced_json_segments(str(text or ""), "[", "]"):
        push(_parse_tool_json(segment))
    return result


def assistant_user_requested_prompt_edit(text: str) -> bool:
    value = re.sub(r"\s+", " ", str(text or "")).strip().lower()
    if not value:
        return False
    edit_verb = re.compile(r"改成|修改|改写|重写|优化|精炼|扩写|替换|追加|加上|加入|删除|移除|写入|更新|套用|应用|编辑|修一下|insert|append|replace|rewrite|edit|update|apply|change|remove|delete|optimise|optimize|refine|expand", re.IGNORECASE)
    current_ref = re.compile(r"当前|现在|现有|原来|原有|这个|这段|它|其|提示词|prompt|txt2img|img2img|webui|ui|输入框|文本框", re.IGNORECASE)
    direct_edit = re.compile(r"(帮我|请|直接|把|将|给我).{0,40}(改成|修改|改写|重写|优化|精炼|扩写|替换|追加|加上|加入|删除|移除|写入|更新|套用|应用|编辑|修一下)", re.IGNORECASE)
    advice_only = re.compile(r"怎么改|如何改|哪里.*改|修改建议|改进建议|优化建议|建议.*(修改|优化|改写|调整)|should.*(change|edit|rewrite)|how.*(change|edit|rewrite)", re.IGNORECASE)
    return bool(edit_verb.search(value) and not advice_only.search(value) and (current_ref.search(value) or direct_edit.search(value)))


def assistant_tool_mutates_prompt(name: str) -> bool:
    return str(name or "") in {"edit_prompt", "patch_current_prompt", "multi_patch_current_prompt"}


def run_assistant_loop(
    base_payload: dict[str, Any],
    user_request: str,
    tool_handler: ToolHandler,
    chat_fn: ChatFunction = prompt_assistant_chat,
    messages: list[Any] | None = None,
    max_turns: int = 32,
    force_prompt_edit: bool | None = None,
    stop_after_edit: bool = False,
) -> dict[str, Any]:
    history = copy.deepcopy(messages) if messages is not None else prompt_edit_messages(user_request)
    must_edit = bool(force_prompt_edit) if force_prompt_edit is not None else assistant_user_requested_prompt_edit(user_request)
    prompt_edited = False
    correction_sent = False
    tool_results: list[dict[str, Any]] = []

    for _turn in range(max(1, max_turns)):
        result = chat_fn(build_assistant_payload(base_payload, history))
        text = str(result.get("text") or "")
        tool_calls = normalize_assistant_tool_calls(result, text)
        if not tool_calls:
            if must_edit and not prompt_edited and not correction_sent:
                correction_sent = True
                history.append({"role": "assistant", "content": text or "No tool call returned."})
                history.append(
                    {
                        "role": "user",
                        "content": (
                            "The user asked to modify the current WebUI prompt. You must call read_prompt if needed, "
                            "then edit_prompt with the latest base_hash. Do not give a final answer until edit_prompt returns ok:true."
                        ),
                    }
                )
                continue
            ok = not (must_edit and not prompt_edited)
            return {
                "ok": ok,
                "error": "" if ok else "assistant did not edit the prompt",
                "text": text,
                "messages": history,
                "tool_results": tool_results,
                "prompt_edited": prompt_edited,
                "edit_required": must_edit,
                "turns": len(tool_results) + 1,
                "last_result": result,
            }

        structured_calls = []
        for index, call in enumerate(tool_calls):
            structured_calls.append(
                {
                    "id": str(call.get("id") or f"call_{_turn}_{index}"),
                    "type": "function",
                    "function": {"name": call["tool"], "arguments": json.dumps(call.get("arguments") or {}, ensure_ascii=False)},
                }
            )
        history.append({"role": "assistant", "content": text or "", "tool_calls": structured_calls})
        for index, call in enumerate(tool_calls):
            tool_result = tool_handler(call)
            if assistant_tool_mutates_prompt(call["tool"]) and tool_result.get("ok"):
                prompt_edited = True
            item = {"tool": call["tool"], "arguments": call.get("arguments") or {}, "result": tool_result}
            tool_results.append(item)
            history.append(
                {
                    "role": "tool",
                    "tool_call_id": structured_calls[index]["id"],
                    "content": json.dumps(tool_result, ensure_ascii=False),
                }
            )
            if stop_after_edit and must_edit and assistant_tool_mutates_prompt(call["tool"]) and tool_result.get("ok"):
                return {
                    "ok": True,
                    "error": "",
                    "text": "",
                    "messages": history,
                    "tool_results": tool_results,
                    "prompt_edited": True,
                    "edit_required": must_edit,
                    "turns": len(tool_results),
                    "last_result": result,
                }

    return {"ok": False, "error": "assistant loop exceeded max_turns", "messages": history, "tool_results": tool_results, "prompt_edited": prompt_edited, "edit_required": must_edit}


@dataclass
class PromptToolHarness:
    prompt: str
    target: str = "active"
    read_hashes: dict[str, str] = field(default_factory=dict)

    def __call__(self, call: dict[str, Any]) -> dict[str, Any]:
        name = str(call.get("tool") or call.get("name") or "").strip()
        arguments = call.get("arguments") if isinstance(call.get("arguments"), dict) else {}
        if name in {"read_prompt", "get_current_prompt"}:
            return self.read_prompt(str(arguments.get("target") or self.target or "active"))
        if name in {"edit_prompt", "patch_current_prompt"}:
            return self.edit_prompt(arguments)
        return {"ok": False, "error": f"unsupported tool: {name}"}

    def read_prompt(self, target: str = "active") -> dict[str, Any]:
        concrete = target or self.target or "active"
        current_hash = prompt_hash(self.prompt)
        self.read_hashes[concrete] = current_hash
        return {"ok": True, "target": concrete, "prompt": self.prompt, "prompt_hash": current_hash, "hash": current_hash}

    def edit_prompt(self, arguments: dict[str, Any]) -> dict[str, Any]:
        target = str(arguments.get("target") or self.target or "active")
        base_hash = str(arguments.get("base_hash") or arguments.get("prompt_hash") or "")
        last_read = self.read_hashes.get(target)
        current_hash = prompt_hash(self.prompt)
        if not last_read:
            return {"ok": False, "target": target, "error": "must call read_prompt for this target before edit_prompt"}
        if not base_hash:
            return {"ok": False, "target": target, "error": "edit_prompt requires base_hash from read_prompt", "last_read_hash": last_read}
        if base_hash != last_read or base_hash != current_hash:
            return {"ok": False, "target": target, "error": "base_hash does not match current prompt", "current_hash": current_hash, "last_read_hash": last_read}

        try:
            next_prompt = _apply_prompt_edit(self.prompt, arguments)
        except RuntimeError as exc:
            return {"ok": False, "target": target, "error": str(exc), "prompt": self.prompt}
        self.prompt = next_prompt
        updated_hash = prompt_hash(next_prompt)
        self.read_hashes[target] = updated_hash
        return {"ok": True, "target": target, "prompt": next_prompt, "prompt_hash": updated_hash, "hash": updated_hash}


def _apply_prompt_edit(current: str, arguments: dict[str, Any]) -> str:
    if arguments.get("prompt") is not None:
        return _reject_patch_residue(str(arguments.get("prompt") or ""))
    patches = arguments.get("patches") or arguments.get("operations") or []
    if arguments.get("patch"):
        patches = [arguments["patch"]]
    diff = str(arguments.get("diff") or "")
    if diff:
        patches = list(patches) + _patches_from_search_replace(diff)
    if not patches:
        raise RuntimeError("edit_prompt requires diff, prompt, or patches")
    next_prompt = current
    for patch in patches:
        if not isinstance(patch, dict):
            continue
        next_prompt = _apply_patch(next_prompt, patch)
    return _reject_patch_residue(next_prompt)


def _patches_from_search_replace(diff: str) -> list[dict[str, str]]:
    pattern = re.compile(r"<<<<<<< SEARCH\s*\n([\s\S]*?)\n=======\s*\n([\s\S]*?)\n>>>>>>> REPLACE", re.MULTILINE)
    return [{"operation": "replace", "find": match.group(1), "replace": match.group(2)} for match in pattern.finditer(diff)]


def _apply_patch(current: str, patch: dict[str, Any]) -> str:
    operation = str(patch.get("operation") or "replace").strip()
    find = str(patch.get("find") or "")
    replace = str(patch.get("replace") if patch.get("replace") is not None else patch.get("text") or "")
    if operation == "append":
        return current + str(patch.get("separator") or "") + replace
    if operation == "prepend":
        return replace + str(patch.get("separator") or "") + current
    if operation == "delete":
        replace = ""
        operation = "replace"
    if operation in {"replace", "replace_all", "replace_n"}:
        if not find:
            raise RuntimeError("replace patch requires find")
        count = current.count(find)
        if count <= 0:
            raise RuntimeError("find text was not found")
        if operation == "replace" and count > 1 and not patch.get("allow_multiple"):
            raise RuntimeError("find text is not unique")
        limit = int(patch.get("count") or 1) if operation == "replace_n" else (-1 if operation == "replace_all" or patch.get("allow_multiple") else 1)
        return current.replace(find, replace, limit)
    if operation in {"insert_after", "insert_before"}:
        if not find:
            raise RuntimeError("insert patch requires find")
        count = current.count(find)
        if count <= 0:
            raise RuntimeError("find text was not found")
        if count > 1 and not patch.get("allow_multiple"):
            raise RuntimeError("find text is not unique")
        needle = find if operation == "insert_before" else find + replace
        value = replace + find if operation == "insert_before" else needle
        return current.replace(find, value, -1 if patch.get("allow_multiple") else 1)
    raise RuntimeError(f"unsupported patch operation: {operation}")


def _reject_patch_residue(prompt: str) -> str:
    residue = re.compile(r"(^|\n)(diff --git|@@|--- a/|\+\+\+ b/|<<<<<<<|=======|>>>>>>>|```diff)", re.IGNORECASE)
    if residue.search(prompt):
        raise RuntimeError("refusing to write prompt: final prompt contains diff or patch residue")
    return prompt


def _normalize_tool_call(call: Any) -> dict[str, Any] | None:
    if not isinstance(call, dict):
        return None
    function = call.get("function") if isinstance(call.get("function"), dict) else {}
    name = str(call.get("tool") or call.get("name") or function.get("name") or "").strip()
    if name not in ASSISTANT_TOOL_NAMES:
        return None
    raw_args = call.get("arguments", call.get("input", call.get("args", function.get("arguments", {}))))
    if isinstance(raw_args, str):
        try:
            raw_args = json.loads(raw_args) if raw_args.strip() else {}
        except json.JSONDecodeError:
            raw_args = {}
    normalized = {"tool": name, "arguments": raw_args if isinstance(raw_args, dict) else {}}
    if call.get("id"):
        normalized["id"] = str(call["id"])
    return normalized


def _parse_tool_json(raw: str, inferred_name: str = "") -> list[dict[str, Any]]:
    value = str(raw or "").strip()
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        parsed = _parse_loose_object(value)
    return _collect_tool_calls(parsed, inferred_name)


def _parse_loose_object(value: str) -> Any:
    raw = value.strip()
    if not raw.startswith("{") or not raw.endswith("}"):
        return None
    jsonish = re.sub(r"([{,]\s*)([A-Za-z_][\w-]*)\s*:", r'\1"\2":', raw)
    try:
        return json.loads(jsonish)
    except json.JSONDecodeError:
        return None


def _collect_tool_calls(parsed: Any, inferred_name: str = "") -> list[dict[str, Any]]:
    if isinstance(parsed, list):
        return [call for item in parsed for call in _collect_tool_calls(item, inferred_name)]
    if not isinstance(parsed, dict):
        return []
    if isinstance(parsed.get("tool_calls"), list):
        return [call for item in parsed["tool_calls"] for call in _collect_tool_calls(item, inferred_name)]
    if parsed.get("function_call"):
        return _collect_tool_calls(parsed["function_call"], inferred_name)
    if inferred_name and "tool" not in parsed and "name" not in parsed:
        parsed = {"tool": inferred_name, "arguments": parsed}
    normalized = _normalize_tool_call(parsed)
    return [normalized] if normalized else []


def _balanced_json_segments(text: str, open_char: str, close_char: str) -> list[tuple[str, int]]:
    segments: list[tuple[str, int]] = []
    start = -1
    depth = 0
    in_string = False
    escape = False
    for index, char in enumerate(text):
        if in_string:
            if escape:
                escape = False
            elif char == "\\":
                escape = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == open_char:
            if depth == 0:
                start = index
            depth += 1
        elif char == close_char and depth > 0:
            depth -= 1
            if depth == 0 and start >= 0:
                segments.append((text[start : index + 1], start))
                start = -1
    return segments


def _infer_tool_name_before(text: str, index: int) -> str:
    prefix = text[max(0, index - 180) : index]
    best = ""
    for name in ASSISTANT_TOOL_NAMES:
        if re.search(rf"(^|[^A-Za-z0-9_]){re.escape(name)}([^A-Za-z0-9_]|$)", prefix):
            best = name
    return best
