from __future__ import annotations

import asyncio
import json
import os
import signal
import time
import uuid
from contextlib import suppress
from pathlib import Path

import httpx
from settings import Settings

MAX_VIDEO_BYTES = 150 * 1024 * 1024


class Runtime:
    def __init__(self, settings: Settings, client: httpx.AsyncClient):
        self.settings, self.client = settings, client
        self.process: asyncio.subprocess.Process | None = None
        self.session: str | None = None
        self.avatar: str | None = None
        self.epoch = 0
        self.jobs: dict[str, dict] = {}
        self.tasks: set[asyncio.Task] = set()
        self.lifecycle = asyncio.Lock()
        self.speech_lock = asyncio.Lock()
        self.log = settings.state / "renderer.log"

    async def status(self):
        configured = (
            self.settings.video_python.is_file()
            and (self.settings.vendor / "app.py").is_file()
        )
        avatars_dir = self.settings.vendor / "data/avatars"
        avatars = []
        if avatars_dir.is_dir():
            for entry in sorted(avatars_dir.iterdir()):
                # Only offer avatars prepared by this application, not bundled people.
                if (
                    entry.is_dir()
                    and (entry / "i-interview-owned.json").is_file()
                    and (entry / "latents.pt").is_file()
                ):
                    avatars.append(entry.name)
        return {
            "configured": configured,
            "avatars": avatars,
            "session_active": self.session is not None,
            "profile": "RTX 5060 Ti 16 GB / batch 4 / one stream",
            "video_runtime": "PyTorch 2.9.1 + CUDA 12.8",
            "message": "Configured; GPU/video inference still requires a real connection test."
            if configured
            else "Run the WSL2 setup instructions on your NVIDIA machine first.",
        }

    async def gpu(self):
        if not self.settings.video_python.is_file():
            raise RuntimeError(
                "The video Python environment is missing. Run the local setup script."
            )
        process = await asyncio.create_subprocess_exec(
            str(self.settings.video_python),
            str(Path(__file__).with_name("gpu_probe.py")),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
        try:
            output, _ = await asyncio.wait_for(process.communicate(), 45)
        except TimeoutError:
            process.kill()
            await process.wait()
            raise RuntimeError("CUDA kernel validation timed out.")
        try:
            result = json.loads(output)
        except (ValueError, TypeError):
            raise RuntimeError(
                "The GPU probe failed. Check the video environment's PyTorch installation."
            )
        if process.returncode:
            raise RuntimeError(result.get("error", "GPU validation failed."))
        return result

    def begin_prepare(self, avatar_id: str, source: Path):
        task_id = str(uuid.uuid4())
        self.jobs[task_id] = {
            "task_id": task_id,
            "status": "pending",
            "avatar_id": avatar_id,
            "error": None,
        }
        task = asyncio.create_task(self._prepare(task_id, avatar_id, source))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return self.jobs[task_id]

    async def _prepare(self, task_id: str, avatar_id: str, source: Path):
        async with self.lifecycle:
            job = self.jobs[task_id]
            normalized = source.with_suffix(".normalized.mp4")
            try:
                if self.session:
                    raise RuntimeError(
                        "Disconnect your video session before preparing another avatar."
                    )
                await self.gpu()
                avatar_dir = self.settings.vendor / "data/avatars" / avatar_id
                if avatar_dir.exists():
                    raise RuntimeError(
                        "That avatar ID already exists. Choose a new ID to preserve the existing replica."
                    )
                job["status"] = "running"
                # Bound CPU RAM and frame-cache size on a 32 GB workstation.
                await self._command(
                    [
                        "ffmpeg",
                        "-nostdin",
                        "-v",
                        "error",
                        "-i",
                        str(source),
                        "-t",
                        "12",
                        "-vf",
                        "scale=720:720:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=25",
                        "-an",
                        "-c:v",
                        "libx264",
                        "-pix_fmt",
                        "yuv420p",
                        str(normalized),
                    ],
                    timeout=180,
                )
                await self._command(
                    [
                        str(self.settings.video_python),
                        "-m",
                        "avatars.musetalk.genavatar",
                        "--file",
                        str(normalized),
                        "--avatar_id",
                        avatar_id,
                        "--version",
                        "v15",
                        "--save_path",
                        "data/avatars",
                    ],
                    timeout=900,
                    cwd=self.settings.vendor,
                )
                if not (avatar_dir / "latents.pt").is_file():
                    raise RuntimeError(
                        "Preparation did not produce an avatar cache. Inspect the local renderer log."
                    )
                await self._command(
                    [
                        str(self.settings.video_python),
                        str(Path(__file__).with_name("validate_cache.py")),
                        str(avatar_dir),
                    ],
                    timeout=60,
                )
                (avatar_dir / "i-interview-owned.json").write_text(
                    json.dumps(
                        {
                            "consent": True,
                            "model": "musetalk-v15",
                            "prepared_at": time.time(),
                            "source": "user-selected local footage",
                        }
                    )
                )
                job["status"] = "completed"
            except asyncio.CancelledError:
                job.update(status="failed", error="Preparation was stopped.")
                raise
            except (
                RuntimeError,
                OSError,
                ValueError,
                TypeError,
                httpx.HTTPError,
            ) as error:
                job.update(status="failed", error=str(error))
            finally:
                source.unlink(missing_ok=True)
                normalized.unlink(missing_ok=True)

    async def _command(self, command, timeout, cwd=None):
        env = {
            **os.environ,
            "PYTHONPATH": os.pathsep.join(
                [
                    str(self.settings.vendor),
                    str(self.settings.vendor / "avatars/musetalk/utils"),
                ]
            ),
        }
        with self.log.open("ab") as log:
            process = await asyncio.create_subprocess_exec(
                *command,
                cwd=cwd,
                env=env,
                stdout=log,
                stderr=log,
                start_new_session=True,
            )
            try:
                code = await asyncio.wait_for(process.wait(), timeout)
            except (TimeoutError, asyncio.CancelledError):
                with suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGKILL)
                await process.wait()
                raise RuntimeError(
                    "The local preparation process stopped or timed out. Inspect renderer.log."
                )
            if code:
                raise RuntimeError(
                    "Local video preparation failed. Inspect renderer.log; no replica was marked ready."
                )

    async def offer(self, avatar_id: str, sdp: str):
        async with self.lifecycle:
            if self.session:
                raise RuntimeError(
                    "Only one video session is supported on this hardware profile."
                )
            if avatar_id not in (await self.status())["avatars"]:
                raise RuntimeError("Prepare your own video replica before connecting.")
            await self.gpu()
            await self._stop_process()
            self.epoch += 1
            operation_epoch = self.epoch
            env = {
                **os.environ,
                "INTERVIEW_LIVETALKING_ROOT": str(self.settings.vendor),
                "INTERVIEW_AVATAR_STATE": str(self.settings.state),
            }
            with self.log.open("ab") as log:
                self.process = await asyncio.create_subprocess_exec(
                    str(self.settings.video_python),
                    str(Path(__file__).with_name("renderer_launcher.py")),
                    "--model",
                    "musetalk",
                    "--avatar_id",
                    avatar_id,
                    "--transport",
                    "webrtc",
                    "--listenport",
                    "17861",
                    "--batch_size",
                    "4",
                    "--max_session",
                    "1",
                    "--fps",
                    "25",
                    "--stun",
                    "",
                    cwd=self.settings.vendor,
                    env=env,
                    stdout=log,
                    stderr=log,
                    start_new_session=True,
                )
            try:
                for _ in range(180):
                    if operation_epoch != self.epoch:
                        raise RuntimeError("Connection was stopped.")
                    if self.process.returncode is not None:
                        raise RuntimeError(
                            "The GPU renderer exited during warmup. Inspect renderer.log."
                        )
                    try:
                        response = await self.client.get(
                            f"{self.settings.renderer_url}/index.html", timeout=1
                        )
                        if response.is_success:
                            break
                    except httpx.HTTPError:
                        pass
                    await asyncio.sleep(0.5)
                else:
                    raise RuntimeError("GPU renderer warmup timed out.")
                response = await self.client.post(
                    f"{self.settings.renderer_url}/offer",
                    json={"avatar": avatar_id, "sdp": sdp, "type": "offer"},
                    timeout=30,
                )
                response.raise_for_status()
                result = response.json()
                if (
                    result.get("type") != "answer"
                    or not isinstance(result.get("sessionid"), str)
                    or not isinstance(result.get("sdp"), str)
                ):
                    raise RuntimeError(
                        "The renderer returned an invalid WebRTC answer."
                    )
                if operation_epoch != self.epoch:
                    raise RuntimeError("Connection was stopped.")
                self.session, self.avatar = result["sessionid"], avatar_id
                return result
            except BaseException:
                await self._stop_process()
                raise

    async def speak(self, text: str, expected_epoch: int | None = None):
        async with self.speech_lock:
            if not self.session:
                raise RuntimeError("Connect your video replica first.")
            if expected_epoch is not None and expected_epoch != self.epoch:
                raise RuntimeError(
                    "That speech request was interrupted before synthesis."
                )
            epoch = self.epoch
            response = await self.client.post(
                f"{self.settings.voice_url}/v1/audio",
                json={"text": text},
                headers={"Authorization": f"Bearer {self.settings.token}"},
                timeout=90,
            )
            response.raise_for_status()
            if len(
                response.content
            ) > 12 * 1024 * 1024 or not response.content.startswith(b"RIFF"):
                raise RuntimeError(
                    "The voice process returned an invalid or oversized WAV file."
                )
            if epoch != self.epoch:
                raise RuntimeError("Speech was interrupted before video playback.")
            await self.feed_audio(response.content, "audio/wav", epoch)

    async def feed_audio(self, audio: bytes, mime: str, epoch: int | None = None):
        if not self.session or (epoch is not None and epoch != self.epoch):
            raise RuntimeError("The video session was stopped.")
        response = await self.client.post(
            f"{self.settings.renderer_url}/humanaudio",
            data={"sessionid": self.session},
            files={
                "file": (
                    "answer.wav" if mime == "audio/wav" else "answer.mp3",
                    audio,
                    mime,
                )
            },
            timeout=30,
        )
        response.raise_for_status()
        if response.json().get("code") != 0:
            raise RuntimeError("The video renderer rejected the generated audio.")

    async def speaking(self):
        if not self.session:
            return False
        response = await self.client.post(
            f"{self.settings.renderer_url}/is_speaking",
            json={"sessionid": self.session},
            timeout=5,
        )
        response.raise_for_status()
        result = response.json()
        if result.get("code") != 0:
            raise RuntimeError("Could not read video speech state.")
        return result.get("data") is True

    async def interrupt(self):
        self.epoch += 1
        if self.session:
            response = await self.client.post(
                f"{self.settings.renderer_url}/interrupt_talk",
                json={"sessionid": self.session},
                timeout=5,
            )
            response.raise_for_status()

    async def stop(self):
        self.epoch += 1
        async with self.lifecycle:
            self.session, self.avatar = None, None
            await self._stop_process()

    async def _stop_process(self):
        if self.process and self.process.returncode is None:
            with suppress(ProcessLookupError):
                os.killpg(self.process.pid, signal.SIGTERM)
            try:
                await asyncio.wait_for(self.process.wait(), 5)
            except TimeoutError:
                with suppress(ProcessLookupError):
                    os.killpg(self.process.pid, signal.SIGKILL)
                await self.process.wait()
        self.process = None

    async def close(self):
        for task in list(self.tasks):
            task.cancel()
        if self.tasks:
            await asyncio.gather(*list(self.tasks), return_exceptions=True)
        await self.stop()
