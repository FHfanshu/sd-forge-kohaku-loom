"""Thin Forge service boundary for SD Forge Neo Prompt Agent."""

from .app import API_PREFIX, register_prompt_agent_api

__all__ = ["API_PREFIX", "register_prompt_agent_api"]
