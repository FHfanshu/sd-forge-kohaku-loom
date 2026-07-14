from __future__ import annotations

import base64
import io
from typing import Any

from PIL import Image

MAX_IMAGE_BYTES = 24 * 1024 * 1024
MAX_IMAGE_PIXELS = 16 * 1024 * 1024


def _decode_image_data(data_url: str) -> tuple[str, bytes, str]:
    raw = str(data_url or "").strip()
    mime = "image/jpeg"
    if raw.startswith("data:"):
        if ";base64," not in raw:
            raise RuntimeError("reference image must be base64 data URL")
        header, raw = raw.split(",", 1)
        mime = header[5:].split(";", 1)[0] or mime
    if not mime.startswith("image/"):
        raise RuntimeError("reference image must use an image MIME type")
    if len(raw) > ((MAX_IMAGE_BYTES + 2) // 3) * 4:
        raise RuntimeError("reference image is too large; use an image under 24 MB")
    try:
        binary = base64.b64decode(raw, validate=True)
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError("invalid reference image data") from exc
    if len(binary) > MAX_IMAGE_BYTES:
        raise RuntimeError("reference image is too large; use an image under 24 MB")
    return mime, binary, raw


def _data_url_inline_data(data_url: str) -> dict[str, Any]:
    mime, _binary, raw = _decode_image_data(data_url)
    return {"inlineData": {"mimeType": mime, "data": raw}}


def _image_from_data_url(data_url: str) -> Image.Image:
    _mime, binary, _raw = _decode_image_data(data_url)
    try:
        image = Image.open(io.BytesIO(binary))
        width, height = image.size
        if width <= 0 or height <= 0 or width * height > MAX_IMAGE_PIXELS:
            raise RuntimeError("reference image dimensions are too large")
        return image.convert("RGB")
    except RuntimeError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError("could not decode reference image") from exc


def _image_data_url(image: Image.Image, max_side: int = 768) -> str:
    prepared = image.convert("RGB")
    prepared.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
    buffer = io.BytesIO()
    prepared.save(buffer, format="JPEG", quality=95, optimize=True)
    data = base64.b64encode(buffer.getvalue()).decode("ascii")
    return f"data:image/jpeg;base64,{data}"
