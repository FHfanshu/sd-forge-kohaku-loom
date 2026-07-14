from __future__ import annotations

import asyncio
import inspect
import json
import subprocess
from typing import Any, AsyncIterator, Callable

from kohakuterrarium.llm.base import (
    BaseLLMProvider,
    ChatResponse,
    NativeToolCall,
    ToolSchema,
)
from kohakuterrarium.llm.openai import OpenAIProvider

from .assistant_gemini import (
    _PromptSanitizer,
    _gemini_client,
    _gemini_reasoning_text,
    _gemini_response_parts,
    _gemini_sdk_config,
    _gemini_sdk_contents,
    _gemini_sdk_dict,
    _gemini_text_parts_from_content,
    _gemini_usage,
)
from .assistant_openai import _openai_base_url
from .assistant_profiles import GEMINI_NATIVE, LLAMA_ONCE
from .constants import DEFAULT_LOCAL_CONTEXT_TOKENS, DEFAULT_LOCAL_TEXT_PRESET
from .llama_runtime import _free_port, _wait_server
from .model_paths import resolve_llama_server, resolve_vision_model_pair
from .response_text import reasoning_text


def build_profile_provider(profile: dict[str, Any]) -> BaseLLMProvider:
    if profile.get("protocol") == GEMINI_NATIVE:
        return GeminiNativeProvider(profile)
    if profile.get("runtime") == LLAMA_ONCE:
        return LlamaOnceProvider(profile)
    return ProfileOpenAIProvider(profile)


class StreamObserverMixin:
    def set_stream_observer(
        self,
        observer: Callable[[str, dict[str, Any]], Any] | None,
    ) -> None:
        self._stream_observer = observer

    async def _emit_stream_event(self, event_type: str, payload: dict[str, Any]) -> None:
        observer = getattr(self, "_stream_observer", None)
        if not callable(observer):
            return
        result = observer(event_type, payload)
        if inspect.isawaitable(result):
            await result

    async def _emit_provider_summary(self) -> None:
        reasoning = reasoning_text(self.last_assistant_extra_fields)
        if reasoning:
            await self._emit_stream_event("reasoning_delta", {"text": reasoning})
        if self.last_usage:
            await self._emit_stream_event("usage", {"usage": dict(self.last_usage)})


class ProfileOpenAIProvider(StreamObserverMixin, BaseLLMProvider):
    provider_name = "openai"

    def __init__(self, profile: dict[str, Any]):
        super().__init__()
        self.profile = dict(profile)
        self.config.model = str(profile["model"])
        self.config.temperature = float(profile.get("temperature", 0.35))
        self.config.max_tokens = int(profile.get("max_tokens", 8192))
        self.config.top_p = float(profile.get("top_p", 0.9))
        endpoints = [str(profile["endpoint"]), *(profile.get("fallback_endpoints") or [])]
        api_key = str(profile.get("api_key") or "")
        self._providers = [self._provider(endpoint, api_key) for endpoint in endpoints]

    def _provider(self, endpoint: str, api_key: str) -> OpenAIProvider:
        extra_body = dict(self.profile.get("extra_body") or {})
        if self.profile.get("runtime") == "llama-endpoint":
            extra_body.setdefault(
                "chat_template_kwargs",
                {"enable_thinking": bool(self.profile.get("thinking", False))},
            )
        return OpenAIProvider(
            api_key=api_key or "not-needed",
            model=self.config.model,
            base_url=_openai_base_url(endpoint),
            temperature=self.config.temperature,
            max_tokens=self.config.max_tokens,
            timeout=float(self.profile.get("timeout", 120)),
            extra_body=extra_body,
        )

    async def _stream_chat(
        self,
        messages: list[dict[str, Any]],
        *,
        tools: list[ToolSchema] | None = None,
        provider_native_tools: list[Any] | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[str]:
        last_error: Exception | None = None
        for provider in self._providers:
            emitted = False
            try:
                request_kwargs = {"top_p": self.config.top_p, **kwargs}
                async for chunk in provider.chat(
                    messages,
                    stream=True,
                    tools=tools,
                    provider_native_tools=provider_native_tools,
                    **request_kwargs,
                ):
                    emitted = emitted or bool(chunk)
                    yield chunk
                self._copy_result(provider)
                await self._emit_provider_summary()
                return
            except Exception as error:
                last_error = error
                if emitted:
                    raise
        if last_error is not None:
            raise last_error
        raise RuntimeError("No OpenAI-compatible endpoint is configured")

    async def _complete_chat(self, messages: list[dict[str, Any]], **kwargs: Any) -> ChatResponse:
        last_error: Exception | None = None
        for provider in self._providers:
            try:
                result = await provider.chat_complete(messages, **{"top_p": self.config.top_p, **kwargs})
                self._copy_result(provider)
                return result
            except Exception as error:
                last_error = error
        if last_error is not None:
            raise last_error
        raise RuntimeError("No OpenAI-compatible endpoint is configured")

    def _copy_result(self, provider: BaseLLMProvider) -> None:
        self._last_tool_calls = list(provider.last_tool_calls)
        self._last_usage = dict(provider.last_usage)
        self._last_assistant_extra_fields = dict(provider.last_assistant_extra_fields)

    async def close(self) -> None:
        await asyncio.gather(*(provider.close() for provider in self._providers), return_exceptions=True)


class GeminiNativeProvider(StreamObserverMixin, BaseLLMProvider):
    provider_name = "gemini"

    def __init__(self, profile: dict[str, Any]):
        super().__init__()
        self.profile = dict(profile)
        self.config.model = str(profile["model"])
        self.config.temperature = float(profile.get("temperature", 0.35))
        self.config.max_tokens = int(profile.get("max_tokens", 8192))
        self.config.top_p = float(profile.get("top_p", 0.9))

    async def _stream_chat(
        self,
        messages: list[dict[str, Any]],
        *,
        tools: list[ToolSchema] | None = None,
        provider_native_tools: list[Any] | None = None,
        **_: Any,
    ) -> AsyncIterator[str]:
        del provider_native_tools
        self._last_usage = {}
        self._last_assistant_extra_fields = {}
        sanitizer = _PromptSanitizer(bool(self.profile.get("sanitize_sensitive", True)))
        body = self._request_body(sanitizer.sanitize_messages(messages), tools)
        contents = _gemini_sdk_contents(body)
        config = _gemini_sdk_config(body)
        endpoints = [str(self.profile["endpoint"]), *(self.profile.get("fallback_endpoints") or [])]
        last_error: Exception | None = None
        for endpoint in endpoints:
            client = _gemini_client(endpoint, str(self.profile.get("api_key") or ""), int(self.profile.get("timeout", 120)))
            emitted = False
            tool_calls: dict[str, NativeToolCall] = {}
            reasoning_parts: list[str] = []
            try:
                stream = await client.aio.models.generate_content_stream(
                    model=self.config.model,
                    contents=contents,
                    config=config,
                )
                async for response in stream:
                    data = _gemini_sdk_dict(response)
                    text, calls = _gemini_response_parts(data)
                    reasoning = _gemini_reasoning_text(data)
                    if reasoning:
                        reasoning_parts.append(reasoning)
                        await self._emit_stream_event(
                            "reasoning_delta",
                            {"text": sanitizer.restore_text(reasoning)},
                        )
                    for index, call in enumerate(calls):
                        name = str(call.get("tool") or "")
                        arguments = call.get("arguments") if isinstance(call.get("arguments"), dict) else {}
                        call_id = str(call.get("id") or f"gemini-{index + 1}")
                        tool_calls[call_id] = NativeToolCall(
                            id=call_id,
                            name=name,
                            arguments=json.dumps(sanitizer.restore_obj(arguments), ensure_ascii=False),
                        )
                    if text:
                        emitted = True
                        yield sanitizer.restore_text(text)
                    self._last_usage = self._normalized_usage(data)
                    if self._last_usage:
                        await self._emit_stream_event(
                            "usage",
                            {"usage": dict(self._last_usage)},
                        )
                self._last_tool_calls = list(tool_calls.values())
                if reasoning_parts:
                    self._last_assistant_extra_fields = {
                        "reasoning_content": sanitizer.restore_text("".join(reasoning_parts))
                    }
                return
            except Exception as error:
                last_error = error
                if emitted:
                    raise
            finally:
                await client.aio.aclose()
        if last_error is not None:
            raise last_error
        raise RuntimeError("No Gemini endpoint is configured")

    def _request_body(self, messages: list[dict[str, Any]], tools: list[ToolSchema] | None) -> dict[str, Any]:
        system_parts: list[str] = []
        contents: list[dict[str, Any]] = []
        pending_functions: dict[str, str] = {}
        for message in messages:
            role = str(message.get("role") or "")
            if role == "system":
                system_parts.extend(
                    str(part.get("text") or "")
                    for part in _gemini_text_parts_from_content(message.get("content"))
                    if part.get("text")
                )
                continue
            parts = _gemini_text_parts_from_content(message.get("content"))
            if role == "assistant":
                for index, call in enumerate(message.get("tool_calls") or []):
                    function = call.get("function") if isinstance(call, dict) else {}
                    name = str((function or {}).get("name") or "")
                    raw_arguments = (function or {}).get("arguments", {})
                    if isinstance(raw_arguments, str):
                        try:
                            raw_arguments = json.loads(raw_arguments)
                        except json.JSONDecodeError:
                            raw_arguments = {}
                    call_id = str(call.get("id") or f"call-{index}")
                    if name:
                        parts.append({"functionCall": {"id": call_id, "name": name, "args": raw_arguments}})
                        pending_functions[call_id] = name
            if role == "tool":
                call_id = str(message.get("tool_call_id") or "")
                name = pending_functions.get(call_id) or str(message.get("name") or "tool")
                response: Any = message.get("content", "")
                if isinstance(response, str):
                    try:
                        response = json.loads(response)
                    except json.JSONDecodeError:
                        response = {"result": response}
                if not isinstance(response, dict):
                    response = {"result": response}
                parts = [{"functionResponse": {"id": call_id, "name": name, "response": response}}]
            if parts:
                contents.append({"role": "model" if role == "assistant" else "tool" if role == "tool" else "user", "parts": parts})

        body: dict[str, Any] = {
            "contents": contents,
            "generationConfig": {
                "temperature": self.config.temperature,
                "topP": self.config.top_p,
                "maxOutputTokens": self.config.max_tokens,
            },
            "safetySettings": [
                {"category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE"},
                {"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE"},
                {"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE"},
                {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE"},
            ],
        }
        if system_parts:
            body["systemInstruction"] = {"parts": [{"text": "\n\n".join(system_parts)}]}
        if self.profile.get("reasoning_enabled") is not False:
            effort = str(self.profile.get("reasoning_effort") or "low").lower()
            if effort != "none":
                level = "MINIMAL" if effort == "minimal" else "LOW" if effort == "low" else "MEDIUM" if effort == "medium" else "HIGH"
                body["generationConfig"]["thinkingConfig"] = {"thinkingLevel": level}
        if tools:
            body["tools"] = [
                {
                    "functionDeclarations": [
                        {
                            "name": tool.name,
                            "description": tool.description,
                            "parameters": tool.parameters,
                        }
                        for tool in tools
                    ]
                }
            ]
            body["toolConfig"] = {"functionCallingConfig": {"mode": "AUTO"}}
        return body

    def _normalized_usage(self, data: dict[str, Any]) -> dict[str, int]:
        usage = _gemini_usage(data)
        return {
            "prompt_tokens": usage["input_tokens"],
            "completion_tokens": usage["output_tokens"],
            "reasoning_tokens": usage["thought_tokens"],
            "cached_tokens": usage["cached_tokens"],
            "total_tokens": usage["total_tokens"],
        }

    async def _complete_chat(self, messages: list[dict[str, Any]], **kwargs: Any) -> ChatResponse:
        parts = []
        async for chunk in self._stream_chat(messages, **kwargs):
            parts.append(chunk)
        return ChatResponse(
            content="".join(parts),
            finish_reason="stop",
            usage=dict(self.last_usage),
            model=self.config.model,
        )

    async def close(self) -> None:
        return None


class LlamaOnceProvider(StreamObserverMixin, BaseLLMProvider):
    provider_name = "openai"

    def __init__(self, profile: dict[str, Any]):
        super().__init__()
        self.profile = dict(profile)
        self.config.model = str(profile["model"])
        self.config.temperature = float(profile.get("temperature", 0.25))
        self.config.max_tokens = int(profile.get("max_tokens", 2048))
        self.config.top_p = float(profile.get("top_p", 0.9))
        self._provider: OpenAIProvider | None = None
        self._process: subprocess.Popen | None = None

    async def begin_turn(self) -> None:
        await self.end_turn()

    async def end_turn(self) -> None:
        provider, self._provider = self._provider, None
        process, self._process = self._process, None
        if provider is not None:
            await provider.close()
        if process is not None:
            await asyncio.to_thread(self._terminate, process)

    async def _ensure_provider(self, messages: list[dict[str, Any]]) -> OpenAIProvider:
        if self._provider is not None:
            return self._provider
        has_image = "image_url" in json.dumps(messages, ensure_ascii=True)
        preset = str(self.profile.get("local_text_preset") or DEFAULT_LOCAL_TEXT_PRESET)
        model_path, mmproj_path, alias = resolve_vision_model_pair(
            preset,
            str(self.profile.get("model_path") or ""),
            str(self.profile.get("mmproj_path") or ""),
            has_image,
        )
        alias = self.config.model or alias
        port = _free_port()
        layers = self.profile.get("n_gpu_layers", "all")
        args = [
            resolve_llama_server(str(self.profile.get("llama_server_path") or "")),
            "-m",
            model_path,
            "-ngl",
            "all" if str(layers).strip() in {"", "-1", "all"} else str(int(layers)),
            "-c",
            str(int(self.profile.get("n_ctx") or DEFAULT_LOCAL_CONTEXT_TOKENS)),
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
        self._process = subprocess.Popen(
            args,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            creationflags=creationflags,
        )
        endpoint = f"http://127.0.0.1:{port}/v1"
        try:
            await asyncio.to_thread(_wait_server, endpoint, int(self.profile.get("timeout", 120)))
            self._provider = OpenAIProvider(
                api_key="not-needed",
                model=alias,
                base_url=endpoint,
                temperature=self.config.temperature,
                max_tokens=self.config.max_tokens,
                timeout=float(self.profile.get("timeout", 120)),
                extra_body={
                    "chat_template_kwargs": {
                        "enable_thinking": bool(self.profile.get("thinking", False))
                    }
                },
            )
            return self._provider
        except BaseException:
            await self.end_turn()
            raise

    async def _stream_chat(
        self,
        messages: list[dict[str, Any]],
        *,
        tools: list[ToolSchema] | None = None,
        provider_native_tools: list[Any] | None = None,
        **kwargs: Any,
    ) -> AsyncIterator[str]:
        provider = await self._ensure_provider(messages)
        request_kwargs = {"top_p": self.config.top_p, **kwargs}
        async for chunk in provider.chat(
            messages,
            stream=True,
            tools=tools,
            provider_native_tools=provider_native_tools,
            **request_kwargs,
        ):
            yield chunk
        self._copy_result(provider)
        await self._emit_provider_summary()

    async def _complete_chat(self, messages: list[dict[str, Any]], **kwargs: Any) -> ChatResponse:
        provider = await self._ensure_provider(messages)
        result = await provider.chat_complete(messages, **{"top_p": self.config.top_p, **kwargs})
        self._copy_result(provider)
        return result

    def _copy_result(self, provider: BaseLLMProvider) -> None:
        self._last_tool_calls = list(provider.last_tool_calls)
        self._last_usage = dict(provider.last_usage)
        self._last_assistant_extra_fields = dict(provider.last_assistant_extra_fields)

    async def close(self) -> None:
        await self.end_turn()

    @staticmethod
    def _terminate(process: subprocess.Popen) -> None:
        if process.poll() is not None:
            return
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
