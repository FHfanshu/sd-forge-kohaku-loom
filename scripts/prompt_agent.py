from __future__ import annotations

import json

import gradio as gr

from backend.prompt_agent import register_prompt_agent_api
from backend.prompt_agent.forge_tools import ForgeToolValidationError, validate_forge_tool_request
from prompt_agent.forge_resources import inspect_resource, search_resources
from prompt_agent.danbooru import inspect_danbooru_tag, inspect_danbooru_tags, related_danbooru_tags, search_danbooru_tags
from prompt_agent.i18n import locale_metadata, translation_bundle
from prompt_agent.prompt_skills import load_prompt_skill
from prompt_agent.reference_image import analyze_reference_image
from modules import call_queue, script_callbacks


def _assistant_api(_: gr.Blocks, app):
    from fastapi import Body, HTTPException
    register_prompt_agent_api(app)

    @app.post("/prompt-agent/api/analyze-image")
    async def prompt_agent_reference_image(payload: dict = Body(...)):
        try:
            with call_queue.queue_lock:
                return analyze_reference_image(payload)
        except Exception as error:
            raise HTTPException(status_code=500, detail=str(error)) from error

    @app.get("/prompt-agent/api/i18n")
    async def prompt_agent_i18n(locale: str | None = None):
        return translation_bundle(locale)

    @app.get("/prompt-agent/api/i18n/locale")
    async def prompt_agent_i18n_locale(locale: str | None = None):
        return locale_metadata(locale)

    @app.get("/prompt-agent/api/prompt-styles")
    async def prompt_agent_prompt_styles():
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

    @app.get("/prompt-agent/api/resources/search")
    async def prompt_agent_resource_search(
        kind: str,
        query: str = "",
        limit: int = 20,
        cursor: str = "",
    ):
        try:
            validate_forge_tool_request("list_resources", {"kind": kind, "query": query, "limit": limit, "cursor": cursor})
            return search_resources(kind, query=query, limit=limit, cursor=cursor)
        except (ValueError, ForgeToolValidationError) as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        except Exception as error:
            raise HTTPException(status_code=500, detail=str(error)) from error

    @app.get("/prompt-agent/api/resources/inspect")
    async def prompt_agent_resource_inspect(
        kind: str,
        id: str,
        query: str = "",
        limit: int = 20,
        cursor: str = "",
    ):
        try:
            validate_forge_tool_request("read_resource_metadata", {"kind": kind, "id": id, "query": query, "limit": limit, "cursor": cursor})
            return inspect_resource(kind, id, query=query, limit=limit, cursor=cursor)
        except (ValueError, ForgeToolValidationError) as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        except Exception as error:
            raise HTTPException(status_code=500, detail=str(error)) from error

    @app.get("/prompt-agent/api/danbooru/tags/search")
    async def prompt_agent_danbooru_tag_search(query: str = "", queries: str = "", category: str = "", limit: int = 12):
        try:
            batch = json.loads(queries) if queries else None
            return search_danbooru_tags(query, category, limit, batch)
        except json.JSONDecodeError as error:
            raise HTTPException(status_code=400, detail="queries must be a JSON array") from error
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        except Exception as error:
            raise HTTPException(status_code=502, detail=str(error)) from error

    @app.get("/prompt-agent/api/danbooru/tags/inspect")
    async def prompt_agent_danbooru_tag_inspect(name: str):
        try:
            return inspect_danbooru_tag(name)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        except Exception as error:
            raise HTTPException(status_code=502, detail=str(error)) from error

    @app.get("/prompt-agent/api/danbooru/tags/inspect-batch")
    async def prompt_agent_danbooru_tag_inspect_batch(names: str, include_wiki: bool = False):
        try:
            return inspect_danbooru_tags([name for name in names.split(",") if name.strip()], include_wiki)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        except Exception as error:
            raise HTTPException(status_code=502, detail=str(error)) from error

    @app.get("/prompt-agent/api/danbooru/tags/related")
    async def prompt_agent_danbooru_tag_related(name: str, category: str = "", limit: int = 12):
        try:
            return related_danbooru_tags(name, category, limit)
        except ValueError as error:
            raise HTTPException(status_code=400, detail=str(error)) from error
        except Exception as error:
            raise HTTPException(status_code=502, detail=str(error)) from error

    @app.get("/prompt-agent/api/prompt-skills/{name}")
    async def prompt_agent_prompt_skill(name: str):
        result = load_prompt_skill(name)
        if not result.get("ok"):
            raise HTTPException(status_code=404, detail=result.get("error") or "unknown prompt skill")
        return result

    @app.get("/prompt-agent/api/settings-export")
    async def prompt_agent_settings_export():
        from modules import shared

        prefix = "prompt_agent_"
        return {
            key.removeprefix(prefix): value
            for key, value in shared.opts.data.items()
            if key.startswith(prefix) and "settings_" not in key and "api_key" not in key
        }

script_callbacks.on_app_started(_assistant_api, name="prompt-agent-api")
