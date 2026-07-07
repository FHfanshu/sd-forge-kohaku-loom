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

Older `https://api.deepseek.com/v1` DeepSeek-style endpoints remain accepted; the assistant will append `/chat/completions` to whichever base you configure. Local llama.cpp/OpenAI-compatible endpoints still normally use `/v1`.

You can switch the assistant to `本地 llama.cpp endpoint` and reuse a running Hauhau/Qwen3.5 server, for example:

```text
http://127.0.0.1:8080/v1
hauhau-qwen3.5-9b-uncensored
```

The assistant is instructed to generate and revise image-generation prompts, especially multi-character spatial layouts such as left / center / right, foreground / background, interactions, and distinct per-character traits.

Use `附图` to attach a reference image. The extension starts the default local Qwen3.5 9B GGUF VLM once, extracts composition/style notes, releases the local process, then sends those notes into the assistant conversation. This lets text-only remote models such as DeepSeek V4 Pro work from image references without receiving image data directly.

The model can request UI tools by returning exact JSON:

```json
{"tool":"get_current_prompt","arguments":{"target":"active"}}
```

```json
{"tool":"set_current_prompt","arguments":{"target":"txt2img","prompt":"..."}}
```

For existing prompts, prefer precise patch tools instead of whole-prompt replacement:

```json
{"tool":"patch_current_prompt","arguments":{"target":"active","patch":{"operation":"replace","find":"old phrase","replace":"new phrase"}}}
```

```json
{"tool":"multi_patch_current_prompt","arguments":{"target":"txt2img","patches":[{"operation":"replace","find":"left character","replace":"left character holding a phone"},{"operation":"append","separator":"space","text":"clear left / center / right spacing"}]}}
```

Patch operations: `replace`, `replace_all`, `replace_n`, `insert_after`, `insert_before`, `append`, `prepend`, and `delete`. `replace` and insert operations require a unique `find` string unless `allow_multiple` is set. Patch tools return a preview by default; pass `return_prompt: true` only when the full updated prompt is needed.

```json
{"tool":"get_style_template","arguments":{}}
```

```json
{"tool":"set_style_template","arguments":{"template":"..."}}
```

The frontend executes these tools and sends the result back to the assistant. Targets are `active`, `txt2img`, or `img2img`. `get_current_prompt` also includes the WebUI style template when the field can be found by label, such as `风格模版` / `风格模板`.

## Notes

- The Anima style template intentionally outputs English.
- `thinking` is optional and disabled by default because Qwen3.5 VLM may spend the token budget in `reasoning_content` without producing final `content`.
- Downloaded GGUF models and llama.cpp binaries are ignored by git.
