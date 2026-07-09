# Forge Neo Qwen3-VL Prompt Tools

Prompt reverse-engineering tools for Forge Neo.

The main workflow is `WD tagger + llama.cpp`: generate WD tags from an image, then use a selectable local VLM GGUF to create an English natural-language prompt suitable for Anima-style image generation. The Krea2 / Qwen3-VL path is kept as a fallback.

## Features

- Reverse prompt tab for image-to-prompt workflows.
- WD tagger integration with character/rating/debug output.
- Local GGUF VLM backend through `llama-server.exe`.
- One-shot local backend mode: loads the model only for the request, then releases VRAM.
- OpenAI-compatible endpoint mode for batch/frequent reverse prompting.
- Auto-downloads the default HauhauCS Qwen3.5 9B uncensored GGUF and mmproj when missing.
- Auto-downloads a Windows x64 llama.cpp release backend when `llama-server.exe` is missing.
- Floating LLM prompt assistant for character layout, spatial relationships, and prompt rewriting.
- Prompt assistant defaults to the best evaluated OpenAI-compatible remote preset, and can also use DeepSeek, Gemini native APIs, or local llama.cpp backends.
- Prompt assistant can read and replace the current txt2img/img2img prompt through UI tools.
- Prompt assistant can read/write the WebUI style template / trigger-word template when the field is present.
- Prompt assistant image attachments and sensitive prompt context can be processed by the local Qwen GGUF first; Gemini receives only a teacher-safe briefing by default.

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

The `LLM 助手` button opens a floating chat window. Text-assistant defaults:

- Remote preset: `gemini-3.5-flash-preview`
- Base URL: configurable in the settings panel
- Local fallback preset: `Qwen3.5 原版 9B`

OpenAI-compatible remote presets keep the Base URL separate from the selected model, so the same presets can be used with any compatible relay. Moyuu Gemini native mode remains available for Gemini `v1beta` `generateContent` / `streamGenerateContent`. The assistant status line streams token counters in the form `↑input tokens ↓output tokens`; final Gemini `usageMetadata` replaces the local estimate when the endpoint provides it. Before text is sent to Gemini native mode, sensitive prompt fragments are replaced with `SAFE_SLOT_###` placeholders and restored locally in the returned tool arguments, so `edit_prompt` still patches the real WebUI prompt while Gemini sees a safer prompt.

Older `https://api.deepseek.com/v1` DeepSeek-style endpoints remain accepted; the assistant will append `/chat/completions` to whichever base you configure. Local llama.cpp/OpenAI-compatible endpoints still normally use `/v1`.

You can switch the text assistant to `DeepSeek`, `Moyuu Gemini native`, `本地 Qwen 一次性`, or `本地 llama.cpp endpoint`. The remote preset menu contains the top evaluated editing models: `gemini-3.5-flash-preview`, `gemini-3.5-flash-high`, and `grok-4.5`; changing the preset updates the model without overwriting the Base URL. `本地 Qwen 一次性` starts a local llama.cpp server for one assistant request and then terminates it, releasing VRAM instead of keeping a resident session. The local VLM/text fallback uses `Qwen3.5 原版 9B` by default, with presets for `Gemma 4 12B`, `Qwen3.5 原版 9B`, `Qwen3.5 破限版 9B`, plus `自定义`. The local VLM thinking switch is optional and off by default.

The floating settings panel keeps common controls visible by default. API keys are stored per text provider, so switching between Moyuu and DeepSeek does not overwrite the other provider's key. Endpoint/model/path overrides are under `高级` and are hidden unless relevant.

For disposable remote testing, the backend also reads `Q3VL_MOYUU_API_KEY`, `MOYUU_API_KEY`, `GEMINI_API_KEY`, or `GOOGLE_API_KEY` when the UI API key field is empty.

For local text-assistant testing, an endpoint can still be configured, for example:

```text
http://127.0.0.1:8080/v1
hauhau-qwen3.5-9b-uncensored
```

The assistant is instructed to generate and revise image-generation prompts, especially multi-character spatial layouts such as left / center / right, foreground / background, interactions, and distinct per-character traits.

Use `附图` to attach a reference image. In the default Gemini teacher mode, the image stays local: the selected local Qwen/GGUF VLM produces visual notes and a redacted teacher briefing before Gemini is called. If you switch the advanced teacher mode to `仅占位符脱敏`, Gemini can use the older native multimodal path.

The model can request UI tools by returning exact JSON. The prompt-edit harness exposes only read and edit operations:

Local Qwen can also consult the remote Gemini teacher through `ask_teacher` after it has produced a sanitized question/context:

```json
{"tool":"ask_teacher","arguments":{"question":"How can this composition be improved?","context":"SAFE_SLOT_001, left/right character layout, dramatic rim light"}}
```

The `ask_teacher` tool calls `/qwen3vl-prompt-tools/ask-teacher`; the teacher-side Gemini request disables further tool calls to avoid recursion.

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

The frontend executes these tools and sends the result back to the assistant. Targets are `active`, `txt2img`, or `img2img`. `read_prompt` also includes the current `txt2img_styles` / `img2img_styles` selector text as `style_selector`, maps selected style names to full prompt text in `selected_styles`, and includes Forge `neta_template_positive` as `forge_positive_template` using the settings component, global `opts`, or hidden `settings_json` as fallbacks.

On mobile generation pages, the extension disables browser pull-to-refresh so a downward swipe at the top of txt2img/img2img does not reload the whole WebUI. For assistant edit requests, the frontend also refuses to treat a no-tool response as completion until `edit_prompt` has returned `ok:true`.

The prompt editor rejects final prompt text that still contains git diff or patch residue such as `diff --git`, `@@`, `--- a/...`, `+++ b/...`, SEARCH/REPLACE markers, conflict markers, or fenced diff blocks. Diff syntax is accepted only as `edit_prompt` input, not as WebUI prompt content.

### External assistant workflow

Python callers can reuse the same prompt-edit loop without copying frontend glue code:

```python
from lib_qwen3vl_prompt_tools import PromptToolHarness, prompt_edit_messages, run_assistant_loop

base_payload = {
    "backend": "local-qwen-once",
    "vision_preset": "Qwen3.5 破限版 9B",
    "llama_server_path": r"E:\AI\lmcpp\llama.cpp\llama-server.exe",
}
harness = PromptToolHarness("two characters, left character, right character")
result = run_assistant_loop(base_payload, "把当前提示词里的 left character 改成 front character", harness)
print(result["prompt_edited"], harness.prompt)
```

For model comparisons, `build_prompt_edit_eval_payloads()` creates one remote baseline, any number of local `local-qwen-once` payloads, extra remote model cases, and an optional DeepSeek case from the same messages.

The same loop is available as a local benchmark helper:

```powershell
python tools\assistant_workload_eval.py --prompt-file .\workload_prompt.txt --request "给当前提示词加上黑框眼镜，然后调换两个角色的位置"
```

The default local matrix is `Qwen3.5 原版 9B`, `Qwen3.5 破限版 9B`, and `Gemma 4 12B`. Add `--remote-model MODEL_NAME` for each remote model, and set `Q3VL_MOYUU_API_KEY` for those cases. Use `--remote-backend openai` when a Moyuu-hosted model should use the OpenAI-compatible `/v1/chat/completions` route, such as mixed Gemini/Grok model sweeps. Add `--include-deepseek` when `DEEPSEEK_API_KEY` is set. Add `--show-prompt` only when you explicitly want final prompt text printed.

## Notes

- The Anima style template intentionally outputs English.
- DeepSeek assistant thinking is enabled with high reasoning effort. Local VLM image analysis exposes a separate optional thinking switch; keep it off if the model spends the token budget in `reasoning_content` without producing final `content`.
- Downloaded GGUF models and llama.cpp binaries are ignored by git.
