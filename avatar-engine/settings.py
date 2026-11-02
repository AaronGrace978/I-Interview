"""Local-only configuration. Reference footage and generated caches stay here."""

import os
import secrets
import uuid
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    state: Path
    vendor: Path
    video_python: Path
    token: str
    renderer_url: str = "http://127.0.0.1:17861"
    voice_url: str = "http://127.0.0.1:17862"

    @classmethod
    def load(cls):
        state = Path(
            os.environ.get(
                "INTERVIEW_AVATAR_STATE", Path.home() / ".i-interview-avatar"
            )
        ).resolve()
        state.mkdir(parents=True, exist_ok=True, mode=0o700)
        token_file = state / "engine-token"
        if not token_file.exists():
            temporary = state / f"engine-token-{uuid.uuid4()}.tmp"
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "w") as file:
                file.write(secrets.token_urlsafe(32))
            try:
                os.link(temporary, token_file)
            except FileExistsError:
                pass
            finally:
                temporary.unlink(missing_ok=True)
        token = token_file.read_text().strip()
        if len(token) < 32:
            raise RuntimeError("The engine token must contain at least 32 characters.")
        vendor = Path(
            os.environ.get("INTERVIEW_LIVETALKING_ROOT", state / "LiveTalking")
        ).resolve()
        # absolute(), not resolve(): the venv interpreter is a symlink to system
        # Python, and following it drops the virtual environment.
        video_python = Path(
            os.environ.get("INTERVIEW_VIDEO_PYTHON", state / "video-env/bin/python")
        ).absolute()
        return cls(state, vendor, video_python, token)
