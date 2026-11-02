"""Run the pinned upstream engine privately; do not expose its unauthenticated API.

The upstream executable binds to 0.0.0.0. This wrapper overrides only its socket
binding at runtime, keeping the checkout and its source/license notices intact.
"""

import os
import runpy
import secrets
import sys
from pathlib import Path

from settings import Settings


def configure_private_web(web, token):
    original = web.TCPSite
    original_runner = web.AppRunner
    expected = f"Bearer {token}"

    @web.middleware
    async def private_control(request, handler):
        if request.headers.get("Origin") or not secrets.compare_digest(
            request.headers.get("Authorization", ""), expected
        ):
            return web.json_response(
                {"error": "Private renderer authentication required."}, status=401
            )
        return await handler(request)

    def private_runner(application, *args, **kwargs):
        application.middlewares.insert(0, private_control)
        return original_runner(application, *args, **kwargs)

    def local_site(runner, host=None, port=8080, **kwargs):
        return original(runner, "127.0.0.1", port, **kwargs)

    web.TCPSite = local_site
    web.AppRunner = private_runner


def main():
    from aiohttp import web

    configure_private_web(web, Settings.load().token)
    vendor = Path(os.environ["INTERVIEW_LIVETALKING_ROOT"]).resolve()
    os.chdir(vendor)
    # LiveTalking's utils directory has no __init__.py, and MuseTalk ships a
    # utils.py on the same import path. A real package in front keeps
    # `import utils` on LiveTalking while MuseTalk can still import face_detection.
    state = Path(os.environ.get("INTERVIEW_AVATAR_STATE", vendor.parent))
    bridge = state / "import-bridge"
    package = bridge / "utils"
    package.mkdir(parents=True, exist_ok=True)
    (package / "__init__.py").write_text(
        "__path__.append(" + repr(os.fspath(vendor / "utils")) + ")\n",
        encoding="utf-8",
    )
    sys.path.insert(0, str(vendor / "avatars/musetalk/utils"))
    sys.path.insert(0, str(vendor))
    sys.path.insert(0, str(bridge))
    # Upstream app.py sets the multiprocessing start method itself.
    runpy.run_path(str(vendor / "app.py"), run_name="__main__")


if __name__ == "__main__":
    main()
