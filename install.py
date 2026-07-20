from pathlib import Path

import launch


requirements = Path(__file__).parent / "requirements.txt"
if not launch.is_installed("httpx"):
    launch.run_pip(f'install -r "{requirements}"', "Prompt Agent provider proxy")
