"""Provision isolated local runtimes on Linux/WSL2, without changing source.

Run with Python 3.12 after installing uv, ffmpeg, git, cmake, a C++ compiler,
and verifying that WSL2 can see the NVIDIA GPU through the Windows driver.
"""

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

from sources import CHATTERBOX_COMMIT, LIVETALKING_COMMIT, PERTH_COMMIT


def run(*command, **options):
    subprocess.run([str(part) for part in command], check=True, **options)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--skip-models",
        action="store_true",
        help="Install runtimes only; model downloads remain required.",
    )
    args = parser.parse_args()
    if sys.platform != "linux":
        raise SystemExit(
            "Run the engine in Linux/WSL2. The Electron app can remain native Windows."
        )
    for command in ["uv", "git", "ffmpeg", "cmake", "c++", "nvidia-smi"]:
        if not shutil.which(command):
            raise SystemExit(
                f"Missing prerequisite: {command}. See avatar-engine/README.md."
            )
    run("nvidia-smi")
    state = Path(
        os.environ.get("INTERVIEW_AVATAR_STATE", Path.home() / ".i-interview-avatar")
    ).resolve()
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    root = Path(__file__).parent.resolve()
    vendor = state / "LiveTalking"
    if not vendor.exists():
        run(
            "git",
            "clone",
            "--no-checkout",
            "https://github.com/lipku/LiveTalking.git",
            vendor,
        )
        run("git", "-C", vendor, "checkout", "--detach", LIVETALKING_COMMIT)
    actual = subprocess.check_output(
        ["git", "-C", str(vendor), "rev-parse", "HEAD"], text=True
    ).strip()
    dirty = subprocess.check_output(
        ["git", "-C", str(vendor), "status", "--porcelain", "--untracked-files=no"],
        text=True,
    ).strip()
    if actual != LIVETALKING_COMMIT or dirty:
        raise SystemExit(
            "The existing engine checkout differs from the pinned source. Preserve it and choose a separate INTERVIEW_AVATAR_STATE directory; setup will not reset it."
        )
    for name in ["gateway-env", "video-env", "voice-env"]:
        directory = state / name
        if not directory.exists():
            run("uv", "venv", "--python", "3.12", directory)
    gateway = state / "gateway-env/bin/python"
    video = state / "video-env/bin/python"
    voice = state / "voice-env/bin/python"
    run("uv", "pip", "install", "--python", gateway, "-r", root / "pyproject.toml")
    run(
        "uv",
        "pip",
        "install",
        "--python",
        video,
        "torch==2.9.1",
        "torchvision==0.24.1",
        "torchaudio==2.9.1",
        "--index-url",
        "https://download.pytorch.org/whl/cu128",
    )
    run(
        "uv",
        "pip",
        "install",
        "--python",
        video,
        "-r",
        vendor / "requirements.txt",
        "-r",
        root / "video-requirements.txt",
        "-c",
        root / "video-constraints.txt",
    )
    run(video, root / "gpu_probe.py")
    # CPU-only PyTorch for voice prevents older Chatterbox pins from replacing
    # the Blackwell-capable CUDA environment.
    run(
        "uv",
        "pip",
        "install",
        "--python",
        voice,
        "torch==2.6.0",
        "torchaudio==2.6.0",
        "--index-url",
        "https://download.pytorch.org/whl/cpu",
    )
    overrides = state / "voice-overrides.txt"
    overrides.write_text(
        f"resemble-perth @ git+https://github.com/resemble-ai/Perth.git@{PERTH_COMMIT}\n"
    )
    run(
        "uv",
        "pip",
        "install",
        "--python",
        voice,
        "--override",
        overrides,
        f"chatterbox-tts @ git+https://github.com/resemble-ai/chatterbox.git@{CHATTERBOX_COMMIT}",
        "-r",
        root / "pyproject.toml",
    )
    run(
        voice,
        "-c",
        "import torch; assert torch.version.cuda is None, 'Voice runtime must remain CPU-only'; from chatterbox.tts_turbo import ChatterboxTurboTTS",
    )
    if not args.skip_models:
        run(video, root / "download_models.py", vendor)
    for name in ["gateway-env", "video-env", "voice-env"]:
        result = subprocess.check_output(
            ["uv", "pip", "freeze", "--python", str(state / name / "bin/python")],
            text=True,
        )
        (state / f"{name}-installed.txt").write_text(result)
    print(
        "Local runtimes installed. Model downloads are still required."
        if args.skip_models
        else "Local runtimes and model files installed. Create your own replica and run a real video test before claiming readiness."
    )
    print("Start gateway: " + str(gateway) + " " + str(root / "server.py"))
    print("Start voice:   " + str(voice) + " " + str(root / "voice_server.py"))


if __name__ == "__main__":
    main()
