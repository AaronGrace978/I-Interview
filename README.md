# I / Interview

An Electron desktop application for **disclosed AI interview representation**. Your delegate answers on your behalf from your resume and approved facts. Interview practice is a separate, optional mode.

This is an initial implementation, not a production-certified release. External interview-service integrations, animated avatars, signed distribution, and live provider validation remain release prerequisites where applicable. It does not secretly impersonate a person, join third-party calls, or install virtual camera/audio drivers.

## What works

- Local PDF/TXT/Markdown resume extraction and review (10 MB, 15 PDF pages, 24,000 characters). Image-only PDFs require pasted text; OCR is not included.
- Local portrait import. The portrait is static, not a generated video or lip-synced avatar.
- Primary AI delegate room: interviewer questions, streamed answers grounded by instructions in approved facts, cancellation, conversation history, and JSON transcript export. Instructions reduce hallucinations but do not guarantee factual accuracy; supervise responses.
- OpenAI, Anthropic, OpenRouter, xAI, and Ollama Cloud adapters. Model catalogs are fetched live, with exact-ID entry for new models. Catalog availability does not mean every model supports text chat, tool use, or this request format. No automatic cross-provider fallback or claims that every newly released model is validated.
- Visible microphone recording with speaker consent, bounded to 60 seconds. OpenAI transcription fills a reviewable question; submitting the question is an explicit action. Answer generation can use any supported provider independently.
- ElevenLabs consented instant voice creation, verification-required status, voice deletion, streaming MP3 synthesis through `eleven_flash_v2_5`, and sentence-level playback while answer generation continues. Provider plan and verification requirements apply.
- First-token, full-response, and first-audible-playback timing. No fixed latency promise; MP3 streaming falls back to buffering if MSE is unsupported.
- Local five-question practice without credentials, plus optional provider coaching.
- OS-encrypted provider keys through Electron `safeStorage`; Linux plaintext fallback is refused. Renderer Node access is disabled; context isolation, sandboxing, a narrow validated IPC bridge, sender validation, CSP, and blocked navigation are enabled.
- Stable-release updater for signed Windows/macOS distributions: check at launch and every four hours, background download, installation on quit, and a manual restart button. Linux updates are manual.

## Development

Use Node.js 24 and the existing checkout. Each cloud task is isolated; do not create a worktree unless explicitly requested.

```sh
npm ci
npm run desktop:dev
```

`desktop:dev` compiles the native bridge, starts Vite on port 1420, waits for readiness, and launches Electron. Restart it after changing `electron/` files. On Linux, Electron needs GTK/NSS/GBM/audio libraries and an X11 or Wayland session. Secure API-key storage additionally needs a working Secret Service/keyring. The app never falls back to plaintext keys.

For a browser-only preview, use `npm run dev`. Resume import, portrait preview, and local practice work there; native provider, voice, and updater functions intentionally require Electron. This is not a separately deployed web platform.

If npm lifecycle scripts are disabled in a managed environment, install the checksum-verified Electron binary explicitly:

```sh
NODE_USE_ENV_PROXY=1 node node_modules/electron/install.js
```

Keep TLS and checksum verification enabled. No Rust or Tauri prerequisites are required.

## First interview

1. In Identity studio, import your resume, review the extracted text, and enter your name and target role. Add a portrait if desired.
2. In Connections, save your provider keys. They are encrypted in Electron's user-data credential directory using your OS store. API billing belongs to your accounts. Do not put keys in source, environment examples, screenshots, or transcripts.
3. Optionally upload a clean recording of your **own** voice, confirm consent, and create a voice. Complete provider verification if required. Preview it in Identity studio. A saved voice ID is kept in memory for this session; closing the app does not delete the provider-stored voice.
4. Open Interview delegate, choose a provider, refresh its models, and select a compatible text model or enter an exact model ID. Add additional approved facts.
5. Inform the interviewer and obtain permission for AI participation. Confirm the disclosure and provider-sharing checkbox. Enter their question, or record it with separate transcription consent. Review the transcription.
6. Select **Answer on my behalf**. Turn on automatic speech if you want answers read in your consented voice. **Stop now** cancels generation and speech. Failed or interrupted model responses are not committed to conversation history.
7. Export the session before closing. A conversation is limited to 19 turns to bound context and costs. Start a fresh interview to change the model or approved facts.

The delegate identifies itself as an AI representative and speaks about the candidate in the third person. It is a supervised representative, not a hidden answer feed.

## Data and networking

Resume, portrait, approved facts, questions, answers, and voice reference are in memory, not browser storage. Exported transcripts omit resume contents but can include sensitive answers. Closing or clearing the workspace removes local in-memory data. Provider retention/billing policies apply to data sent to them.

Delete a created voice before clearing the workspace, or manage it directly in ElevenLabs afterward. Clearing local data and removing API keys do not delete voices from the provider. No analytics, background recording, or background resume upload is included.

Required outbound destinations depend on enabled features:

| Feature                                          | Destination                                         |
| ------------------------------------------------ | --------------------------------------------------- |
| OpenAI answers/models and question transcription | `api.openai.com`                                    |
| Anthropic                                        | `api.anthropic.com`                                 |
| OpenRouter                                       | `openrouter.ai`                                     |
| xAI                                              | `api.x.ai`                                          |
| Ollama Cloud                                     | `ollama.com`                                        |
| Voice cloning and streaming                      | `api.elevenlabs.io`                                 |
| Dependencies and release updates                 | npm registry, GitHub and GitHub release asset hosts |

Requests have fixed provider endpoints, bounded output and timeouts, cancellation, no silent retries, and no redirect-following for credential-bearing provider calls. The app does not accept arbitrary provider base URLs.

## Validation

```sh
npm test
npm run build
npx playwright install chromium
npm run test:e2e
npm run test:desktop   # a real graphical session is required
npm audit --omit=dev --audit-level=high
npm run desktop:package
```

Linux CI uses `xvfb-run -a npm run test:desktop`. Browser integration tests simulate provider IPC to verify consent, streaming UI, model selection, cancellation, errors, export, and local practice without billing an API account. Provider adapters have transport/parser tests. These are not a substitute for live API, voice quality, device/audio, and signed-update acceptance checks.

In this managed cloud machine, `bash scripts/cloud-display.sh` starts or reuses an isolated dummy Xorg display. Then use `export DISPLAY=:99` before launching Electron or running desktop tests. This helper does not install a keyring or create production audio devices. `tests/fixtures/test-tone.mp3` is a synthetic 440 Hz tone used to test streamed audio playback without cloning a real person or calling a paid provider.

## Packaging and updates

`npm run desktop:package` builds local installers without publishing. CI validates browser workflows and packages Windows/macOS builds. It does not publish on push.

The manual **Build signed release draft** workflow requires an existing version tag matching `package.json` and a GitHub `release` environment. Configure repository/environment secrets securely:

- Windows: `WINDOWS_CSC_LINK` (PFX path/URL/base64 as supported by electron-builder), `WINDOWS_CSC_KEY_PASSWORD`.
- macOS: `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` for signing and notarization.

The release job refuses missing signing requirements and forces code signing. Protect the `release` environment and version tags. Inspect signed artifacts and update metadata in the draft, test a previous-version-to-new-version update on both operating systems, then publish the GitHub release. The updater only offers published stable releases. Main-branch source pushes do not update installed apps; draft release artifacts are not distributed by the updater.

Until signing credentials and a published release exist, updater behavior is implemented but release distribution is **not operational**. No API secrets or signing certificates are bundled.
