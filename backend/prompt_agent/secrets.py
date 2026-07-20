from __future__ import annotations

import base64
import ctypes
import os
from ctypes import wintypes


CRYPTPROTECT_UI_FORBIDDEN = 0x01


class _DataBlob(ctypes.Structure):
    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_byte))]


def _require_windows() -> None:
    if os.name != "nt":
        raise RuntimeError("Prompt Agent secrets require Windows DPAPI")


def _blob(data: bytes) -> tuple[_DataBlob, ctypes.Array]:
    buffer = ctypes.create_string_buffer(data)
    return _DataBlob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_byte))), buffer


def _libraries():
    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    crypt32.CryptProtectData.argtypes = [ctypes.POINTER(_DataBlob), wintypes.LPCWSTR, ctypes.POINTER(_DataBlob), ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(_DataBlob)]
    crypt32.CryptProtectData.restype = wintypes.BOOL
    crypt32.CryptUnprotectData.argtypes = [ctypes.POINTER(_DataBlob), ctypes.POINTER(wintypes.LPWSTR), ctypes.POINTER(_DataBlob), ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(_DataBlob)]
    crypt32.CryptUnprotectData.restype = wintypes.BOOL
    kernel32.LocalFree.argtypes = [wintypes.HLOCAL]
    kernel32.LocalFree.restype = wintypes.HLOCAL
    return crypt32, kernel32


def protect_text(value: str, entropy: str = "sd-forge-neo-prompt-agent") -> str:
    _require_windows()
    crypt32, kernel32 = _libraries()
    source, source_buffer = _blob(value.encode("utf-8"))
    entropy_blob, entropy_buffer = _blob(entropy.encode("utf-8"))
    output = _DataBlob()
    try:
        if not crypt32.CryptProtectData(ctypes.byref(source), "SD Forge Neo Prompt Agent", ctypes.byref(entropy_blob), None, None, CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(output)):
            raise ctypes.WinError()
        return base64.b64encode(ctypes.string_at(output.pbData, output.cbData)).decode("ascii")
    finally:
        _ = source_buffer, entropy_buffer
        if output.pbData:
            kernel32.LocalFree(ctypes.cast(output.pbData, wintypes.HLOCAL))


def unprotect_text(value: str, entropy: str = "sd-forge-neo-prompt-agent") -> str:
    _require_windows()
    crypt32, kernel32 = _libraries()
    source, source_buffer = _blob(base64.b64decode(value.encode("ascii")))
    entropy_blob, entropy_buffer = _blob(entropy.encode("utf-8"))
    output = _DataBlob()
    try:
        if not crypt32.CryptUnprotectData(ctypes.byref(source), None, ctypes.byref(entropy_blob), None, None, CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(output)):
            raise ctypes.WinError()
        return ctypes.string_at(output.pbData, output.cbData).decode("utf-8")
    finally:
        _ = source_buffer, entropy_buffer
        if output.pbData:
            kernel32.LocalFree(ctypes.cast(output.pbData, wintypes.HLOCAL))
