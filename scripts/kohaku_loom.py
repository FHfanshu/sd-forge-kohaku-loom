from __future__ import annotations

import json

import gradio as gr

from kohaku_loom.forge_resources import inspect_resource, search_resources
from kohaku_loom.danbooru import inspect_danbooru_tag, inspect_danbooru_tags, related_danbooru_tags, search_danbooru_tags
from kohaku_loom.i18n import locale_metadata, translation_bundle
from kohaku_loom.kt_proxy import register_kt_proxy
from kohaku_loom.legacy_sessions import LegacySessionReader
from kohaku_loom.prompt_skills import load_prompt_skill
from kohaku_loom.generic import (
    analyze_reference_image,
)
from modules import call_queue, script_callbacks


def _assistant_api(_: gr.Blocks, app):
    from fastapi import Body, HTTPException
    register_kt_proxy(app)
    legacy_sessions = LegacySessionReader()

    @app.get("/kohaku-loom/legacy-sessions")
    async def kohaku_loom_legacy_sessions(limit: int = 50):
        return {"sessions": legacy_sessions.list_sessions(limit), "read_only": True}

    @app.get("/kohaku-loom/legacy-sessions/{session_id}")
    async def kohaku_loom_legacy_session(session_id: str, limit: int = 500):
        try:
            return legacy_sessions.get_session(session_id, limit)
        except (FileNotFoundError, KeyError) as error:
            raise HTTPException(status_code=404, detail="legacy session not found") from error

    @app.post("/kohaku-loom/analyze-image")
    async def qwen3vl_reference_image(payload: dict = Body(...)):
        try:
            with call_queue.queue_lock:
                return analyze_reference_image(payload)
        except Exception as error:
            raise HTTPException(status_code=500, detail=str(error)) from error

    @app.get("/kohaku-loom/i18n")
    async def qwen3vl_i18n(locale: str | None = None):
        return translation_bundle(locale)

    @app.get("/kohaku-loom/i18n/locale")
    async def qwen3vl_i18n_locale(locale: str | None = None):
        return locale_metadata(locale)

    @app.get("/kohaku-loom/prompt-styles")
    async def qwen3vl_prompt_styles():
        try:
            from modules import shared

            styles = []
            prompt_styles = getattr(shared, "prompt_styles", None)
            for style in getattr(prompt_styles, "styles", {}).values():
                styles.append(
                    {
                        "name": getattr(style, "name", ""),
                        "prompt": getattr(style, "prompt", ""),
                        "negative_prompt": getattr(style, "negative_prompt", ""),
                    }
                )
            return {"styles": styles}
        except Exception as error:
            raise HTTPException(status_code=500, detail=str(error)) from error

    @app.get("/kohaku-loom/resources/search")
    async def qwen3vl_resource_search(
        kind: str,
        query: str = "",
        limit: int = 20,
        cursor: str = "",
    ):
        try:
            return search_resources(kind, query=query, limit=limit, cursor=cursor)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        except Exception as error:
            raise HTTPException(status_code=500, detail=str(error)) from error

    @app.get("/kohaku-loom/resources/inspect")
    async def qwen3vl_resource_inspect(
        kind: str,
        id: str,
        query: str = "",
        limit: int = 20,
        cursor: str = "",
    ):
        try:
            return inspect_resource(kind, id, query=query, limit=limit, cursor=cursor)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        except Exception as error:
            raise HTTPException(status_code=500, detail=str(error)) from error

    @app.get("/kohaku-loom/danbooru/tags/search")
    async def qwen3vl_danbooru_tag_search(query: str = "", queries: str = "", category: str = "", limit: int = 12):
        try:
            batch = json.loads(queries) if queries else None
            return search_danbooru_tags(query, category, limit, batch)
        except json.JSONDecodeError as error:
            raise HTTPException(status_code=400, detail="queries must be a JSON array") from error
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        except Exception as error:
            raise HTTPException(status_code=502, detail=str(error)) from error

    @app.get("/kohaku-loom/danbooru/tags/inspect")
    async def qwen3vl_danbooru_tag_inspect(name: str):
        try:
            return inspect_danbooru_tag(name)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        except Exception as error:
            raise HTTPException(status_code=502, detail=str(error)) from error

    @app.get("/kohaku-loom/danbooru/tags/inspect-batch")
    async def qwen3vl_danbooru_tag_inspect_batch(names: str, include_wiki: bool = False):
        try:
            return inspect_danbooru_tags([name for name in names.split(",") if name.strip()], include_wiki)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        except Exception as error:
            raise HTTPException(status_code=502, detail=str(error)) from error

    @app.get("/kohaku-loom/danbooru/tags/related")
    async def qwen3vl_danbooru_tag_related(name: str, category: str = "", limit: int = 12):
        try:
            return related_danbooru_tags(name, category, limit)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        except Exception as error:
            raise HTTPException(status_code=502, detail=str(error)) from error

    @app.get("/kohaku-loom/prompt-skills/{name}")
    async def qwen3vl_prompt_skill(name: str):
        result = load_prompt_skill(name)
        if not result.get("ok"):
            raise HTTPException(status_code=404, detail=result.get("error") or "unknown prompt skill")
        return result

    @app.get("/kohaku-loom/settings-export")
    async def qwen3vl_settings_export():
        from modules import shared

        prefix = "loom_assistant_"
        return {
            key.removeprefix(prefix): value
            for key, value in shared.opts.data.items()
            if key.startswith(prefix) and "settings_" not in key and "api_key" not in key
        }

script_callbacks.on_app_started(_assistant_api, name="kohaku-loom-assistant-api")
