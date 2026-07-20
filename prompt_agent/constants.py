from __future__ import annotations

from typing import Any

DEFAULT_GGUF_REPO = "HauhauCS/Qwen3.5-9B-Uncensored-HauhauCS-Aggressive"
DEFAULT_GGUF_DIR = "Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-GGUF"
DEFAULT_GGUF_MODEL = "Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-Q6_K.gguf"
DEFAULT_GGUF_MMPROJ = "mmproj-Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-BF16.gguf"
DEFAULT_LLAMA_SERVER_CANDIDATES: list[str] = []
LLAMA_CPP_RELEASE_API = "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest"
DEFAULT_LOCAL_CONTEXT_TOKENS = 16384
VISION_MODEL_PRESET_CUSTOM = "自定义"
DEFAULT_VISION_MODEL_PRESET = "Qwen3.5 原版 9B"
VISION_MODEL_PRESETS: dict[str, dict[str, Any]] = {
    "Gemma 4 12B": {
        "alias": "gemma-4-12b-it",
        "model_globs": [
            "gemma-4-12b-it-UD-Q8_K_XL.gguf",
            "**/gemma-4-12b-it-UD-Q8_K_XL.gguf",
            "**/*gemma*4*12b*it*.gguf",
        ],
        "mmproj_globs": [
            "mmproj-gemma-4-12B-it-BF16.gguf",
            "**/mmproj-gemma-4-12B-it-BF16.gguf",
            "mmproj-BF16.gguf",
            "**/*gemma*mmproj*.gguf",
            "**/*mmproj*gemma*.gguf",
            "**/mmproj-BF16.gguf",
        ],
        "auto_download": False,
    },
    "Qwen3.5 原版 9B": {
        "alias": "qwen3.5-9b-vlm",
        "model_globs": [
            "Qwen3.5-9B-GGUF/Qwen3.5-9B-UD-Q6_K_XL.gguf",
            "**/Qwen3.5-9B-GGUF/Qwen3.5-9B-UD-Q6_K_XL.gguf",
            "**/Qwen3.5-9B-UD-Q6_K_XL.gguf",
        ],
        "mmproj_globs": [
            "Qwen3.5-9B-GGUF/mmproj-F16.gguf",
            "**/Qwen3.5-9B-GGUF/mmproj-F16.gguf",
            "**/mmproj-F16.gguf",
        ],
        "auto_download": False,
    },
    "Qwen3.5 破限版 9B": {
        "alias": "hauhau-qwen3.5-9b-uncensored",
        "model_globs": [
            "Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-GGUF/Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-Q6_K.gguf",
            "**/Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-Q6_K.gguf",
        ],
        "mmproj_globs": [
            "Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-GGUF/mmproj-Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-BF16.gguf",
            "**/mmproj-Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-BF16.gguf",
        ],
        "auto_download": True,
    },
}

REFERENCE_IMAGE_ANALYSIS_SYSTEM = """你是一名本地图像视觉分析子代理，只根据输入图片本身工作。

不要参考用户聊天文字，不要延展用户意图。输出需要同时包含精确的图像内容 caption 和可复用的风格描述，供后续文本模型整合提示词。"""

REFERENCE_IMAGE_STYLE_PROMPT = """请作为一名顶级的 AI 绘画提示词专家，为我分析这张图片。

任务目标：输出两部分信息，第一部分是精确详尽的图像 caption，第二部分是剥离主体后的通用风格 Prompt。你只能根据图片本身描述，不要引入用户额外要求。

第一部分：图像内容详述（必须保留主体）
- 客观描述画面中可见的主体数量、外观差异、服装/道具、表情、姿态、视线、动作、互动关系。
- 精确描述空间关系与构图：左/中/右、前景/中景/背景、遮挡、距离、透视、镜头角度、裁切、画幅、主体占比。
- 描述场景环境、背景元素、可见文字/符号、材质、光源方向、阴影和色彩关系。
- 这一部分必须保留原图中的具体主体内容，因为它用于后续上下文理解。不要把主体替换成占位符，不要省略主体身份、数量、外观、位置和互动。

第二部分：通用风格 Prompt
- 提取并反推这张图片的艺术风格，生成一份通用的 Prompt。
- 这一部分必须剥离原图中的具体角色、文字、身份或特定情节，仅保留其美学灵魂。

分析维度（请务必涵盖以下 15 个方面）：
基础维度：画面风格、画面成分组成、构图方式、分镜类型、光影特质、色调与色彩科学、媒介与材质纹理、情绪与氛围、渲染/拍摄参数。
进阶维度：时代感与文化语境、空间逻辑与透视关系、信息密度与留白、动态状态（瞬时感）、后期处理与数字痕迹、符号化特征。

输出要求：
1. 使用中文输出。
2. 请按以下两个标题输出：
【图像内容详述】
【通用风格 Prompt】
3. 【图像内容详述】要具体、细致、保留主体、可用于还原空间关系。
4. 【通用风格 Prompt】必须在开头或核心位置使用“[在此处替换为您想要生成的主体内容]”作为占位符。
5. 【通用风格 Prompt】要高度通用，用户只需更换占位符内容，即可在保持原图质感的同时生成全新的画面。
6. 不要输出推理过程、免责声明或与图片无关的内容。"""
