# Self-hosted video replica — Aaron's workstation profile

Target: **NVIDIA RTX 5060 Ti, 16 GB VRAM; Ryzen 7 3700X; 32 GB system RAM; Windows x64 with a Linux/WSL2 GPU engine**. Device IDs and Windows product IDs are not needed or stored.

This adds a real video pipeline to the Electron app. It uses a pinned [LiveTalking](https://github.com/lipku/LiveTalking) checkout with [MuseTalk 1.5](https://github.com/TMElyralab/MuseTalk) to animate the mouth in **your own prepared video**. The renderer returns synchronized audio/video over WebRTC. CPU [Chatterbox-Nano](https://github.com/resemble-ai/chatterbox) clones your voice from a local reference; your existing ElevenLabs voice is an alternative.

**Status:** gateway, IPC, upload validation, cancellation, and UI tests can run without a GPU. CUDA inference, actual likeness, frame rate, lip synchronization, voice similarity, and WSL2-to-Windows media connectivity still need validation on your workstation. This cloud workspace has no GPU. No stock-person video or simulated frames are presented as your replica.

## Why two inference environments

The RTX 5060 Ti is a Blackwell GPU. The video environment is pinned to **PyTorch 2.9.1 / torchvision 0.24.1 / torchaudio 2.9.1, CUDA 12.8**. Its probe checks `sm_120` support and executes a real FP16 convolution on the GPU. Seeing a GPU in `nvidia-smi` alone is insufficient.

The pinned Chatterbox source requires an older PyTorch on Python 3.12. It runs in a **separate CPU-only environment**, with four CPU threads initially, so its dependency pins cannot downgrade the video CUDA stack. Nano is the starting voice model; its quality and speed on the Ryzen 3700X must be measured. The language model stays on your selected cloud provider by default to preserve VRAM for video.

The initial video profile is conservative: one session, batch size 4, a 25 fps scheduling target, and up to 12 seconds of reference motion bounded to 720 × 720 pixels. These are settings, not a measured performance claim. Smiles, blinks, and head motion come from the recorded footage; MuseTalk drives the mouth. This is not unrestricted whole-body or independently generated emotional animation.

## 1. Prepare Windows and WSL2

1. Install a current NVIDIA Windows driver that supports your RTX 5060 Ti and WSL2 CUDA. Do not install a separate Linux display driver inside WSL2.
2. Install/update WSL2 and an Ubuntu 24.04 distribution through Windows' supported WSL workflow. Restart Windows if its installer requires it.
3. Inside Ubuntu, run `nvidia-smi`. It must see your actual GPU. Install the Ubuntu prerequisites:

```sh
sudo apt-get update
sudo apt-get install -y python3.12 python3.12-venv git ffmpeg build-essential cmake libsndfile1
```

Install [uv](https://docs.astral.sh/uv/getting-started/installation/) using its official instructions, keeping TLS/checksum validation enabled. Clone this repository inside the WSL Linux filesystem, not a synchronized/cloud-storage directory.

Keep enough free space for three Python environments, model caches, and prepared frame caches; a 40–60 GB working budget is a conservative starting allocation, not an exact download size. Your reported storage has room for that budget.

WSL2 may default to using only part of your 32 GB RAM. Check `free -h`. If needed, configure WSL's documented memory limits while preserving enough memory for Windows/Electron. An example budget is 22 GB for WSL and the remainder for Windows. Preserve any existing `.wslconfig` settings. Windows 11's mirrored networking can simplify WebRTC reachability; do not assume it is available on every Windows version.

## 2. Install the local engine

From the repository root inside WSL2:

```sh
python3.12 avatar-engine/setup_local.py
```

The script checks the host tools, clones an exact upstream commit into `~/.i-interview-avatar/LiveTalking`, creates isolated gateway/video/voice environments, installs the CUDA 12.8 video wheels and CPU-only voice wheels, runs the real GPU probe, and downloads the model files. It preserves an existing modified engine checkout rather than resetting it. Source references are in `sources.py`; installed packages are recorded in `~/.i-interview-avatar/*-installed.txt`.

Model downloads use the repositories linked by the upstream MuseTalk project. Hugging Face revisions are recorded as immutable commit IDs and reused. Known hash prefixes are checked where supplied by the publisher. Additional model file hashes are recorded for subsequent integrity checks; those first-download hashes are not publisher signatures. TLS verification remains enabled. If a hash changes, investigate or restore the original; do not change the recorded hash merely to silence the failure.

The setup script and model inference have **not** been executed on an RTX 5060 Ti in this cloud task. Dependency/build issues on the target machine must be diagnosed from the actual install output. `--skip-models` only postpones downloads; it does not make video inference ready.

## 3. Start the local processes

Use two WSL terminals, both in this repository:

```sh
~/.i-interview-avatar/gateway-env/bin/python avatar-engine/server.py
```

```sh
~/.i-interview-avatar/voice-env/bin/python avatar-engine/voice_server.py
```

The authenticated gateway listens only on `127.0.0.1:17860`; CPU voice listens on `127.0.0.1:17862`. The private renderer is started on demand on `127.0.0.1:17861`. Its wrapper restricts the upstream executable's wildcard HTTP bind to loopback, requires the local token, and rejects browser-origin control requests. Do not expose those private services or open unrestricted UDP/TCP ports to the Internet.

The gateway creates a random token in `~/.i-interview-avatar/engine-token` with restrictive Linux permissions. Enter that token directly into the Electron app's **Video replica → Local engine token** field. Do not paste it into chat or source. Electron stores it with the OS credential store and sends control requests only to the fixed loopback endpoint. The renderer process does not receive the token or arbitrary local file paths.

The native Windows Electron app must be able to reach WSL's localhost-forwarded port. WebRTC additionally needs reachable ICE candidates. The app uses receive-only tracks and no third-party STUN server. If the HTTP connection works but video does not, inspect WSL/Windows routing and candidate reachability. Validate this on the actual machine; the gateway responding does not prove the video transport works.

## 4. Create a replica that actually looks and sounds like you

1. Record a clear, well-lit video of **yourself** facing the camera. Include relaxed blinking, small head movements, and a natural smile. Avoid large turns, occlusion, and camera movement. The current profile uses the first 12 seconds and normalizes it to at most 720 × 720 pixels at 25 fps. Up to 150 MB is accepted.
2. Record 10–15 seconds of your own clean voice without music or another speaker. Up to 10 MB is accepted; the local engine normalizes the first 15 seconds to mono 24 kHz WAV.
3. In **Video replica**, save the engine token and select **Validate CUDA kernels**.
4. Confirm ownership/consent, choose a new replica ID, and select **Choose my footage and prepare**. The native file picker chooses the file; the renderer cannot request arbitrary file reads. Preparation runs locally and reports completed or failed status. A failed task is not marked ready. Existing replica IDs are preserved.
5. Select **Import my voice sample** for CPU Chatterbox. Its first synthesis can download/warm the voice model. Its built-in perceptual watermark remains enabled. Alternatively choose your own consented ElevenLabs voice.
6. Select the prepared replica and **Start my video replica**. Actual decoded frames must appear before video speech is enabled. The stage never substitutes a still photo or stock person for missing frames.
7. In **Interview delegate**, leave **Answer output** on **My self-hosted video replica**, enable automatic speech if desired, and use the selected LLM. Text is generated from approved resume/facts; sentence-level speech drives the lip-sync video. **Stop now** interrupts generation and the renderer's queued audio. A late voice result after an interruption is discarded.

The video is labeled as an AI representative. External interview-service integrations, a virtual camera driver, and virtual audio routing are not included. WSL2 rendering into the app must work first; output-device integration is a later, separately testable capability.

## Local data and licenses

Uploaded source footage is deleted after preprocessing. Generated frame/mask/latent caches remain under the engine's `data/avatars/<id>` directory. The normalized voice reference remains in `~/.i-interview-avatar/voice.wav`. Stopping or clearing the Electron workspace does not delete those GPU-machine assets. Treat them as sensitive personal data and delete them locally when no longer needed.

LiveTalking's source is Apache-2.0; MuseTalk's own code/model has its stated permissions. Other component models have separate terms. In particular, the pinned preprocessing path uses `face_recognition`/dlib landmark weights, whose provenance/usage restrictions need review or replacement before commercial redistribution. Preserve all upstream notices; do not infer an unrestricted license for every weight from the renderer's code license. Bundled upstream example people are not used as your identity. This integration is not yet independently security- or quality-audited.

## Developer validation without a GPU

```sh
uv sync --directory avatar-engine --frozen --group dev
avatar-engine/.venv/bin/python -m pytest avatar-engine/tests
npm test
npm run build
npm run test:e2e
```

The gateway tests exercise authenticated control, consent, ID validation, failure reporting, local WAV decoding, and interrupted-synthesis handling. They do not validate CUDA inference or identity quality. Capture real GPU memory, decoded frame rate, first video frame, renderer speech-start timing, audio/video synchronization, and repeated interruption behavior on your workstation before enabling a production release.

In this cloud task, the execution browser produced zero ICE candidates. The real-WebRTC test-pattern test therefore reports a capability-based skip rather than pretending that video transport passed. It keeps its actual connection/frame assertions for a runtime with available candidates. Run it again on your workstation; passing the remaining UI tests does not establish video readiness.
