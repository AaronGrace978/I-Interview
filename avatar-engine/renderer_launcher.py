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
    sys.path.insert(0, str(vendor))
    sys.path.insert(0, str(vendor / "avatars/musetalk/utils"))
    # Upstream app.py sets the multiprocessing start method itself.
    runpy.run_path(str(vendor / "app.py"), run_name="__main__")


if __name__ == "__main__":
    main()
