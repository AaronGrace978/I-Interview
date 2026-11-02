"""Download from upstream model sources, record immutable revisions and hashes."""

import hashlib
import json
import sys
from pathlib import Path

from huggingface_hub import HfApi, snapshot_download


def install(root: Path):
    models = root / "models"
    models.mkdir(exist_ok=True)
    manifest = {"repositories": [], "sha256": {}}
    sources = [
        (
            "TMElyralab/MuseTalk",
            ["musetalkV15/unet.pth", "musetalkV15/musetalk.json"],
            models,
        ),
        (
            "stabilityai/sd-vae-ft-mse",
            ["config.json", "diffusion_pytorch_model.*"],
            models / "sd-vae",
        ),
        (
            "openai/whisper-tiny",
            [
                "*.json",
                "*.safetensors",
                "pytorch_model.bin",
                "merges.txt",
                "normalizer.json",
                "vocab.json",
            ],
            models / "whisper",
        ),
    ]
    api = HfApi()
    lock = models / "i-interview-models.json"
    previous = json.loads(lock.read_text()) if lock.exists() else {}
    revisions = {
        repo["repository"]: repo["revision"]
        for repo in previous.get("repositories", [])
    }
    for repository, patterns, destination in sources:
        revision = revisions.get(repository) or api.model_info(repository).sha
        snapshot_download(
            repository,
            revision=revision,
            allow_patterns=patterns,
            local_dir=destination,
        )
        manifest["repositories"].append(
            {"repository": repository, "revision": revision}
        )
    # These additional sources are explicitly linked by the upstream MuseTalk
    # documentation. TLS verification remains enabled. Existing files are kept.
    import gdown

    face = models / "face-parse-bisent"
    face.mkdir(exist_ok=True)
    if not (face / "79999_iter.pth").exists():
        result = gdown.download(
            id="154JgKpzCPW82qINcVieuPH3fZ2e0P812",
            output=str(face / "79999_iter.pth"),
            quiet=False,
        )
        if not result:
            raise RuntimeError("The upstream face-parsing checkpoint download failed.")
    import torch

    if not (face / "resnet18-5c106cde.pth").exists():
        torch.hub.download_url_to_file(
            "https://download.pytorch.org/models/resnet18-5c106cde.pth",
            str(face / "resnet18-5c106cde.pth"),
            hash_prefix="5c106cde",
        )
    detector = root / "avatars/musetalk/utils/face_detection/detection/sfd/s3fd.pth"
    if not detector.exists():
        torch.hub.download_url_to_file(
            "https://www.adrianbulat.com/downloads/python-fan/s3fd-619a316812.pth",
            str(detector),
            hash_prefix="619a316812",
        )
    required = [
        models / "musetalkV15/unet.pth",
        models / "musetalkV15/musetalk.json",
        models / "sd-vae/config.json",
        models / "whisper/config.json",
        face / "79999_iter.pth",
        face / "resnet18-5c106cde.pth",
        detector,
    ]
    if (
        not any((models / "sd-vae").glob("diffusion_pytorch_model.*"))
        or not any((models / "whisper").glob("*.safetensors"))
        and not (models / "whisper/pytorch_model.bin").is_file()
    ):
        raise RuntimeError("The VAE or Whisper weight download is incomplete.")
    for path in required:
        if not path.is_file() or path.stat().st_size == 0:
            raise RuntimeError(
                f"Required model file is missing: {path.relative_to(root)}"
            )
    for path in [
        *models.rglob("*.pth"),
        *models.rglob("*.bin"),
        *models.rglob("*.safetensors"),
        detector,
    ]:
        digest = hashlib.sha256()
        with path.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        key = str(path.relative_to(root))
        actual = digest.hexdigest()
        expected = previous.get("sha256", {}).get(key)
        if expected and expected != actual:
            raise RuntimeError(
                f"Existing model checksum changed: {key}. Restore the trusted original; do not replace the recorded hash to suppress this error."
            )
        manifest["sha256"][key] = actual
    lock.write_text(json.dumps(manifest, indent=2) + "\n")
    print(
        "Recorded immutable model revisions and file hashes. First-download hashes record provenance; they are not publisher signatures."
    )


if __name__ == "__main__":
    install(Path(sys.argv[1]).resolve())
