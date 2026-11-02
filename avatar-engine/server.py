"""Authenticated loopback control plane for the self-hosted video renderer."""

import asyncio
import secrets
import uuid
import wave
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

import httpx
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from runtime import MAX_VIDEO_BYTES, Runtime
from settings import Settings


class Offer(BaseModel):
    avatar_id: str = Field(pattern=r"^[a-zA-Z0-9_-]{1,64}$")
    sdp: str = Field(min_length=10, max_length=150_000)
    consent: bool


class Speech(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    epoch: int = Field(ge=0)


def create_app(settings: Settings | None = None, runtime_factory=Runtime):
    settings = settings or Settings.load()

    @asynccontextmanager
    async def lifespan(app):
        async with httpx.AsyncClient(
            trust_env=False,
            follow_redirects=False,
            headers={"Authorization": f"Bearer {settings.token}"},
        ) as client:
            app.state.runtime = runtime_factory(settings, client)
            try:
                yield
            finally:
                await app.state.runtime.close()

    app = FastAPI(
        title="I / Interview local avatar engine",
        docs_url=None,
        redoc_url=None,
        lifespan=lifespan,
    )

    @app.middleware("http")
    async def authorize(request: Request, call_next):
        # All requests originate in Electron's native process. No browser CORS
        # exemption is needed; reject browser origins to prevent local CSRF.
        if request.headers.get("origin"):
            return JSONResponse(
                {"detail": "Browser control requests are not accepted."},
                status_code=403,
            )
        expected = f"Bearer {settings.token}"
        if not secrets.compare_digest(
            request.headers.get("authorization", ""), expected
        ):
            return JSONResponse(
                {"detail": "Local engine authentication required."}, status_code=401
            )
        try:
            return await call_next(request)
        except httpx.HTTPError:
            return JSONResponse(
                {
                    "detail": "The local video or voice process is unavailable. Check the local engine logs."
                },
                status_code=503,
            )
        except RuntimeError as error:
            return JSONResponse({"detail": str(error)}, status_code=409)

    @app.get("/v1/status")
    async def status(request: Request):
        return await request.app.state.runtime.status()

    @app.get("/v1/gpu")
    async def gpu(request: Request):
        return await request.app.state.runtime.gpu()

    @app.post("/v1/avatars")
    async def prepare(
        request: Request,
        avatar_id: Annotated[str, Form(pattern=r"^[a-zA-Z0-9_-]{1,64}$")],
        consent: Annotated[bool, Form()],
        video: Annotated[UploadFile, File()],
    ):
        if not consent:
            raise HTTPException(
                400,
                "Confirm that the footage is yours and that you consent to preparing a replica.",
            )
        suffix = Path(video.filename or "").suffix.lower()
        if suffix not in {".mp4", ".mov", ".mkv", ".webm"}:
            raise HTTPException(
                400, "Select an MP4, MOV, MKV, or WebM reference video."
            )
        root = settings.state / "uploads"
        root.mkdir(exist_ok=True, mode=0o700)
        source = root / f"{uuid.uuid4()}{suffix}"
        size = 0
        try:
            with source.open("xb") as file:
                while chunk := await video.read(1024 * 1024):
                    size += len(chunk)
                    if size > MAX_VIDEO_BYTES:
                        raise HTTPException(
                            413, "Select a reference clip smaller than 150 MB."
                        )
                    file.write(chunk)
            if size < 1024:
                raise HTTPException(400, "The reference video is empty or too small.")
            runtime = request.app.state.runtime
            if len(runtime.tasks) >= 1:
                raise HTTPException(409, "Another preparation task is running.")
            return runtime.begin_prepare(avatar_id, source)
        except BaseException:
            source.unlink(missing_ok=True)
            raise
        finally:
            await video.close()

    @app.get("/v1/jobs/{task_id}")
    async def job(request: Request, task_id: uuid.UUID):
        result = request.app.state.runtime.jobs.get(str(task_id))
        if not result:
            raise HTTPException(
                404,
                "Preparation job not found; inspect local files if the engine restarted.",
            )
        return result

    @app.post("/v1/offer")
    async def offer(request: Request, body: Offer):
        if not body.consent:
            raise HTTPException(
                400, "Replica participation must be disclosed and permitted."
            )
        return await request.app.state.runtime.offer(body.avatar_id, body.sdp)

    @app.post("/v1/voice")
    async def reference_voice(
        consent: Annotated[bool, Form()], audio: Annotated[UploadFile, File()]
    ):
        if not consent:
            raise HTTPException(400, "Confirm that this is your own voice.")
        data = await audio.read(10 * 1024 * 1024 + 1)
        await audio.close()
        if len(data) < 1024 or len(data) > 10 * 1024 * 1024:
            raise HTTPException(400, "Choose a voice sample between 1 KB and 10 MB.")
        source = settings.state / f"voice-{uuid.uuid4()}.input"
        destination = settings.state / "voice.wav"
        temp = settings.state / f"voice-{uuid.uuid4()}.wav"
        source.write_bytes(data)
        try:
            process = await asyncio.create_subprocess_exec(
                "ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-i",
                str(source),
                "-t",
                "15",
                "-ar",
                "24000",
                "-ac",
                "1",
                "-c:a",
                "pcm_s16le",
                str(temp),
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            try:
                code = await asyncio.wait_for(process.wait(), 30)
            except TimeoutError:
                process.kill()
                await process.wait()
                raise HTTPException(400, "Voice decoding timed out.")
            if code:
                raise HTTPException(400, "Could not decode the voice reference.")
            with wave.open(str(temp), "rb") as decoded:
                if decoded.getnframes() < decoded.getframerate() * 5:
                    raise HTTPException(
                        400,
                        "Choose at least five seconds of clean reference speech; 10–15 seconds is recommended.",
                    )
            temp.replace(destination)
            return {"saved": True}
        finally:
            source.unlink(missing_ok=True)
            temp.unlink(missing_ok=True)

    @app.post("/v1/speak")
    async def speak(request: Request, body: Speech):
        await request.app.state.runtime.speak(body.text, body.epoch)
        return {"queued": True}

    @app.get("/v1/speech-ticket")
    async def speech_ticket(request: Request):
        runtime = request.app.state.runtime
        if not runtime.session:
            raise HTTPException(409, "Connect your video replica first.")
        return {"epoch": runtime.epoch, "sessionid": runtime.session}

    @app.post("/v1/audio")
    async def audio(
        request: Request,
        epoch: Annotated[int, Form(ge=0)],
        audio: Annotated[UploadFile, File()],
    ):
        if audio.content_type not in {"audio/wav", "audio/mpeg"}:
            raise HTTPException(400, "Use WAV or MP3 audio.")
        content = await audio.read(12 * 1024 * 1024 + 1)
        await audio.close()
        if not content or len(content) > 12 * 1024 * 1024:
            raise HTTPException(413, "Generated audio is empty or too large.")
        await request.app.state.runtime.feed_audio(content, audio.content_type, epoch)
        return {"queued": True}

    @app.get("/v1/speaking")
    async def speaking(request: Request):
        return {"speaking": await request.app.state.runtime.speaking()}

    @app.post("/v1/interrupt")
    async def interrupt(request: Request):
        await request.app.state.runtime.interrupt()
        return {"stopped": True}

    @app.post("/v1/stop")
    async def stop(request: Request):
        await request.app.state.runtime.stop()
        return {"stopped": True}

    return app


if __name__ == "__main__":
    import uvicorn

    settings = Settings.load()
    print(
        f"Local avatar token is stored in {settings.state / 'engine-token'}. Enter it in the desktop app; never send it in chat."
    )
    uvicorn.run(create_app(settings), host="127.0.0.1", port=17860, access_log=False)
