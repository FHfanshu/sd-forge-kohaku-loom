from __future__ import annotations

import asyncio
import subprocess
from typing import Any, Callable
from urllib.parse import quote

import httpx
from fastapi import HTTPException, Request
from fastapi.responses import Response, StreamingResponse

from .sidecar_manager import SidecarManager


_FORWARDED_REQUEST_HEADERS = ("accept", "content-type", "last-event-id", "cache-control")
_FORWARDED_RESPONSE_HEADERS = ("content-type", "cache-control", "etag", "last-modified")


class KohakuTerrariumProxy:
    def __init__(
        self,
        manager_factory: Callable[[], SidecarManager] = SidecarManager,
        client_factory: Callable[..., httpx.AsyncClient] = httpx.AsyncClient,
    ):
        self._manager_factory = manager_factory
        self._client_factory = client_factory
        self._manager: SidecarManager | None = None
        self._state: dict[str, Any] | None = None
        self._start_lock = asyncio.Lock()

    async def forward(self, request: Request, sidecar_path: str) -> Response:
        normalized_path = self._normalized_path(sidecar_path)
        body = await request.body() if request.method == "POST" else b""
        for attempt in range(2):
            state = await self._ensure_sidecar()
            try:
                return await self._send(request, normalized_path, body, state)
            except httpx.RequestError as error:
                await self._invalidate(state)
                if attempt == 0:
                    continue
                raise HTTPException(
                    status_code=503,
                    detail="Kohaku Loom sidecar is unavailable.",
                ) from error
        raise HTTPException(status_code=503, detail="Kohaku Loom sidecar is unavailable.")

    async def _ensure_sidecar(self) -> dict[str, Any]:
        if self._state is not None:
            return self._state
        async with self._start_lock:
            if self._state is not None:
                return self._state
            if self._manager is None:
                self._manager = self._manager_factory()
            try:
                state = await asyncio.to_thread(self._manager.start)
            except subprocess.CalledProcessError as error:
                raise HTTPException(
                    status_code=503,
                    detail="Kohaku Loom sidecar installation failed; see Forge logs.",
                ) from error
            except (OSError, RuntimeError) as error:
                raise HTTPException(
                    status_code=503,
                    detail="Kohaku Loom sidecar could not be started; see Forge logs.",
                ) from error
            if not isinstance(state, dict) or not state.get("port") or not state.get("token"):
                raise HTTPException(
                    status_code=503,
                    detail="Kohaku Loom sidecar returned invalid startup state.",
                )
            self._state = state
            return state

    async def _send(
        self,
        request: Request,
        sidecar_path: str,
        body: bytes,
        state: dict[str, Any],
    ) -> Response:
        query = request.url.query
        target = f"http://127.0.0.1:{int(state['port'])}/{quote(sidecar_path, safe='/-._~')}"
        if query:
            target += f"?{query}"
        headers = {
            name: request.headers[name]
            for name in _FORWARDED_REQUEST_HEADERS
            if name in request.headers
        }
        headers["authorization"] = f"Bearer {state['token']}"
        client = self._client_factory(timeout=None)
        try:
            upstream_request = client.build_request(
                request.method,
                target,
                headers=headers,
                content=body,
            )
            upstream = await client.send(upstream_request, stream=True)
        except BaseException:
            await client.aclose()
            raise

        response_headers = self._response_headers(upstream)
        content_type = upstream.headers.get("content-type", "")
        if content_type.lower().startswith("text/event-stream"):
            response_headers["cache-control"] = "no-cache, no-transform"
            response_headers["x-accel-buffering"] = "no"

            async def stream():
                try:
                    async for chunk in upstream.aiter_raw():
                        yield chunk
                finally:
                    await upstream.aclose()
                    await client.aclose()

            return StreamingResponse(
                stream(),
                status_code=upstream.status_code,
                headers=response_headers,
            )

        try:
            content = await upstream.aread()
            return Response(
                content=content,
                status_code=upstream.status_code,
                headers=response_headers,
            )
        finally:
            await upstream.aclose()
            await client.aclose()

    async def _invalidate(self, state: dict[str, Any]) -> None:
        async with self._start_lock:
            if self._state is state:
                self._state = None

    @staticmethod
    def _normalized_path(sidecar_path: str) -> str:
        value = str(sidecar_path or "").strip("/")
        parts = value.split("/") if value else []
        if not parts or any(part in {"", ".", ".."} or "\\" in part for part in parts):
            raise HTTPException(status_code=404, detail="unknown Kohaku Loom sidecar path")
        return "/".join(parts)

    @staticmethod
    def _response_headers(upstream: httpx.Response) -> dict[str, str]:
        return {
            name: upstream.headers[name]
            for name in _FORWARDED_RESPONSE_HEADERS
            if name in upstream.headers
        }


def register_kt_proxy(
    app: Any,
    *,
    manager_factory: Callable[[], SidecarManager] = SidecarManager,
    client_factory: Callable[..., httpx.AsyncClient] = httpx.AsyncClient,
) -> None:
    if getattr(app.state, "kohaku_loom_kt_proxy", None) is not None:
        return
    proxy = KohakuTerrariumProxy(manager_factory, client_factory)
    app.state.kohaku_loom_kt_proxy = proxy

    async def forward(request: Request, sidecar_path: str) -> Response:
        return await proxy.forward(request, sidecar_path)

    app.add_api_route(
        "/kohaku-loom/kt/{sidecar_path:path}",
        forward,
        methods=["GET", "POST"],
        name="kohaku-loom-kt-proxy",
    )
