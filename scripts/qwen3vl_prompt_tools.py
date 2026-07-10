from __future__ import annotations

from pathlib import Path

import gradio as gr

from lib_qwen3vl_prompt_tools.generation import caption, enhance
from lib_qwen3vl_prompt_tools.i18n import tr, translation_bundle
from lib_qwen3vl_prompt_tools.generic import (
    TAGGER,
    TAGGER_MODELS,
    DEFAULT_VISION_MODEL_PRESET,
    DEFAULT_LOCAL_CONTEXT_TOKENS,
    VISION_MODEL_PRESET_CUSTOM,
    VISION_MODEL_PRESETS,
    analyze_reference_image,
    ask_teacher,
    build_nl_from_endpoint,
    build_nl_from_local_gguf,
    cancel_local_assistant_run,
    combine_prompt,
    find_default_llama_server,
    find_vision_preset_files,
    prompt_assistant_chat,
    prompt_assistant_stream,
    repo_from_label,
)
from lib_qwen3vl_prompt_tools.prompts import CAPTION_TASKS
from modules import call_queue, script_callbacks


PROMPT_COMPONENTS = {}
FORGE_ROOT = Path(__file__).resolve().parents[3]
LLM_MODEL_DIR = FORGE_ROOT / "models" / "LLM"
PROMPT_TEMPLATE_CHOICES = ["通用图像提示词", "美学风格抽取（Anima 英文）"]


def _llm_choices(kind: str) -> list[str]:
    if not LLM_MODEL_DIR.exists():
        return []
    paths = sorted(LLM_MODEL_DIR.rglob("*.gguf"), key=lambda path: str(path).lower())
    if kind == "mmproj":
        paths = [path for path in paths if "mmproj" in path.name.lower()]
    else:
        paths = [path for path in paths if "mmproj" not in path.name.lower()]
    return [str(path) for path in paths]


def _preferred_choice(choices: list[str], contains: str = "9B") -> str:
    if not choices:
        return ""
    lowered = contains.lower()
    for choice in choices:
        if lowered in Path(choice).name.lower():
            return choice
    return choices[0]


def _append_log(log: str, line: str) -> str:
    return (log.rstrip() + "\n" + line).strip() if log else line


def _needs_default_download(backend: str, gguf_path: str, mmproj_path: str) -> bool:
    if backend != "Local GGUF once":
        return False
    model = str(gguf_path or "").strip().strip('"')
    mmproj = str(mmproj_path or "").strip().strip('"')
    return not model or not Path(model).exists() or not mmproj or not Path(mmproj).exists()


def _needs_llama_server_download(backend: str, llama_server_path: str) -> bool:
    if backend != "Local GGUF once":
        return False
    configured = str(llama_server_path or "").strip().strip('"')
    if configured and Path(configured).exists():
        return False
    return not find_default_llama_server()


def _run_enhancer(text: str, task: str):
    try:
        with call_queue.queue_lock:
            return enhance(text, task)
    except Exception as error:
        raise gr.Error(str(error)) from error


def _assistant_api(_: gr.Blocks, app):
    from fastapi import Body, HTTPException
    from fastapi.responses import StreamingResponse

    @app.post("/qwen3vl-prompt-tools/assistant")
    async def qwen3vl_prompt_assistant(payload: dict = Body(...)):
        try:
            return prompt_assistant_chat(payload)
        except Exception as error:
            raise HTTPException(status_code=500, detail=str(error)) from error

    @app.post("/qwen3vl-prompt-tools/assistant-stream")
    async def qwen3vl_prompt_assistant_stream(payload: dict = Body(...)):
        return StreamingResponse(prompt_assistant_stream(payload), media_type="application/x-ndjson")

    @app.post("/qwen3vl-prompt-tools/assistant-cancel")
    async def qwen3vl_prompt_assistant_cancel(payload: dict = Body(...)):
        return cancel_local_assistant_run(str(payload.get("run_id") or ""))

    @app.post("/qwen3vl-prompt-tools/ask-teacher")
    async def qwen3vl_ask_teacher(payload: dict = Body(...)):
        try:
            return ask_teacher(payload)
        except Exception as error:
            raise HTTPException(status_code=500, detail=str(error)) from error

    @app.post("/qwen3vl-prompt-tools/analyze-image")
    async def qwen3vl_reference_image(payload: dict = Body(...)):
        try:
            with call_queue.queue_lock:
                return analyze_reference_image(payload)
        except Exception as error:
            raise HTTPException(status_code=500, detail=str(error)) from error

    @app.get("/qwen3vl-prompt-tools/i18n")
    async def qwen3vl_i18n(locale: str | None = None):
        return translation_bundle(locale)

    @app.get("/qwen3vl-prompt-tools/prompt-styles")
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


def _after_component(component, **kwargs):
    elem_id = kwargs.get("elem_id")
    if elem_id not in {"txt2img_prompt", "img2img_prompt"}:
        return
    if elem_id in PROMPT_COMPONENTS:
        return

    PROMPT_COMPONENTS[elem_id] = component
    with gr.Row(elem_classes=["q3vl-inline-actions"]):
        gr.HTML("<span class='q3vl-inline-label'>Qwen3-VL</span>")
        refine = gr.Button(tr("inline.refine"), size="sm", variant="secondary")
        expand = gr.Button(tr("inline.expand"), size="sm", variant="secondary")
        stylize = gr.Button(tr("inline.stylize"), size="sm", variant="secondary")

    for button, task in ((refine, "refine"), (expand, "expand"), (stylize, "stylize")):
        button.click(
            fn=lambda text, selected=task: _run_enhancer(text, selected),
            inputs=[component],
            outputs=[component],
            show_progress="full",
        )


def _run_caption(image, task, guidance, language, max_side, max_tokens, temperature, top_k, top_p, repetition_penalty, seed, release_after):
    try:
        with call_queue.queue_lock:
            result = caption(
                image,
                task,
                guidance,
                language=language,
                max_side=max_side,
                max_tokens=max_tokens,
                temperature=temperature,
                top_k=top_k,
                top_p=top_p,
                repetition_penalty=repetition_penalty,
                seed=seed,
                release_after=release_after,
            )
        return result, "<span class='q3vl-status-ok'>完成 · 结果仍可继续编辑</span>"
    except Exception as error:
        raise gr.Error(str(error)) from error


def _load_tagger(model_label):
    try:
        with call_queue.queue_lock:
            return TAGGER.load(repo_from_label(model_label))
    except Exception as error:
        raise gr.Error(str(error)) from error


def _unload_tagger():
    return TAGGER.unload()


def _run_wd_tagger(
    image,
    model_label,
    general_threshold,
    general_mcut,
    character_threshold,
    character_mcut,
    include_character_tags,
    limit_tags,
):
    try:
        with call_queue.queue_lock:
            result = TAGGER.predict(
                image,
                repo_from_label(model_label),
                general_threshold,
                general_mcut,
                character_threshold,
                character_mcut,
                include_character_tags,
                limit_tags,
            )
        log = "开始仅打 Tags\nTags 完成"
        return result.tags, result.characters, result.rating, result.raw_json, "", result.tags, "<span class='q3vl-status-ok'>tags 完成</span>", log
    except Exception as error:
        raise gr.Error(str(error)) from error


def _run_lmcpp_nl(
    image,
    tags,
    characters,
    rating,
    guidance,
    prompt_template,
    backend,
    endpoint,
    model,
    gguf_path,
    mmproj_path,
    llama_server_path,
    chat_format,
    n_ctx,
    n_gpu_layers,
    language,
    max_tokens,
    temperature,
    top_p,
    timeout,
    enable_thinking,
    combine_mode,
):
    try:
        log = "开始生成 NL"
        yield gr.update(), gr.update(), "<span class='q3vl-status-idle'>NL 生成中...</span>", log
        log = _append_log(log, f"后端: {backend}")
        if _needs_default_download(backend, gguf_path, mmproj_path):
            log = _append_log(log, "本地 GGUF/mmproj 缺失，开始下载默认 HauhauCS 9B 到 models\\LLM")
            yield gr.update(), gr.update(), "<span class='q3vl-status-idle'>正在下载默认模型...</span>", log
        if _needs_llama_server_download(backend, llama_server_path):
            log = _append_log(log, "llama-server.exe 缺失，开始下载 llama.cpp Windows 后端")
            yield gr.update(), gr.update(), "<span class='q3vl-status-idle'>正在下载 llama.cpp 后端...</span>", log
        result = _build_lmcpp_nl(
            image,
            tags,
            characters,
            rating,
            guidance,
            prompt_template,
            backend,
            endpoint,
            model,
            gguf_path,
            mmproj_path,
            llama_server_path,
            chat_format,
            n_ctx,
            n_gpu_layers,
            language,
            max_tokens,
            temperature,
            top_p,
            timeout,
            enable_thinking,
        )
        log = _append_log(log, "NL 完成")
        yield result, combine_prompt(tags, result, combine_mode), "<span class='q3vl-status-ok'>NL 完成</span>", log
    except Exception as error:
        raise gr.Error(str(error)) from error


def _build_lmcpp_nl(
    image,
    tags,
    characters,
    rating,
    guidance,
    prompt_template,
    backend,
    endpoint,
    model,
    gguf_path,
    mmproj_path,
    llama_server_path,
    chat_format,
    n_ctx,
    n_gpu_layers,
    language,
    max_tokens,
    temperature,
    top_p,
    timeout,
    enable_thinking,
):
    if backend == "Local GGUF once":
        return build_nl_from_local_gguf(
            tags,
            characters,
            rating,
            guidance,
            image,
            prompt_template,
            gguf_path,
            mmproj_path,
            llama_server_path,
            language,
            max_tokens,
            temperature,
            top_p,
            n_ctx,
            n_gpu_layers,
            chat_format,
            timeout,
            enable_thinking,
        )
    return build_nl_from_endpoint(
        tags,
        characters,
        rating,
        guidance,
        image,
        prompt_template,
        endpoint,
        model,
        language,
        max_tokens,
        temperature,
        top_p,
        timeout,
        enable_thinking,
    )


def _combine(tags, nl, mode):
    return combine_prompt(tags, nl, mode)


def _mode_visibility(mode: str):
    krea = mode == "Krea2 / Qwen3-VL"
    return (
        gr.update(visible=krea),
        gr.update(visible=krea),
        gr.update(visible=not krea),
        gr.update(visible=not krea),
    )


def _run_reverse(
    mode,
    image,
    task,
    guidance,
    prompt_template,
    language,
    max_side,
    max_tokens,
    temperature,
    top_k,
    top_p,
    repetition_penalty,
    seed,
    release_after,
    tagger_model,
    general_threshold,
    general_mcut,
    character_threshold,
    character_mcut,
    include_character_tags,
    limit_tags,
    backend,
    endpoint,
    model,
    gguf_path,
    mmproj_path,
    llama_server_path,
    chat_format,
    n_ctx,
    n_gpu_layers,
    lmcpp_language,
    lmcpp_max_tokens,
    lmcpp_temperature,
    lmcpp_top_p,
    lmcpp_timeout,
    enable_thinking,
    combine_mode,
):
    if mode == "Krea2 / Qwen3-VL":
        log = "开始 Krea2 / Qwen3-VL 反推"
        yield "", "", "", "{}", "", "", "<span class='q3vl-status-idle'>Krea2 反推中...</span>", log
        result, status = _run_caption(
            image,
            task,
            guidance,
            language,
            max_side,
            max_tokens,
            temperature,
            top_k,
            top_p,
            repetition_penalty,
            seed,
            release_after,
        )
        log = _append_log(log, "Krea2 反推完成")
        yield "", "", "", "{}", result, result, status, log
        return

    try:
        log = "开始 WD tagger + lmcpp 反推"
        yield gr.update(), gr.update(), gr.update(), gr.update(), gr.update(), gr.update(), "<span class='q3vl-status-idle'>Tags 生成中...</span>", log
        with call_queue.queue_lock:
            tagger_result = TAGGER.predict(
                image,
                repo_from_label(tagger_model),
                general_threshold,
                general_mcut,
                character_threshold,
                character_mcut,
                include_character_tags,
                limit_tags,
            )
        log = _append_log(log, f"Tags 完成: {len(tagger_result.tags.split(',')) if tagger_result.tags else 0} tags")
        yield (
            tagger_result.tags,
            tagger_result.characters,
            tagger_result.rating,
            tagger_result.raw_json,
            gr.update(),
            tagger_result.tags,
            "<span class='q3vl-status-idle'>NL 生成中...</span>",
            log,
        )
        log = _append_log(log, f"NL 后端: {backend}")
        if _needs_default_download(backend, gguf_path, mmproj_path):
            log = _append_log(log, "本地 GGUF/mmproj 缺失，开始下载默认 HauhauCS 9B 到 models\\LLM")
            yield (
                tagger_result.tags,
                tagger_result.characters,
                tagger_result.rating,
                tagger_result.raw_json,
                gr.update(),
                tagger_result.tags,
                "<span class='q3vl-status-idle'>正在下载默认模型...</span>",
                log,
            )
        if _needs_llama_server_download(backend, llama_server_path):
            log = _append_log(log, "llama-server.exe 缺失，开始下载 llama.cpp Windows 后端")
            yield (
                tagger_result.tags,
                tagger_result.characters,
                tagger_result.rating,
                tagger_result.raw_json,
                gr.update(),
                tagger_result.tags,
                "<span class='q3vl-status-idle'>正在下载 llama.cpp 后端...</span>",
                log,
            )
        nl_result = _build_lmcpp_nl(
            image,
            tagger_result.tags,
            tagger_result.characters,
            tagger_result.rating,
            guidance,
            prompt_template,
            backend,
            endpoint,
            model,
            gguf_path,
            mmproj_path,
            llama_server_path,
            chat_format,
            n_ctx,
            n_gpu_layers,
            lmcpp_language,
            lmcpp_max_tokens,
            lmcpp_temperature,
            lmcpp_top_p,
            lmcpp_timeout,
            enable_thinking,
        )
        log = _append_log(log, "NL 完成")
        yield (
            tagger_result.tags,
            tagger_result.characters,
            tagger_result.rating,
            tagger_result.raw_json,
            nl_result,
            combine_prompt(tagger_result.tags, nl_result, combine_mode),
            "<span class='q3vl-status-ok'>tags + NL 完成</span>",
            log,
        )
    except Exception as error:
        raise gr.Error(str(error)) from error


def _nl_backend_visibility(backend: str):
    endpoint = backend == "OpenAI endpoint"
    return gr.update(visible=endpoint), gr.update(visible=not endpoint)


def _vision_preset_choices() -> list[str]:
    return list(VISION_MODEL_PRESETS) + [VISION_MODEL_PRESET_CUSTOM]


def _vision_preset_update(preset: str):
    if preset == VISION_MODEL_PRESET_CUSTOM:
        return gr.update(), gr.update(), gr.update()
    model, mmproj, alias = find_vision_preset_files(preset)
    gguf_choices = _llm_choices("model")
    mmproj_choices = _llm_choices("mmproj")
    if model and model not in gguf_choices:
        gguf_choices = [model] + gguf_choices
    if mmproj and mmproj not in mmproj_choices:
        mmproj_choices = [mmproj] + mmproj_choices
    return gr.update(value=alias), gr.update(value=model, choices=gguf_choices), gr.update(value=mmproj, choices=mmproj_choices)


def _ui_tab():
    _ = tr
    gguf_choices = _llm_choices("model")
    mmproj_choices = _llm_choices("mmproj")
    default_vision_model, default_vision_mmproj, default_vision_alias = find_vision_preset_files(DEFAULT_VISION_MODEL_PRESET)
    if default_vision_model and default_vision_model not in gguf_choices:
        gguf_choices = [default_vision_model] + gguf_choices
    if default_vision_mmproj and default_vision_mmproj not in mmproj_choices:
        mmproj_choices = [default_vision_mmproj] + mmproj_choices
    with gr.Blocks(analytics_enabled=False) as interface:
        with gr.Column(elem_id="q3vl-workbench"):
            gr.HTML(
                f"<header class='q3vl-heading'><div class='q3vl-heading-copy'>"
                f"<span class='q3vl-kicker'><i aria-hidden='true'></i>{_('ui.kicker')}</span>"
                f"<h1>{_('ui.heading.title')}</h1><p>{_('ui.heading.description')}</p></div></header>"
            )
            mode = gr.Radio(
                ["WD tagger + lmcpp", "Krea2 / Qwen3-VL"],
                value="WD tagger + lmcpp",
                label=_("ui.mode"),
                elem_classes=["q3vl-mode-switch"],
            )
            with gr.Row(equal_height=False, elem_classes=["q3vl-grid"]):
                with gr.Column(scale=5, min_width=320, elem_classes=["q3vl-panel"]):
                    image = gr.Image(
                        type="pil",
                        label=_("ui.image"),
                        height=430,
                        sources=["upload", "clipboard"],
                        elem_classes=["q3vl-image-stage"],
                    )
                    with gr.Group(visible=False, elem_classes=["q3vl-control-card"]) as krea_controls:
                        task = gr.Radio(list(CAPTION_TASKS), value="完整反推", label=_("ui.read_focus"))
                    with gr.Group(visible=True, elem_classes=["q3vl-control-card"]) as wd_controls:
                        tagger_model = gr.Dropdown(list(TAGGER_MODELS), value="WD EVA02 large v3", label=_("ui.tagger_model"))
                        with gr.Row():
                            load_tagger = gr.Button(_("ui.load_tagger"), variant="secondary")
                            unload_tagger = gr.Button(_("ui.unload_tagger"), variant="secondary")
                        tagger_status = gr.Textbox(label=_("ui.tagger_status"), interactive=False)
                    guidance = gr.Textbox(
                        label=_("ui.extra_guidance"),
                        placeholder=_("ui.extra_guidance.placeholder"),
                        lines=2,
                        elem_classes=["q3vl-guidance"],
                    )
                    prompt_template = gr.Dropdown(
                        PROMPT_TEMPLATE_CHOICES,
                        value="美学风格抽取（Anima 英文）",
                        label=_("ui.prompt_template"),
                        elem_classes=["q3vl-template-select"],
                    )
                    with gr.Row(elem_classes=["q3vl-run-actions"]):
                        run = gr.Button(_("ui.run"), variant="primary", elem_classes=["q3vl-run"])
                        run_tags = gr.Button(_("ui.run_tags"), variant="secondary", visible=True)
                        run_nl = gr.Button(_("ui.run_nl"), variant="secondary", visible=True)
                    live_log = gr.Textbox(label=_("ui.live_log"), lines=7, interactive=False, elem_classes=["q3vl-live-log"])
                with gr.Column(scale=6, min_width=360, elem_classes=["q3vl-panel", "q3vl-output-panel"]):
                    tags = gr.Textbox(label="Tags", lines=6, show_copy_button=True, visible=True, elem_classes=["q3vl-result-card"])
                    with gr.Group(visible=True, elem_classes=["q3vl-result-stack"]) as wd_output:
                        with gr.Row():
                            characters = gr.Textbox(label=_("ui.characters"), lines=2, show_copy_button=True)
                            rating = gr.Textbox(label=_("ui.rating"), lines=2)
                        nl = gr.Textbox(label="Natural language", lines=7, show_copy_button=True)
                        combine_mode = gr.Radio(["Tags + NL", "Tags only", "NL only"], value="Tags + NL", label=_("ui.combine_format"))
                        combine = gr.Button(_("ui.combine"), variant="secondary", elem_classes=["q3vl-combine"])
                        with gr.Accordion(_("ui.debug"), open=False):
                            raw_json = gr.Code(label="Tag scores JSON", language="json", lines=7)
                    output = gr.Textbox(
                        label=_("ui.output"),
                        placeholder=_("ui.output.placeholder"),
                        lines=12,
                        show_copy_button=True,
                        elem_id="q3vl_reverse_output",
                        elem_classes=["q3vl-master-output"],
                    )
                    status = gr.HTML(
                        f"<span class='q3vl-status-idle'>{_('ui.status.waiting')}</span>",
                        elem_classes=["q3vl-status-wrap"],
                    )
                    with gr.Row(elem_classes=["q3vl-send-actions"]):
                        send_txt = gr.Button(_("ui.send_txt2img"), variant="secondary", elem_id="q3vl_send_txt2img")
                        send_img = gr.Button(_("ui.send_img2img"), variant="secondary", elem_id="q3vl_send_img2img")

            with gr.Group(visible=False) as krea_settings:
                with gr.Accordion(_("ui.accordion.krea"), open=False, elem_classes=["q3vl-tuning"]):
                    with gr.Row():
                        language = gr.Dropdown(["English", "中文"], value="English", label=_("ui.language"))
                        max_side = gr.Slider(448, 1344, value=768, step=64, label=_("ui.max_side"), info=_("ui.max_side.info"))
                        max_tokens = gr.Slider(64, 768, value=320, step=16, label=_("ui.max_tokens"))
                    with gr.Row():
                        temperature = gr.Slider(0, 1.5, value=0.65, step=0.05, label="Temperature")
                        top_k = gr.Slider(0, 100, value=20, step=1, label="Top K")
                        top_p = gr.Slider(0.1, 1.0, value=0.85, step=0.05, label="Top P")
                        repetition_penalty = gr.Slider(1.0, 1.3, value=1.05, step=0.01, label=_("ui.repetition_penalty"))
                    with gr.Row():
                        seed = gr.Number(value=42, precision=0, label="Seed")
                        release_after = gr.Checkbox(value=True, label=_("ui.release_after"), info=_("ui.release_after.info"))

            with gr.Group(visible=True) as wd_settings:
                with gr.Accordion(_("ui.accordion.wd"), open=True, elem_classes=["q3vl-tuning"]):
                    with gr.Row():
                        general_threshold = gr.Slider(0, 1, value=0.5, step=0.01, label="General threshold")
                        general_mcut = gr.Checkbox(False, label="General MCut")
                    with gr.Row():
                        character_threshold = gr.Slider(0, 1, value=0.85, step=0.01, label="Character threshold")
                        character_mcut = gr.Checkbox(False, label="Character MCut")
                    with gr.Row():
                        include_character_tags = gr.Checkbox(True, label=_("ui.include_character_tags"))
                        limit_tags = gr.Slider(0, 120, value=60, step=1, label=_("ui.limit_tags"), info=_("ui.limit_tags.info"))
                    vision_preset = gr.Dropdown(
                        _vision_preset_choices(),
                        value=DEFAULT_VISION_MODEL_PRESET,
                        label=_("ui.vision_preset"),
                        info=_("ui.vision_preset.info"),
                    )
                    with gr.Row():
                        lmcpp_endpoint = gr.Textbox(value="http://127.0.0.1:8080", label="lmcpp / OpenAI endpoint")
                        lmcpp_model = gr.Textbox(value=default_vision_alias, label=_("ui.model_name"), placeholder=_("ui.model_name.placeholder"))
                    nl_backend = gr.Radio(["Local GGUF once", "OpenAI endpoint"], value="Local GGUF once", label=_("ui.nl_backend"))
                    with gr.Group(visible=False) as endpoint_settings:
                        gr.Markdown(_("ui.endpoint_help"))
                    with gr.Group(visible=True) as local_gguf_settings:
                        gr.Markdown(_("ui.local_gguf_help"))
                        gguf_path = gr.Dropdown(
                            choices=gguf_choices,
                            value=default_vision_model or _preferred_choice(gguf_choices),
                            label=_("ui.gguf_path"),
                            allow_custom_value=True,
                        )
                        mmproj_path = gr.Dropdown(
                            choices=mmproj_choices,
                            value=default_vision_mmproj or _preferred_choice(mmproj_choices),
                            label=_("ui.mmproj_path"),
                            allow_custom_value=True,
                        )
                        llama_server_path = gr.Textbox(
                            value=find_default_llama_server(),
                            label=_("ui.llama_server_path"),
                        )
                        with gr.Row():
                            chat_format = gr.Textbox(value="", label="Chat format", placeholder=_("ui.chat_format.placeholder"))
                            n_ctx = gr.Slider(1024, 32768, value=DEFAULT_LOCAL_CONTEXT_TOKENS, step=1024, label="n_ctx")
                            n_gpu_layers = gr.Slider(-1, 200, value=-1, step=1, label="n_gpu_layers", info="-1 = 尽量上 GPU")
                    with gr.Row():
                        lmcpp_language = gr.Dropdown(["English", "中文"], value="English", label=_("ui.nl_language"))
                        lmcpp_max_tokens = gr.Slider(64, 1024, value=320, step=16, label="Max tokens")
                    with gr.Row():
                        lmcpp_temperature = gr.Slider(0, 1.5, value=0.55, step=0.05, label="Temperature")
                        lmcpp_top_p = gr.Slider(0.1, 1.0, value=0.9, step=0.05, label="Top P")
                        lmcpp_timeout = gr.Slider(5, 300, value=120, step=5, label="Timeout")
                        enable_thinking = gr.Checkbox(value=False, label=_("ui.thinking"), info=_("ui.thinking.info"))

        mode.change(fn=_mode_visibility, inputs=[mode], outputs=[krea_controls, krea_settings, wd_controls, wd_settings], show_progress=False)
        mode.change(fn=lambda selected: gr.update(visible=selected == "WD tagger + lmcpp"), inputs=[mode], outputs=[run_nl], show_progress=False)
        mode.change(fn=lambda selected: gr.update(visible=selected == "WD tagger + lmcpp"), inputs=[mode], outputs=[tags], show_progress=False)
        mode.change(fn=lambda selected: gr.update(visible=selected == "WD tagger + lmcpp"), inputs=[mode], outputs=[wd_output], show_progress=False)
        nl_backend.change(fn=_nl_backend_visibility, inputs=[nl_backend], outputs=[endpoint_settings, local_gguf_settings], show_progress=False)
        vision_preset.change(fn=_vision_preset_update, inputs=[vision_preset], outputs=[lmcpp_model, gguf_path, mmproj_path], show_progress=False)
        load_tagger.click(fn=_load_tagger, inputs=[tagger_model], outputs=[tagger_status], show_progress="full")
        unload_tagger.click(fn=_unload_tagger, outputs=[tagger_status], show_progress=False)
        run_tags.click(
            fn=_run_wd_tagger,
            inputs=[
                image,
                tagger_model,
                general_threshold,
                general_mcut,
                character_threshold,
                character_mcut,
                include_character_tags,
                limit_tags,
            ],
            outputs=[tags, characters, rating, raw_json, nl, output, status, live_log],
            show_progress="full",
        )
        run.click(
            fn=_run_reverse,
            inputs=[
                mode,
                image,
                task,
                guidance,
                prompt_template,
                language,
                max_side,
                max_tokens,
                temperature,
                top_k,
                top_p,
                repetition_penalty,
                seed,
                release_after,
                tagger_model,
                general_threshold,
                general_mcut,
                character_threshold,
                character_mcut,
                include_character_tags,
                limit_tags,
                nl_backend,
                lmcpp_endpoint,
                lmcpp_model,
                gguf_path,
                mmproj_path,
                llama_server_path,
                chat_format,
                n_ctx,
                n_gpu_layers,
                lmcpp_language,
                lmcpp_max_tokens,
                lmcpp_temperature,
                lmcpp_top_p,
                lmcpp_timeout,
                enable_thinking,
                combine_mode,
            ],
            outputs=[tags, characters, rating, raw_json, nl, output, status, live_log],
            show_progress="full",
        )
        run_nl.click(
            fn=_run_lmcpp_nl,
            inputs=[
                image,
                tags,
                characters,
                rating,
                guidance,
                prompt_template,
                nl_backend,
                lmcpp_endpoint,
                lmcpp_model,
                gguf_path,
                mmproj_path,
                llama_server_path,
                chat_format,
                n_ctx,
                n_gpu_layers,
                lmcpp_language,
                lmcpp_max_tokens,
                lmcpp_temperature,
                lmcpp_top_p,
                lmcpp_timeout,
                enable_thinking,
                combine_mode,
            ],
            outputs=[nl, output, status, live_log],
            show_progress="full",
        )
        combine.click(fn=_combine, inputs=[tags, nl, combine_mode], outputs=[output], show_progress=False)

        txt_prompt = PROMPT_COMPONENTS.get("txt2img_prompt")
        img_prompt = PROMPT_COMPONENTS.get("img2img_prompt")
        if txt_prompt is not None:
            send_txt.click(fn=lambda value: value, inputs=[output], outputs=[txt_prompt], show_progress=False)
        else:
            send_txt.visible = False
        if img_prompt is not None:
            send_img.click(fn=lambda value: value, inputs=[output], outputs=[img_prompt], show_progress=False)
        else:
            send_img.visible = False

    return [(interface, tr("ui.tab"), "qwen3vl_prompt_tools")]


script_callbacks.on_after_component(_after_component, name="qwen3vl-prompt-actions")
script_callbacks.on_app_started(_assistant_api, name="qwen3vl-prompt-assistant-api")
script_callbacks.on_ui_tabs(_ui_tab, name="qwen3vl-prompt-tab")
