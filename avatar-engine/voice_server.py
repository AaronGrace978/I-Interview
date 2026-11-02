"""Isolated CPU Chatterbox-Nano service. GPU video dependencies stay separate."""

import asyncio
import io
import secrets
import wave

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field
from settings import Settings

settings = Settings.load()
app = FastAPI(docs_url=None, redoc_url=None)
model = None
lock = asyncio.Lock()


class VoiceRequest(BaseModel):
    text: str = Field(min_length=1, max_length=2000)


def synthesize(text):
    global model
    from chatterbox.tts_turbo import ChatterboxTurboTTS

    reference = settings.state / "voice.wav"
    if not reference.is_file():
        raise RuntimeError(
            "Import your own voice sample in Video replica before speaking."
        )
    if model is None:
        import torch

        torch.set_num_threads(4)
        model = ChatterboxTurboTTS.from_pretrained(device="cpu", nano=True)
    audio = model.generate(text, audio_prompt_path=str(reference)).detach().cpu()
    # Keep Chatterbox's default perceptual watermark intact. This is merely PCM
    # container encoding; it does not remove or bypass the model's watermark.
    samples = (
        audio.squeeze()
        .clamp(-1, 1)
        .mul(32767)
        .to(dtype=__import__("torch").int16)
        .numpy()
        .astype("<i2", copy=False)
    )
    if samples.ndim != 1 or len(samples) > model.sr * 90:
        raise RuntimeError("Voice generation exceeded its duration limit.")
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(model.sr)
        output.writeframes(samples.tobytes())
    return buffer.getvalue()


@app.post("/v1/audio")
async def audio(request: Request, body: VoiceRequest):
    if request.headers.get("origin") or not secrets.compare_digest(
        request.headers.get("authorization", ""), f"Bearer {settings.token}"
    ):
        raise HTTPException(401, "Local voice authentication required.")
    if lock.locked():
        raise HTTPException(409, "The voice process is busy.")
    async with lock:
        try:
            result = await asyncio.to_thread(synthesize, body.text)
        except (RuntimeError, OSError, ValueError, ImportError, TypeError):
            raise HTTPException(
                503,
                "Local voice generation failed. Check the reference sample, model download, and voice-process console.",
            )
    return Response(result, media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=17862, access_log=False)
