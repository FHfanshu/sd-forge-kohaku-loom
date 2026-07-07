# Forge Neo Qwen3-VL Prompt Tools

Prompt reverse-engineering tools for Forge Neo.

The main workflow is `WD tagger + llama.cpp`: generate WD tags from an image, then use a local Qwen3.5 VLM GGUF to create an English natural-language prompt suitable for Anima-style image generation. The Krea2 / Qwen3-VL path is kept as a fallback.

## Features

- Reverse prompt tab for image-to-prompt workflows.
- WD tagger integration with character/rating/debug output.
- Local GGUF VLM backend through `llama-server.exe`.
- One-shot local backend mode: loads the model only for the request, then releases VRAM.
- OpenAI-compatible endpoint mode for batch/frequent reverse prompting.
- Auto-downloads the default HauhauCS Qwen3.5 9B uncensored GGUF and mmproj when missing.
- Auto-downloads a Windows x64 llama.cpp release backend when `llama-server.exe` is missing.
- Floating LLM prompt assistant for character layout, spatial relationships, and prompt rewriting.
- Prompt assistant can use DeepSeek/OpenAI-compatible APIs or a local llama.cpp endpoint.
- Prompt assistant can read and replace the current txt2img/img2img prompt through UI tools.
- Prompt assistant can read/write the WebUI style template / trigger-word template when the field is present.
- Prompt assistant image attachments are analyzed by local Qwen3.5 GGUF VLM first; the text LLM receives only the visual notes.

## Default Model

When local model paths are empty or missing, the extension downloads:

- `HauhauCS/Qwen3.5-9B-Uncensored-HauhauCS-Aggressive`
- `Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-Q6_K.gguf`
- `mmproj-Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-BF16.gguf`

Files are placed under:

```text
<Forge Neo>/models/LLM/Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-GGUF
```

## Backend

This extension does not install or depend on `llama-cpp-python` for Qwen3.5 inference. Forge Neo environments may ship an older binding that cannot load `qwen35` GGUF files. Instead, local one-shot inference uses an external `llama-server.exe` from a recent llama.cpp build.

If `llama-server.exe` is missing, the extension downloads the latest suitable Windows x64 zip from `ggml-org/llama.cpp` and extracts it to:

```text
<extension>/bin/llama.cpp
```

You can also set `LLAMA_SERVER_EXE` or fill the path manually in the UI.

## Modes

- `Local GGUF once`: best for occasional prompt reverse-engineering. Loads the model, runs one request, then closes the backend.
- `OpenAI endpoint`: best for many images. Start your own llama.cpp server and point the UI to it.

## Floating Prompt Assistant

The `LLM 助手` button opens a floating chat window. Defaults:

- Endpoint: `https://api.deepseek.com`
- Model: `deepseek-v4-pro`

DeepSeek requests use `thinking: {"type":"enabled"}` with `reasoning_effort: "high"` and `max_tokens: 8192` by default. Both max tokens and reasoning effort are configurable in the assistant settings.

Older `https://api.deepseek.com/v1` DeepSeek-style endpoints remain accepted; the assistant will append `/chat/completions` to whichever base you configure. Local llama.cpp/OpenAI-compatible endpoints still normally use `/v1`.

You can switch the assistant to `本地 llama.cpp endpoint` and reuse a running Hauhau/Qwen3.5 server, for example:

```text
http://127.0.0.1:8080/v1
hauhau-qwen3.5-9b-uncensored
```

The assistant is instructed to generate and revise image-generation prompts, especially multi-character spatial layouts such as left / center / right, foreground / background, interactions, and distinct per-character traits.

Use `附图` to attach a reference image. The extension first asks the local Qwen3.5 9B GGUF VLM to produce a detailed Chinese image caption with subject/spatial facts plus a subject-agnostic reusable style prompt, then sends those visual notes into the assistant conversation. The local VLM does not receive the user's chat text, so the image analysis is not biased by the editing request. This lets text-only remote models such as DeepSeek V4 Pro work from image references without receiving image data directly.

The model can request UI tools by returning exact JSON. The prompt-edit harness exposes only read and edit operations:

```json
{"tool":"read_prompt","arguments":{"target":"active"}}
```

```json
{"tool":"edit_prompt","arguments":{"target":"txt2img","base_hash":"prompt_hash from read_prompt","diff":"<<<<<<< SEARCH\nold exact text\n=======\nnew exact text\n>>>>>>> REPLACE"}}
```

`edit_prompt` is refused unless `read_prompt` has already read the same concrete target and `base_hash` matches the current prompt. If the user changes the prompt between read and edit, the edit is rejected and the assistant must read again.

```json
{"tool":"edit_prompt","arguments":{"target":"txt2img","base_hash":"fnv1a:...","diff":"<<<<<<< SEARCH\nleft character\n=======\nleft character holding a phone\n>>>>>>> REPLACE"}}
```

`edit_prompt` accepts SEARCH/REPLACE diff blocks first, plus simple unified diff hunks. It still accepts structured patch operations as a fallback: `replace`, `replace_all`, `replace_n`, `insert_after`, `insert_before`, `append`, `prepend`, and `delete`. `replace` and insert operations require a unique `find` string unless `allow_multiple` is set. Edit tools return a preview by default; pass `return_prompt: true` only when the full updated prompt is needed.

The frontend executes these tools and sends the result back to the assistant. Targets are `active`, `txt2img`, or `img2img`. `read_prompt` also includes the Forge `neta_template_positive` style template, using the settings component, global `opts`, or hidden `settings_json` as fallbacks.

## Notes

- The Anima style template intentionally outputs English.
- DeepSeek assistant thinking is enabled with high reasoning effort. Local Qwen3.5 VLM image analysis keeps thinking disabled to avoid spending the token budget in `reasoning_content` without producing final `content`.
- Downloaded GGUF models and llama.cpp binaries are ignored by git.
