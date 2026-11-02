"""Run with the VIDEO environment's Python, not the gateway or voice environment."""

import json


def probe():
    import torch

    result = {
        "torch": torch.__version__,
        "cuda": torch.version.cuda,
        "available": torch.cuda.is_available(),
    }
    if not result["available"]:
        raise RuntimeError(
            "CUDA is unavailable. Check the Windows NVIDIA driver and WSL2 GPU access."
        )
    properties = torch.cuda.get_device_properties(0)
    capability = torch.cuda.get_device_capability(0)
    if capability[0] >= 12 and "sm_120" not in torch.cuda.get_arch_list():
        raise RuntimeError(
            "This Blackwell GPU requires a wheel with sm_120 support. Install the pinned CUDA 12.8 video runtime."
        )
    # Actually execute CUDA kernels. Merely seeing the device is insufficient.
    sample = torch.randn(1, 3, 32, 32, device="cuda", dtype=torch.float16)
    weight = torch.randn(8, 3, 3, 3, device="cuda", dtype=torch.float16)
    torch.nn.functional.conv2d(sample, weight).sum().item()
    torch.cuda.synchronize()
    result.update(
        {
            "device": properties.name,
            "vram_gib": round(properties.total_memory / 2**30, 2),
            "capability": list(capability),
            "kernel_check": True,
        }
    )
    return result


if __name__ == "__main__":
    try:
        print(json.dumps(probe()))
    except (
        RuntimeError,
        OSError,
        ImportError,
        ValueError,
        TypeError,
        AttributeError,
    ) as error:
        print(json.dumps({"available": False, "error": str(error)}))
        raise SystemExit(1)
