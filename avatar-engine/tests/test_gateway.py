import asyncio
import io
import wave

import httpx
import pytest
from fastapi.testclient import TestClient
from runtime import Runtime
from server import create_app
from settings import Settings

TOKEN = "test-local-engine-token-" + "x" * 32


@pytest.fixture
def config(tmp_path):
    state = tmp_path / "state"
    state.mkdir()
    return Settings(
        state, tmp_path / "engine", tmp_path / "video-env/bin/python", TOKEN
    )


@pytest.fixture
def client(config):
    with TestClient(create_app(config)) as client:
        yield client


def headers():
    return {"Authorization": f"Bearer {TOKEN}"}


def test_local_api_requires_token_and_rejects_browser_origins(client):
    assert client.get("/v1/status").status_code == 401
    assert (
        client.get("/v1/status", headers={"Authorization": "Bearer wrong"}).status_code
        == 401
    )
    response = client.get(
        "/v1/status", headers={**headers(), "Origin": "https://untrusted.example"}
    )
    assert response.status_code == 403
    assert client.get("/v1/status", headers=headers()).status_code == 200


def test_missing_gpu_environment_is_reported_as_unavailable_not_ready(client):
    response = client.get("/v1/status", headers=headers())
    assert response.json()["configured"] is False
    assert response.json()["avatars"] == []
    probe = client.get("/v1/gpu", headers=headers())
    assert probe.status_code == 409
    assert "environment is missing" in probe.json()["detail"]


def test_only_own_prepared_avatars_are_listed(client, config):
    directory = config.vendor / "data/avatars"
    stock = directory / "stock_person"
    stock.mkdir(parents=True)
    (stock / "latents.pt").write_bytes(b"not an inference fixture")
    owned = directory / "aaron"
    owned.mkdir()
    (owned / "latents.pt").write_bytes(b"not an inference fixture")
    (owned / "i-interview-owned.json").write_text('{"consent":true}')
    assert client.get("/v1/status", headers=headers()).json()["avatars"] == ["aaron"]


def test_preparation_requires_ownership_and_rejects_path_traversal(client, config):
    files = {"video": ("reference.mp4", b"x" * 2048, "video/mp4")}
    denied = client.post(
        "/v1/avatars",
        headers=headers(),
        data={"avatar_id": "aaron", "consent": "false"},
        files=files,
    )
    assert denied.status_code == 400
    traversal = client.post(
        "/v1/avatars",
        headers=headers(),
        data={"avatar_id": "../another-person", "consent": "true"},
        files=files,
    )
    assert traversal.status_code == 422
    assert not (config.state / "uploads").exists()


def test_offer_rejects_undisclosed_and_unprepared_replicas(client):
    body = {"avatar_id": "aaron", "sdp": "v=0\r\nexample offer", "consent": False}
    assert client.post("/v1/offer", headers=headers(), json=body).status_code == 400
    body["consent"] = True
    response = client.post("/v1/offer", headers=headers(), json=body)
    assert response.status_code == 409
    assert "Prepare your own" in response.json()["detail"]


def test_failed_preparation_never_marks_a_replica_ready(client, config):
    response = client.post(
        "/v1/avatars",
        headers=headers(),
        data={"avatar_id": "aaron", "consent": "true"},
        files={"video": ("mine.mp4", b"x" * 2048, "video/mp4")},
    )
    assert response.status_code == 200
    task_id = response.json()["task_id"]
    # The real runtime immediately fails its missing CUDA-environment prerequisite.
    import time

    for _ in range(30):
        result = client.get(f"/v1/jobs/{task_id}", headers=headers()).json()
        if result["status"] == "failed":
            break
        time.sleep(0.01)
    assert result["status"] == "failed"
    assert client.get("/v1/status", headers=headers()).json()["avatars"] == []
    assert list((config.state / "uploads").iterdir()) == []


def test_voice_reference_is_decoded_locally_and_requires_consent(client, config):
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(24000)
        output.writeframes(b"\0\0" * 24000 * 5)
    files = {"audio": ("synthetic-test.wav", buffer.getvalue(), "audio/wav")}
    assert (
        client.post(
            "/v1/voice", headers=headers(), data={"consent": "false"}, files=files
        ).status_code
        == 400
    )
    result = client.post(
        "/v1/voice", headers=headers(), data={"consent": "true"}, files=files
    )
    assert result.status_code == 200
    with wave.open(str(config.state / "voice.wav"), "rb") as source:
        assert source.getframerate() == 24000
        assert source.getnchannels() == 1


def test_interrupt_during_voice_synthesis_prevents_late_audio_from_playing(config):
    async def scenario():
        entered, release = asyncio.Event(), asyncio.Event()
        forwarded = []

        async def transport(request):
            if request.url.path == "/v1/audio":
                entered.set()
                await release.wait()
                return httpx.Response(200, content=b"RIFF" + b"\0" * 100)
            if request.url.path == "/humanaudio":
                forwarded.append(request)
                return httpx.Response(200, json={"code": 0})
            if request.url.path == "/interrupt_talk":
                return httpx.Response(200, json={"code": 0})
            raise AssertionError(str(request.url))

        async with httpx.AsyncClient(
            transport=httpx.MockTransport(transport)
        ) as client:
            runtime = Runtime(config, client)
            runtime.session = "my-session"
            speech = asyncio.create_task(runtime.speak("Only approved facts."))
            await entered.wait()
            await runtime.interrupt()
            release.set()
            with pytest.raises(RuntimeError, match="interrupted"):
                await speech
            assert forwarded == []

    asyncio.run(scenario())


def test_renderer_wrapper_binds_loopback_and_requires_authentication(monkeypatch):
    from aiohttp import web
    from renderer_launcher import configure_private_web

    # Restore the real module factories after exercising their runtime wrappers.
    monkeypatch.setattr(web, "TCPSite", web.TCPSite)
    monkeypatch.setattr(web, "AppRunner", web.AppRunner)
    configure_private_web(web, TOKEN)

    async def scenario():
        application = web.Application()

        async def health(_request):
            return web.json_response({"ok": True})

        application.router.add_get("/health", health)
        runner = web.AppRunner(application)
        await runner.setup()
        site = web.TCPSite(runner, "0.0.0.0", 0)
        try:
            await site.start()
            host, port = runner.addresses[0]
            assert host == "127.0.0.1"
            async with httpx.AsyncClient(trust_env=False) as client:
                url = f"http://127.0.0.1:{port}/health"
                assert (await client.get(url)).status_code == 401
                assert (await client.get(url, headers=headers())).status_code == 200
                assert (
                    await client.get(
                        url,
                        headers={**headers(), "Origin": "https://untrusted.example"},
                    )
                ).status_code == 401
        finally:
            await runner.cleanup()

    asyncio.run(scenario())
