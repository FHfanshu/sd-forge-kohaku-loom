from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from kohaku_loom.assistant_workflow import (  # noqa: E402
    PromptToolHarness,
    build_prompt_edit_eval_payloads,
    prompt_edit_messages,
    run_assistant_loop,
)


DEFAULT_LOCAL_MODELS = [
    {
        "name": "qwen3.5-9b-original",
        "vision_preset": "Qwen3.5 原版 9B",
        "model_path": r"E:\AI\lmcpp\models\Qwen3.5-9B-GGUF\Qwen3.5-9B-UD-Q6_K_XL.gguf",
    },
    {
        "name": "qwen3.5-9b-uncensored",
        "vision_preset": "Qwen3.5 破限版 9B",
        "model_path": r"E:\AI\lmcpp\models\Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-GGUF\Qwen3.5-9B-Uncensored-HauhauCS-Aggressive-Q6_K.gguf",
    },
    {
        "name": "gemma-4-12b-it",
        "vision_preset": "Gemma 4 12B",
        "model_path": r"E:\AI\lmcpp\models\gemma-4-12b-it-UD-Q8_K_XL.gguf",
    },
]


def main() -> int:
    parser = argparse.ArgumentParser(description="Run prompt-assistant edit workload cases through the reusable workflow loop.")
    parser.add_argument("--prompt-file", required=True, help="UTF-8 file containing the current prompt to edit.")
    parser.add_argument("--request", required=True, help="User edit request, for example: 给当前提示词加上黑框眼镜。")
    parser.add_argument("--base-payload", default="", help="Optional JSON file with shared payload settings.")
    parser.add_argument("--llama-server-path", default=r"E:\AI\lmcpp\llama.cpp\llama-server.exe")
    parser.add_argument("--include-remote", action="store_true", help="Include the base remote payload case.")
    parser.add_argument("--remote-model", action="append", default=[], help="Remote model to evaluate. Can be passed multiple times.")
    parser.add_argument("--remote-endpoint", default="https://moyuu.cc", help="Endpoint for --remote-model cases.")
    parser.add_argument("--remote-api-key-env", default="KOHAKU_LOOM_MOYUU_API_KEY", help="Environment variable that holds the remote API key.")
    parser.add_argument("--remote-backend", default="", help="Override backend for --remote-model cases, for example openai.")
    parser.add_argument("--include-deepseek", action="store_true", help="Include DeepSeek when DEEPSEEK_API_KEY is available.")
    parser.add_argument("--allow-missing-remote-key", action="store_true", help="Keep remote cases even when the API key env var is missing.")
    parser.add_argument("--timeout", type=int, default=240)
    parser.add_argument("--max-turns", type=int, default=6)
    parser.add_argument("--show-prompt", action="store_true", help="Print final prompts. Off by default to keep logs clean.")
    args = parser.parse_args()

    prompt = Path(args.prompt_file).read_text(encoding="utf-8")
    base_payload = _read_payload(args.base_payload)
    base_payload.setdefault("teacher_mode", "regex")
    base_payload.setdefault("timeout", args.timeout)
    base_payload.setdefault("temperature", 0.2)
    base_payload.setdefault("top_p", 0.9)
    base_payload.setdefault("max_tokens", 4096)
    base_payload.setdefault("llama_server_path", args.llama_server_path)

    local_models = [item for item in DEFAULT_LOCAL_MODELS if Path(item["model_path"]).exists()]
    remote_api_key = os.environ.get(args.remote_api_key_env, "").strip()
    remote_models = [
        {
            "model": model,
            "endpoint": args.remote_endpoint,
            "api_key": remote_api_key,
            **({"backend": args.remote_backend} if args.remote_backend else {}),
        }
        for model in args.remote_model
        if model.strip()
    ]
    messages = prompt_edit_messages(args.request)
    cases = build_prompt_edit_eval_payloads(base_payload, messages, local_models, remote_models, include_deepseek=args.include_deepseek)
    if not args.include_remote:
        cases = [case for case in cases if case.get("case_kind") != "base"]
    if args.remote_model and not remote_api_key and not args.allow_missing_remote_key:
        cases = [case for case in cases if case.get("case_kind") != "remote"]
    if args.include_deepseek and not os.environ.get("DEEPSEEK_API_KEY"):
        cases = [case for case in cases if case.get("backend") != "deepseek"]

    rows = []
    for case in cases:
        harness = PromptToolHarness(prompt)
        started = time.perf_counter()
        row: dict[str, Any] = {
            "case_name": case.get("case_name"),
            "case_kind": case.get("case_kind"),
            "backend": case.get("backend"),
            "model": case.get("local_model_path") or case.get("model"),
        }
        try:
            result = run_assistant_loop(case, args.request, harness, messages=messages, max_turns=args.max_turns, force_prompt_edit=True, stop_after_edit=True)
            tool_errors = [
                item.get("result", {}).get("error")
                for item in result.get("tool_results", [])
                if isinstance(item.get("result"), dict) and item.get("result", {}).get("error")
            ]
            row.update(
                {
                    "ok": bool(result.get("ok")),
                    "prompt_edited": bool(result.get("prompt_edited")),
                    "tool_sequence": [item.get("tool") for item in result.get("tool_results", [])],
                    "tool_errors": tool_errors,
                    "error": result.get("error", ""),
                }
            )
            if args.show_prompt:
                row["final_prompt"] = harness.prompt
        except Exception as exc:  # noqa: BLE001
            row.update({"ok": False, "prompt_edited": False, "tool_sequence": [], "tool_errors": [], "error": str(exc)})
        row["elapsed_seconds"] = round(time.perf_counter() - started, 2)
        rows.append(row)
        print(json.dumps(row, ensure_ascii=False), flush=True)

    print(json.dumps({"cases": rows}, ensure_ascii=False, indent=2))
    return 0 if rows and all(row.get("ok") for row in rows) else 1


def _read_payload(path: str) -> dict[str, Any]:
    if not path:
        return {"backend": "moyuu", "endpoint": "https://moyuu.cc", "model": "gemini-3.1-pro-high"}
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError("--base-payload must point to a JSON object")
    return value


if __name__ == "__main__":
    raise SystemExit(main())
