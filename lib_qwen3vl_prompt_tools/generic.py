from __future__ import annotations

# Compatibility facade. New code should import from the focused modules below.

from .assistant import ask_teacher, prompt_assistant_chat, prompt_assistant_stream
from .assistant_common import (
    _assistant_chat_url,
    _assistant_estimate_tokens,
    _assistant_request_messages,
    _assistant_stream_event,
    _extract_tool_calls,
)
from .assistant_gemini import (
    _PromptSanitizer,
    _assistant_remote_endpoints,
    _assistant_use_gemini_native,
    _data_url_inline_data,
    _gemini_contents,
    _gemini_empty_response_detail,
    _gemini_headers,
    _gemini_post_generate,
    _gemini_request_body,
    _gemini_response_parts,
    _gemini_result_from_data,
    _gemini_text_parts_from_content,
    _gemini_tools,
    _gemini_url,
    _gemini_usage,
    _prompt_assistant_chat_gemini,
    _prompt_assistant_stream_gemini,
    _restore_gemini_result,
)
from .assistant_local import _prompt_assistant_chat_local_once
from .constants import (
    ASSISTANT_TOOLS,
    DEFAULT_ASSISTANT_ENDPOINT,
    DEFAULT_ASSISTANT_FALLBACK_ENDPOINT,
    DEFAULT_ASSISTANT_MODEL,
    DEFAULT_GGUF_DIR,
    DEFAULT_GGUF_MMPROJ,
    DEFAULT_GGUF_MODEL,
    DEFAULT_GGUF_REPO,
    DEFAULT_LLAMA_SERVER_CANDIDATES,
    DEFAULT_LOCAL_ASSISTANT_ENDPOINT,
    DEFAULT_LOCAL_ASSISTANT_MODEL,
    DEFAULT_LOCAL_TEXT_PRESET,
    DEFAULT_VISION_MODEL_PRESET,
    KAOMOJI_TAGS,
    LABEL_FILENAME,
    LLAMA_CPP_RELEASE_API,
    MODEL_FILENAME,
    NL_PROMPT_TEMPLATES,
    PROMPT_ASSISTANT_SYSTEM,
    REFERENCE_IMAGE_ANALYSIS_SYSTEM,
    REFERENCE_IMAGE_STYLE_PROMPT,
    STYLE_EXTRACTION_TEMPLATE,
    TAGGER_MODELS,
    VISION_MODEL_PRESET_CUSTOM,
    VISION_MODEL_PRESETS,
)
from .image_payloads import _image_data_url, _image_from_data_url
from .llama_runtime import _free_port, _local_endpoint_ready, _post_local_chat, _wait_server
from .model_paths import (
    _download_hf_file,
    _download_url,
    _extension_root,
    _find_first_gguf,
    _find_related_mmproj,
    _forge_root,
    _llama_cpp_bin_dir,
    _llm_search_roots,
    _safe_extract_zip,
    _select_llama_cpp_windows_asset,
    download_llama_server,
    ensure_local_gguf_pair,
    find_default_llama_server,
    find_vision_preset_files,
    resolve_llama_server,
    resolve_vision_model_pair,
    vision_preset_alias,
)
from .reference_image import _reference_image_messages, analyze_reference_image
from .response_text import (
    _clean_response_text,
    _extract_message_text,
    _mojibake_score,
    _repair_mojibake_text,
    _response_json_utf8,
    _response_text_utf8,
)
from .tagger import TAGGER, TaggerResult, WDTagger, _load_labels, _mcut_threshold, repo_from_label
from .text_prompting import (
    _nl_messages,
    _postprocess_prompt,
    _prompt_messages,
    _strip_subject_placeholders,
    build_nl_from_endpoint,
    build_nl_from_local_gguf,
    combine_prompt,
)
from .utils import _payload_bool
