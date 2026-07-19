from __future__ import annotations

import re
from typing import Any

from kohakuterrarium.core.termination import TerminationDecision
from kohakuterrarium.modules.output.router_state import CompletedOutput
from kohakuterrarium.modules.plugin.base import BasePlugin


_EDIT_TOOLS = frozenset({"edit_prompt", "initialize_prompt"})
_READ_TOOLS = frozenset({"read_prompt"})
_MAX_FORCED_CONTINUATIONS = 3


def prompt_edit_requested(value: Any) -> bool:
    """Recognize a direct request to change the active Forge prompt."""
    text = re.sub(r"\s+", " ", str(value or "")).strip().lower()
    if not text:
        return False
    edit = re.compile(
        r"改成|修改|改写|重写|优化|精炼|扩写|替换|追加|加上|加入|删除|移除|写入|更新|套用|应用|编辑|修一下|"
        r"insert|append|replace|rewrite|edit|update|apply|change|remove|delete|optimise|optimize|refine|expand",
        re.IGNORECASE,
    )
    current = re.compile(
        r"当前|现在|现有|原来|原有|这个|这段|它|其|提示词|prompt|txt2img|img2img|webui|ui|输入框|文本框",
        re.IGNORECASE,
    )
    advice_only = re.compile(
        r"怎么改|如何改|哪里.*改|修改建议|改进建议|优化建议|建议.*(修改|优化|改写|调整)|"
        r"should.*(change|edit|rewrite)|how.*(change|edit|rewrite)",
        re.IGNORECASE,
    )
    direct = re.compile(
        r"(帮我|请|直接|把|将|给我).{0,40}(改成|修改|改写|重写|优化|精炼|扩写|替换|追加|加上|加入|删除|移除|写入|更新|套用|应用|编辑|修一下)",
        re.IGNORECASE,
    )
    return bool(edit.search(text) and not advice_only.search(text) and (current.search(text) or direct.search(text)))


def _tool_succeeded(result: Any) -> bool:
    if result is None or getattr(result, "error", None):
        return False
    output = getattr(result, "output", result)
    if isinstance(output, dict):
        return output.get("ok") is not False
    if isinstance(output, str):
        return '"ok":false' not in output.replace(" ", "").lower()
    return True


class LoomPromptEditGuard(BasePlugin):
    """Keep explicit prompt edits from ending after a read-only round."""

    name = "loom-prompt-edit-guard"
    priority = 5

    def __init__(self) -> None:
        super().__init__()
        self._agent: Any = None
        self._required = False
        self._read_succeeded = False
        self._edited = False
        self._mutation_failed = False
        self._forced_continuations = 0
        self._blocked = False

    async def on_load(self, context: Any) -> None:
        self._agent = context.host_agent

    async def on_event(self, event: Any) -> None:
        if str(getattr(event, "type", "")) != "user_input":
            return
        get_text = getattr(event, "get_text_content", None)
        content = get_text() if callable(get_text) else getattr(event, "content", "")
        self._required = prompt_edit_requested(content)
        self._read_succeeded = False
        self._edited = False
        self._mutation_failed = False
        self._forced_continuations = 0
        self._blocked = False

    async def post_tool_execute(self, result: Any, **kwargs: Any) -> None:
        if not self._required:
            return
        name = str(kwargs.get("tool_name") or "")
        if name in _READ_TOOLS and _tool_succeeded(result):
            self._read_succeeded = True
        elif name in _EDIT_TOOLS:
            if _tool_succeeded(result):
                self._edited = True
                self._mutation_failed = False
            else:
                self._mutation_failed = True
                self._read_succeeded = False
                self._blocked = False

    async def pre_llm_call(self, messages: list[dict[str, Any]], **_: Any) -> list[dict[str, Any]] | None:
        if not self._required or self._edited or not (self._read_succeeded or self._mutation_failed):
            return None
        return [
            *messages,
            {
                "role": "user",
                "content": (
                    "The user explicitly asked to modify the active Forge prompt. "
                    "Do not finish with analysis or a summary. If the last read succeeded, "
                    "call edit_prompt now using its latest hash. If a mutation failed, "
                    "read the current prompt again, then retry the guarded mutation. "
                    "Only finish after edit_prompt or initialize_prompt returns ok:true, "
                    "or after a tool failure genuinely prevents the requested change."
                ),
            },
        ]

    async def post_llm_call(self, _messages: list[dict[str, Any]], _response: str, _usage: dict[str, Any], **_: Any) -> None:
        if not self._required or self._edited or self._blocked:
            return
        controller = getattr(self._agent, "controller", None)
        conversation = getattr(controller, "conversation", None)
        last = conversation.get_last_assistant_message() if conversation is not None else None
        tool_calls = getattr(last, "tool_calls", None) if last is not None else None
        if isinstance(last, dict):
            tool_calls = last.get("tool_calls")
        if tool_calls:
            return
        if self._forced_continuations >= _MAX_FORCED_CONTINUATIONS:
            self._blocked = True
            router = getattr(self._agent, "output_router", None)
            if router is not None:
                router.notify_activity(
                    "processing_error",
                    "The explicit prompt edit did not complete after the read step.",
            )
            return

        self._forced_continuations += 1
        if controller is not None:
            pending = getattr(controller, "_pending_injections", None)
            if pending is None:
                pending = []
                controller._pending_injections = pending
            pending.append(
                {
                    "role": "user",
                    "content": (
                        "Continuation required: the requested Forge prompt mutation is not complete. "
                        "Use the available read/edit tools now; do not answer with prose yet."
                    ),
                }
            )
        router = getattr(self._agent, "output_router", None)
        completed = getattr(router, "_completed_outputs", None) if router is not None else None
        if isinstance(completed, list):
            completed.append(
                CompletedOutput(
                    target="loom-prompt-edit-guard",
                    content="Prompt mutation continuation required",
                )
            )

    def contribute_termination_check(self):
        return self._termination_vote

    def _termination_vote(self, _context: Any) -> TerminationDecision:
        if not self._required or self._edited:
            return TerminationDecision(should_stop=False)
        if self._blocked:
            return TerminationDecision(
                should_stop=True,
                reason="The explicit prompt mutation could not be completed.",
            )
        return TerminationDecision(
            should_stop=False,
            reason="An explicit prompt mutation is still pending.",
        )


def build_prompt_edit_guard() -> LoomPromptEditGuard:
    return LoomPromptEditGuard()
