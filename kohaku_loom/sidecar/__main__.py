from __future__ import annotations

import argparse
import asyncio
import os
import time
from pathlib import Path

import uvicorn

from kohaku_loom.runtime_paths import LoomRuntimePaths
from kohaku_loom.sidecar.app import create_app


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the Kohaku Loom sidecar")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", required=True, type=int)
    parser.add_argument("--token", required=True)
    parser.add_argument("--extension-root", required=True)
    parser.add_argument("--idle-timeout", default=900, type=int)
    return parser.parse_args()


async def _run(args: argparse.Namespace) -> None:
    paths = LoomRuntimePaths.under(Path(args.extension_root).resolve()).ensure()
    os.environ["KT_CONFIG_DIR"] = str(paths.config)
    os.environ["KT_SESSION_DIR"] = str(paths.sessions)
    app, activity = create_app(args.token, paths)
    config = uvicorn.Config(app, host=args.host, port=args.port, log_level="info", access_log=False)
    server = uvicorn.Server(config)

    async def stop_when_idle() -> None:
        while not server.should_exit:
            await asyncio.sleep(min(30, max(1, args.idle_timeout)))
            active_turn = app.state.loom_runtime.has_active_turn
            if (
                args.idle_timeout > 0
                and not active_turn
                and time.monotonic() - activity.last_activity >= args.idle_timeout
            ):
                server.should_exit = True

    monitor = asyncio.create_task(stop_when_idle())
    try:
        await server.serve()
    finally:
        monitor.cancel()
        await asyncio.gather(monitor, return_exceptions=True)


def main() -> None:
    asyncio.run(_run(_arguments()))


if __name__ == "__main__":
    main()
