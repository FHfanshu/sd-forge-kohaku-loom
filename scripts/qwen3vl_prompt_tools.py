from __future__ import annotations

from pathlib import Path

import gradio as gr

from lib_qwen3vl_prompt_tools.generation import caption, enhance
from lib_qwen3vl_prompt_tools.generic import (
    TAGGER,
    TAGGER_MODELS,
    build_nl_from_endpoint,
    build_nl_from_local_gguf,
    combine_prompt,
    find_default_llama_server,
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


def _after_component(component, **kwargs):
    elem_id = kwargs.get("elem_id")
    if elem_id not in {"txt2img_prompt", "img2img_prompt"}:
        return
    if elem_id in PROMPT_COMPONENTS:
        return

    PROMPT_COMPONENTS[elem_id] = component
    with gr.Row(elem_classes=["q3vl-inline-actions"]):
        gr.HTML("<span class='q3vl-inline-label'>Qwen3-VL</span>")
        refine = gr.Button("精炼", size="sm", variant="secondary")
        expand = gr.Button("扩写", size="sm", variant="secondary")
        stylize = gr.Button("风格化", size="sm", variant="secondary")

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


def _ui_tab():
    gguf_choices = _llm_choices("model")
    mmproj_choices = _llm_choices("mmproj")
    with gr.Blocks(analytics_enabled=False) as interface:
        with gr.Column(elem_id="q3vl-workbench"):
            gr.HTML(
                "<div class='q3vl-heading'><div><span class='q3vl-kicker'>IMAGE TO PROMPT</span>"
                "<h1>把图像读回提示词</h1><p>默认用 WD tagger + llama.cpp 生成 tags 和 NL；Krea2/Qwen3-VL 保留为备用模式。</p></div>"
                "<div class='q3vl-rail' aria-hidden='true'></div></div>"
            )
            mode = gr.Radio(["WD tagger + lmcpp", "Krea2 / Qwen3-VL"], value="WD tagger + lmcpp", label="反推模式")
            with gr.Row(equal_height=False, elem_classes=["q3vl-grid"]):
                with gr.Column(scale=5, min_width=320, elem_classes=["q3vl-panel"]):
                    image = gr.Image(type="pil", label="参考图像", height=430, sources=["upload", "clipboard"])
                    with gr.Group(visible=False) as krea_controls:
                        task = gr.Radio(list(CAPTION_TASKS), value="完整反推", label="读取重点")
                    with gr.Group(visible=True) as wd_controls:
                        tagger_model = gr.Dropdown(list(TAGGER_MODELS), value="WD EVA02 large v3", label="Tagger 模型")
                        with gr.Row():
                            load_tagger = gr.Button("加载/下载 tagger", variant="secondary")
                            unload_tagger = gr.Button("释放 tagger", variant="secondary")
                        tagger_status = gr.Textbox(label="Tagger 状态", interactive=False)
                    guidance = gr.Textbox(
                        label="额外要求",
                        placeholder="例如：重点描述服装剪裁；输出 Anima 可用 prompt；保留画面中的英文文字……",
                        lines=2,
                    )
                    prompt_template = gr.Dropdown(
                        PROMPT_TEMPLATE_CHOICES,
                        value="美学风格抽取（Anima 英文）",
                        label="提示词模板",
                    )
                    with gr.Row():
                        run = gr.Button("开始反推", variant="primary", elem_classes=["q3vl-run"])
                        run_tags = gr.Button("仅打 Tags", variant="secondary", visible=True)
                        run_nl = gr.Button("生成 NL", variant="secondary", visible=True)
                    live_log = gr.Textbox(label="实时 log", lines=7, interactive=False, elem_classes=["q3vl-live-log"])
                with gr.Column(scale=6, min_width=360, elem_classes=["q3vl-panel", "q3vl-output-panel"]):
                    tags = gr.Textbox(label="Tags", lines=6, show_copy_button=True, visible=True)
                    with gr.Group(visible=True) as wd_output:
                        with gr.Row():
                            characters = gr.Textbox(label="Characters", lines=2, show_copy_button=True)
                            rating = gr.Textbox(label="Rating", lines=2)
                        nl = gr.Textbox(label="Natural language", lines=7, show_copy_button=True)
                        combine_mode = gr.Radio(["Tags + NL", "Tags only", "NL only"], value="Tags + NL", label="合并格式")
                        combine = gr.Button("合并输出", variant="secondary")
                        with gr.Accordion("Tag scores / debug", open=False):
                            raw_json = gr.Code(label="Tag scores JSON", language="json", lines=7)
                    output = gr.Textbox(label="反推结果", placeholder="结果会出现在这里。你可以直接修改，再发送到生成页。", lines=12, show_copy_button=True)
                    status = gr.HTML("<span class='q3vl-status-idle'>等待图像</span>")
                    with gr.Row():
                        send_txt = gr.Button("发送到 txt2img", variant="secondary")
                        send_img = gr.Button("发送到 img2img", variant="secondary")

            with gr.Group(visible=False) as krea_settings:
                with gr.Accordion("Krea2 / Qwen3-VL 设置", open=False):
                    with gr.Row():
                        language = gr.Dropdown(["English", "中文"], value="English", label="输出语言")
                        max_side = gr.Slider(448, 1344, value=768, step=64, label="视觉分辨率上限", info="越高越能读取细节，也越慢")
                        max_tokens = gr.Slider(64, 768, value=320, step=16, label="最大输出 tokens")
                    with gr.Row():
                        temperature = gr.Slider(0, 1.5, value=0.65, step=0.05, label="Temperature")
                        top_k = gr.Slider(0, 100, value=20, step=1, label="Top K")
                        top_p = gr.Slider(0.1, 1.0, value=0.85, step=0.05, label="Top P")
                        repetition_penalty = gr.Slider(1.0, 1.3, value=1.05, step=0.01, label="重复惩罚")
                    with gr.Row():
                        seed = gr.Number(value=42, precision=0, label="Seed")
                        release_after = gr.Checkbox(value=True, label="完成后释放模型显存", info="推荐 24GB 显卡开启")

            with gr.Group(visible=True) as wd_settings:
                with gr.Accordion("WD tagger + lmcpp 设置", open=True):
                    with gr.Row():
                        general_threshold = gr.Slider(0, 1, value=0.5, step=0.01, label="General threshold")
                        general_mcut = gr.Checkbox(False, label="General MCut")
                    with gr.Row():
                        character_threshold = gr.Slider(0, 1, value=0.85, step=0.01, label="Character threshold")
                        character_mcut = gr.Checkbox(False, label="Character MCut")
                    with gr.Row():
                        include_character_tags = gr.Checkbox(True, label="把角色 tag 放入 tags")
                        limit_tags = gr.Slider(0, 120, value=60, step=1, label="最多 general tags", info="0 = 不限制")
                    with gr.Row():
                        lmcpp_endpoint = gr.Textbox(value="http://127.0.0.1:8080", label="lmcpp / OpenAI endpoint")
                        lmcpp_model = gr.Textbox(value="", label="Model 名称", placeholder="留空让服务端默认，比如 uncensored qwen3.5")
                    nl_backend = gr.Radio(["Local GGUF once", "OpenAI endpoint"], value="Local GGUF once", label="NL 后端")
                    with gr.Group(visible=False) as endpoint_settings:
                        gr.Markdown("批量/频繁反推时使用：连接已经运行的 llama.cpp server，避免每次重新加载模型，但会常驻占用显存。")
                    with gr.Group(visible=True) as local_gguf_settings:
                        gr.Markdown(
                            "兼容兜底：Forge Neo 当前 llama-cpp-python 太旧，不能直接加载 qwen35 GGUF；"
                            "此模式会临时启动下面的新版 llama-server.exe，完成后自动关闭并释放显存，适合偶尔反推。"
                        )
                        gguf_path = gr.Dropdown(
                            choices=gguf_choices,
                            value=_preferred_choice(gguf_choices),
                            label="GGUF 模型路径",
                            allow_custom_value=True,
                        )
                        mmproj_path = gr.Dropdown(
                            choices=mmproj_choices,
                            value=_preferred_choice(mmproj_choices),
                            label="mmproj 路径",
                            allow_custom_value=True,
                        )
                        llama_server_path = gr.Textbox(
                            value=find_default_llama_server(),
                            label="llama-server.exe 路径",
                        )
                        with gr.Row():
                            chat_format = gr.Textbox(value="", label="Chat format", placeholder="留空自动读取；需要时可填 qwen")
                            n_ctx = gr.Slider(1024, 32768, value=4096, step=1024, label="n_ctx")
                            n_gpu_layers = gr.Slider(-1, 200, value=-1, step=1, label="n_gpu_layers", info="-1 = 尽量上 GPU")
                    with gr.Row():
                        lmcpp_language = gr.Dropdown(["English", "中文"], value="English", label="NL 语言")
                        lmcpp_max_tokens = gr.Slider(64, 1024, value=320, step=16, label="Max tokens")
                    with gr.Row():
                        lmcpp_temperature = gr.Slider(0, 1.5, value=0.55, step=0.05, label="Temperature")
                        lmcpp_top_p = gr.Slider(0.1, 1.0, value=0.9, step=0.05, label="Top P")
                        lmcpp_timeout = gr.Slider(5, 300, value=120, step=5, label="Timeout")
                        enable_thinking = gr.Checkbox(value=False, label="启用 thinking", info="可手动开启；若只返回 reasoning 或超时，请关闭。")

        mode.change(fn=_mode_visibility, inputs=[mode], outputs=[krea_controls, krea_settings, wd_controls, wd_settings], show_progress=False)
        mode.change(fn=lambda selected: gr.update(visible=selected == "WD tagger + lmcpp"), inputs=[mode], outputs=[run_nl], show_progress=False)
        mode.change(fn=lambda selected: gr.update(visible=selected == "WD tagger + lmcpp"), inputs=[mode], outputs=[tags], show_progress=False)
        mode.change(fn=lambda selected: gr.update(visible=selected == "WD tagger + lmcpp"), inputs=[mode], outputs=[wd_output], show_progress=False)
        nl_backend.change(fn=_nl_backend_visibility, inputs=[nl_backend], outputs=[endpoint_settings, local_gguf_settings], show_progress=False)
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

    return [(interface, "反推提示词", "qwen3vl_prompt_tools")]


script_callbacks.on_after_component(_after_component, name="qwen3vl-prompt-actions")
script_callbacks.on_ui_tabs(_ui_tab, name="qwen3vl-prompt-tab")
