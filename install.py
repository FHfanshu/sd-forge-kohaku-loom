from pathlib import Path

import launch


requirements = Path(__file__).parent / "requirements.txt"
if not launch.is_installed("openai") or not launch.is_installed("google.genai"):
    launch.run_pip(f'install -r "{requirements}"', "remote SDKs for Qwen3-VL Prompt Tools")
