"""Validate generated local tensor/frame alignment before marking an avatar ready."""

import sys
from pathlib import Path


def validate(directory):
    import torch

    root = Path(directory)
    latents = torch.load(root / "latents.pt", map_location="cpu", weights_only=True)
    frames = list((root / "full_imgs").glob("*.png"))
    masks = list((root / "mask").glob("*.png"))
    if (
        not isinstance(latents, list)
        or len(latents) < 25
        or len(latents) != len(frames)
        or len(masks) != len(frames)
    ):
        raise RuntimeError(
            "Face preparation did not produce aligned frames, masks, and latents. Record a clear uninterrupted view of your face."
        )
    if not all(
        isinstance(item, torch.Tensor) and torch.isfinite(item).all().item()
        for item in latents
    ):
        raise RuntimeError("Generated avatar tensors contain invalid values.")


if __name__ == "__main__":
    validate(sys.argv[1])
