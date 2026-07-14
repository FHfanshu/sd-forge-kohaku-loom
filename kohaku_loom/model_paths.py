from __future__ import annotations

import json
import os
import shutil
import urllib.request
import zipfile
from pathlib import Path

import huggingface_hub

from .constants import (
    DEFAULT_GGUF_DIR,
    DEFAULT_GGUF_MMPROJ,
    DEFAULT_GGUF_MODEL,
    DEFAULT_GGUF_REPO,
    DEFAULT_LLAMA_SERVER_CANDIDATES,
    DEFAULT_VISION_MODEL_PRESET,
    LLAMA_CPP_RELEASE_API,
    VISION_MODEL_PRESET_CUSTOM,
    VISION_MODEL_PRESETS,
)

def _llm_search_roots() -> list[Path]:
    raw_roots = [
        os.environ.get("LLM_MODEL_DIR", ""),
        str(_forge_root() / "models" / "LLM"),
        r"E:\AI\lmcpp\models",
        r"E:\AI\models\LLM",
    ]
    roots: list[Path] = []
    seen: set[str] = set()
    for raw in raw_roots:
        if not raw:
            continue
        path = Path(raw).expanduser()
        try:
            key = str(path.resolve()).lower()
        except OSError:
            key = str(path).lower()
        if key in seen or not path.exists():
            continue
        seen.add(key)
        roots.append(path)
    return roots


def _find_first_gguf(patterns: list[str]) -> str:
    for root in _llm_search_roots():
        for pattern in patterns:
            matches = sorted(root.glob(pattern), key=lambda item: str(item).lower())
            for match in matches:
                if match.is_file() and match.suffix.lower() == ".gguf":
                    return str(match)
    return ""


def _find_related_mmproj(model: Path) -> str:
    candidates = sorted(model.parent.glob("*mmproj*.gguf"), key=lambda item: str(item).lower())
    return str(candidates[0]) if candidates else ""


def vision_preset_alias(preset: str) -> str:
    if preset == VISION_MODEL_PRESET_CUSTOM:
        return "custom-vlm"
    item = VISION_MODEL_PRESETS.get(preset) or VISION_MODEL_PRESETS[DEFAULT_VISION_MODEL_PRESET]
    return str(item.get("alias") or "local-vlm")


def find_vision_preset_files(preset: str) -> tuple[str, str, str]:
    item = VISION_MODEL_PRESETS.get(preset) or {}
    model = _find_first_gguf(list(item.get("model_globs") or []))
    mmproj = _find_first_gguf(list(item.get("mmproj_globs") or []))
    if model and not mmproj:
        mmproj = _find_related_mmproj(Path(model))
    return model, mmproj, vision_preset_alias(preset)


def resolve_vision_model_pair(preset: str, model_path: str, mmproj_path: str, need_mmproj: bool) -> tuple[str, str, str]:
    preset = preset if preset in VISION_MODEL_PRESETS or preset == VISION_MODEL_PRESET_CUSTOM else DEFAULT_VISION_MODEL_PRESET
    model = model_path.strip().strip('"')
    mmproj = mmproj_path.strip().strip('"')
    if _is_remote_windows_path(model) or _is_remote_windows_path(mmproj):
        raise RuntimeError("拒绝远程或设备模型路径。")
    model_exists = bool(model) and Path(model).exists()
    mmproj_exists = bool(mmproj) and Path(mmproj).exists()

    if not model_exists and preset != VISION_MODEL_PRESET_CUSTOM:
        model, preset_mmproj, _alias = find_vision_preset_files(preset)
        model_exists = bool(model) and Path(model).exists()
        if not mmproj_exists:
            mmproj = preset_mmproj
            mmproj_exists = bool(mmproj) and Path(mmproj).exists()

    if model_exists and need_mmproj and not mmproj_exists:
        mmproj = _find_related_mmproj(Path(model))
        mmproj_exists = bool(mmproj) and Path(mmproj).exists()

    if model_exists and (mmproj_exists or not need_mmproj):
        return model, mmproj, vision_preset_alias(preset)

    if (VISION_MODEL_PRESETS.get(preset) or {}).get("auto_download"):
        model, mmproj = ensure_local_gguf_pair(model, mmproj, need_mmproj)
        return model, mmproj, vision_preset_alias(preset)

    missing = "model GGUF"
    if model_exists and need_mmproj and not mmproj_exists:
        missing = "matching mmproj GGUF"
    raise RuntimeError(f"找不到 {preset} 的 {missing}。请在视觉模型设置里填写正确路径，或改用已安装的 VLM 预设。")


def ensure_local_gguf_pair(model_path: str, mmproj_path: str, need_mmproj: bool) -> tuple[str, str]:
    model = model_path.strip().strip('"')
    mmproj = mmproj_path.strip().strip('"')
    if _is_remote_windows_path(model) or _is_remote_windows_path(mmproj):
        raise RuntimeError("拒绝远程或设备模型路径。")
    model_exists = bool(model) and Path(model).exists()
    mmproj_exists = bool(mmproj) and Path(mmproj).exists()
    if model_exists and (mmproj_exists or not need_mmproj):
        return model, mmproj

    if model_exists and need_mmproj and not mmproj_exists:
        related = _find_related_mmproj(Path(model))
        if related:
            return model, related
        raise RuntimeError("已选择 GGUF 模型，但缺少匹配的 mmproj。请填写该视觉模型对应的 mmproj 路径。")

    target_dir = _forge_root() / "models" / "LLM" / DEFAULT_GGUF_DIR
    target_dir.mkdir(parents=True, exist_ok=True)
    if not model_exists:
        model = str(_download_hf_file(DEFAULT_GGUF_REPO, DEFAULT_GGUF_MODEL, target_dir))
    if need_mmproj and not mmproj_exists:
        mmproj = str(_download_hf_file(DEFAULT_GGUF_REPO, DEFAULT_GGUF_MMPROJ, target_dir))
    return model, mmproj


def find_default_llama_server() -> str:
    env_path = os.environ.get("LLAMA_SERVER_EXE", "").strip().strip('"')
    if env_path and not _is_remote_windows_path(env_path) and Path(env_path).is_file():
        return env_path
    bundled = _llama_cpp_bin_dir() / "llama-server.exe"
    if bundled.exists():
        return str(bundled)
    for candidate in DEFAULT_LLAMA_SERVER_CANDIDATES:
        path = Path(candidate)
        if path.exists():
            return str(path)
    found = shutil.which("llama-server.exe") or shutil.which("llama-server")
    return found or ""


def _is_remote_windows_path(path: str) -> bool:
    cleaned = str(path or "").strip().replace("/", "\\")
    return cleaned.startswith("\\\\")


def _trusted_llama_server_paths() -> set[Path]:
    candidates = [
        os.environ.get("LLAMA_SERVER_EXE", "").strip().strip('"'),
        str(_llama_cpp_bin_dir() / "llama-server.exe"),
        *DEFAULT_LLAMA_SERVER_CANDIDATES,
        shutil.which("llama-server.exe") or shutil.which("llama-server") or "",
    ]
    trusted: set[Path] = set()
    for candidate in candidates:
        if not candidate:
            continue
        if _is_remote_windows_path(candidate):
            continue
        path = Path(candidate)
        if path.is_file():
            trusted.add(path.resolve())
    return trusted


def resolve_llama_server(path: str) -> str:
    cleaned = path.strip().strip('"')
    if cleaned:
        if _is_remote_windows_path(cleaned):
            raise RuntimeError("拒绝远程或设备 llama-server 路径。")
        requested = Path(cleaned)
        if not requested.is_file() or requested.resolve() not in _trusted_llama_server_paths():
            raise RuntimeError("拒绝请求中未受信任的 llama-server 路径；请通过 LLAMA_SERVER_EXE 配置服务端可执行文件。")
        return str(requested.resolve())
    found = find_default_llama_server()
    if found:
        return found
    return str(download_llama_server())


def _forge_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _extension_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _llama_cpp_bin_dir() -> Path:
    return _extension_root() / "bin" / "llama.cpp"


def download_llama_server() -> Path:
    if os.name != "nt":
        raise RuntimeError("自动下载 llama.cpp 后端目前只支持 Windows；请手动填写 llama-server 路径。")
    target_dir = _llama_cpp_bin_dir()
    target = target_dir / "llama-server.exe"
    if target.exists():
        return target
    target_dir.mkdir(parents=True, exist_ok=True)
    asset = _select_llama_cpp_windows_asset()
    zip_path = target_dir / asset["name"]
    if not zip_path.exists() or zip_path.stat().st_size == 0:
        _download_url(asset["browser_download_url"], zip_path)
    _safe_extract_zip(zip_path, target_dir)
    found = next(target_dir.rglob("llama-server.exe"), None)
    if found is None:
        raise RuntimeError(f"llama.cpp release 解压后没有找到 llama-server.exe: {zip_path}")
    if found != target:
        if target.exists():
            target.unlink()
        shutil.copy2(found, target)
    return target


def _select_llama_cpp_windows_asset() -> dict[str, str]:
    req = urllib.request.Request(LLAMA_CPP_RELEASE_API, headers={"User-Agent": "forge-kohaku-loom"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        release = json.loads(resp.read().decode("utf-8"))
    assets = release.get("assets") or []
    candidates: list[tuple[int, dict[str, str]]] = []
    for asset in assets:
        name = str(asset.get("name") or "")
        lowered = name.lower()
        if not lowered.endswith(".zip"):
            continue
        if "win" not in lowered or "x64" not in lowered or "bin" not in lowered:
            continue
        score = 0
        if "cuda" in lowered:
            score += 100
        if "cu12" in lowered or "cu13" in lowered:
            score += 20
        if "vulkan" in lowered:
            score += 10
        if "cpu" in lowered:
            score += 1
        if "server" in lowered:
            score += 1
        candidates.append((score, asset))
    if not candidates:
        raise RuntimeError("没有在 llama.cpp 最新 release 中找到 Windows x64 zip 后端。")
    candidates.sort(key=lambda item: item[0], reverse=True)
    selected = candidates[0][1]
    if not selected.get("browser_download_url"):
        raise RuntimeError(f"llama.cpp release asset 缺少下载 URL: {selected.get('name')}")
    return selected


def _download_url(url: str, target: Path) -> None:
    tmp = target.with_suffix(target.suffix + ".tmp")
    if tmp.exists():
        tmp.unlink()
    req = urllib.request.Request(url, headers={"User-Agent": "forge-kohaku-loom"})
    with urllib.request.urlopen(req, timeout=120) as resp, tmp.open("wb") as f:
        shutil.copyfileobj(resp, f)
    tmp.replace(target)


def _safe_extract_zip(zip_path: Path, target_dir: Path) -> None:
    root = target_dir.resolve()
    with zipfile.ZipFile(zip_path) as zf:
        for member in zf.infolist():
            destination = (target_dir / member.filename).resolve()
            if root not in destination.parents and destination != root:
                raise RuntimeError(f"拒绝解压可疑路径: {member.filename}")
        zf.extractall(target_dir)


def _download_hf_file(repo: str, filename: str, target_dir: Path) -> Path:
    target = target_dir / filename
    if target.exists() and target.stat().st_size > 0:
        return target
    cached = Path(huggingface_hub.hf_hub_download(repo, filename)).resolve()
    tmp = target.with_suffix(target.suffix + ".tmp")
    if tmp.exists():
        tmp.unlink()
    try:
        os.link(cached, tmp)
    except OSError:
        shutil.copy2(cached, tmp)
    tmp.replace(target)
    return target
