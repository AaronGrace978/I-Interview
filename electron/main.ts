import {
  app,
  BrowserWindow,
  ipcMain,
  safeStorage,
  net,
  session,
  protocol,
} from "electron";
import updater from "electron-updater";
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  keyProviderSchema,
  providerSchema,
  requestSchema,
  type KeyProvider,
  type UpdateStatus,
  type StreamEvent,
} from "../src/contracts.js";
import {
  chatBody,
  endpoints,
  EventDecoder,
  headers,
  modelIds,
  streamCompleted,
  tokenFromFrame,
} from "./providers.js";

const { autoUpdater } = updater;
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
protocol.registerSchemesAsPrivileged([
  {
    scheme: "interview",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);
const dev = !app.isPackaged && process.env.INTERVIEW_DEV === "1";
let window: BrowserWindow | null = null;
let generation: { id: string; controller: AbortController } | null = null;
let speechController: AbortController | null = null;
let updateStatus: UpdateStatus = {
  state: "idle",
  message: "No update check yet.",
};
const voiceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const credentialDir = () => join(app.getPath("userData"), "credentials");
const credentialPath = (provider: KeyProvider) =>
  join(credentialDir(), `${provider}.enc`);
function safeEncryption() {
  if (
    !safeStorage.isEncryptionAvailable() ||
    (process.platform === "linux" &&
      safeStorage.getSelectedStorageBackend() === "basic_text")
  ) {
    throw new Error(
      "A secure OS credential store is unavailable. Enable Keychain, Windows DPAPI, or a Linux Secret Service keyring. Plaintext fallback is disabled.",
    );
  }
}
async function getKey(provider: KeyProvider): Promise<string> {
  safeEncryption();
  let bytes: Buffer;
  try {
    bytes = await readFile(credentialPath(provider));
  } catch {
    throw new Error(`Connect ${provider} in Connections first.`);
  }
  try {
    return safeStorage.decryptString(bytes);
  } catch {
    throw new Error(
      `Could not decrypt the ${provider} key. Save it again in Connections.`,
    );
  }
}
function sendToken(event: StreamEvent) {
  if (window && !window.isDestroyed())
    window.webContents.send("interview:token", event);
}
function sendUpdate(status: UpdateStatus) {
  updateStatus = status;
  if (window && !window.isDestroyed())
    window.webContents.send("updates:status", status);
}
function audioEvent(event: {
  type: string;
  data?: Uint8Array;
  error?: string;
}) {
  if (window && !window.isDestroyed())
    window.webContents.send("voice:audio", event);
}
function authorize(event: Electron.IpcMainInvokeEvent) {
  if (
    !window ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame
  )
    throw new Error("Untrusted IPC sender.");
  const url = new URL(event.senderFrame.url);
  const trusted = dev
    ? url.origin === "http://127.0.0.1:1420"
    : url.protocol === "interview:" &&
      url.hostname === "bundle" &&
      url.pathname === "/index.html";
  if (!trusted) throw new Error("Untrusted document.");
}
function handle(
  channel: string,
  callback: (data: unknown) => unknown | Promise<unknown>,
) {
  ipcMain.handle(channel, async (event, data) => {
    authorize(event);
    return callback(data);
  });
}
function providerError(status: number): Error {
  const explanation =
    status === 401 || status === 403
      ? "Check your API key and model access."
      : status === 429
        ? "Rate limit or quota reached. Wait before retrying; no automatic retry was made."
        : status === 404
          ? "The model or endpoint was not found. Refresh the model catalog or enter a supported model ID."
          : status === 400 || status === 422
            ? "This model rejected the request format. Try a text chat model supported by this provider."
            : "The provider is unavailable. Try again later.";
  return new Error(`Provider request failed (${status}). ${explanation}`);
}
async function checkedFetch(url: string, init: RequestInit): Promise<Response> {
  // Destinations come only from fixed endpoints, never renderer input.
  const response = await net.fetch(url, { ...init, redirect: "error" });
  if (!response.ok) {
    await response.body?.cancel();
    throw providerError(response.status);
  }
  return response;
}
async function jsonResponse(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Empty provider response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 8_000_000)
        throw new Error("Provider response exceeds the size limit.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
async function streamGeneration(input: unknown) {
  const r = requestSchema.parse(input);
  if (generation)
    throw new Error(
      "A response is already running. Stop it before starting another.",
    );
  const key = await getKey(r.provider);
  // Recheck after asynchronous credential access to avoid overlapping requests.
  if (generation) throw new Error("A response is already running.");
  const controller = new AbortController();
  generation = { id: r.id, controller };
  const started = performance.now();
  let firstTokenMs = 0;
  let textLength = 0;
  let bytes = 0;
  let completed = false;
  let idleTimer = setTimeout(
    () =>
      controller.abort(
        new Error("The provider did not respond within 45 seconds."),
      ),
    45_000,
  );
  const totalTimer = setTimeout(
    () =>
      controller.abort(new Error("Response exceeded the two-minute limit.")),
    120_000,
  );
  const emit = (frames: string[]) => {
    for (const frame of frames) {
      completed ||= streamCompleted(r.provider, frame);
      const token = tokenFromFrame(r.provider, frame);
      if (!token) continue;
      textLength += token.length;
      if (textLength > 6000)
        throw new Error("The model response exceeded the length limit.");
      if (!firstTokenMs) firstTokenMs = Math.round(performance.now() - started);
      sendToken({ id: r.id, type: "token", text: token });
    }
  };
  try {
    const response = await checkedFetch(endpoints[r.provider].chat, {
      method: "POST",
      headers: headers(r.provider, key),
      body: JSON.stringify(chatBody(r)),
      signal: controller.signal,
    });
    if (!response.body) throw new Error("Provider returned an empty stream.");
    const parser = new EventDecoder(r.provider === "ollama");
    const reader = response.body.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > 4_000_000)
          throw new Error("Provider stream exceeds the size limit.");
        clearTimeout(idleTimer);
        idleTimer = setTimeout(
          () =>
            controller.abort(
              new Error("Provider stream stalled for 30 seconds."),
            ),
          30_000,
        );
        emit(parser.push(value));
        if (completed) break;
      }
      emit(parser.push(new Uint8Array(), true));
      if (!completed)
        throw new Error(
          "The provider stream ended before completion. The partial answer was not added to conversation history.",
        );
      if (!textLength)
        throw new Error(
          "This model returned no text. Choose a text chat model or check its output token requirements.",
        );
      sendToken({
        id: r.id,
        type: "complete",
        firstTokenMs,
        totalMs: Math.round(performance.now() - started),
      });
    } finally {
      await reader.cancel().catch(() => {});
    }
  } catch (e) {
    const message = controller.signal.aborted
      ? controller.signal.reason instanceof Error
        ? controller.signal.reason.message
        : "Response stopped."
      : e instanceof Error
        ? e.message
        : "Provider request failed.";
    sendToken({ id: r.id, type: "error", error: message });
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(totalTimer);
    if (generation?.id === r.id) generation = null;
  }
}
function registerHandlers() {
  handle("credentials:status", async () => {
    const status: Partial<Record<KeyProvider, boolean>> = {};
    for (const provider of keyProviderSchema.options) {
      try {
        await getKey(provider);
        status[provider] = true;
      } catch {
        status[provider] = false;
      }
    }
    return status;
  });
  handle("credentials:save", async (input) => {
    const { provider, key } = z
      .object({
        provider: keyProviderSchema,
        key: z
          .string()
          .trim()
          .min(10)
          .max(512)
          .regex(/^[\x21-\x7e]+$/),
      })
      .parse(input);
    safeEncryption();
    await mkdir(credentialDir(), { recursive: true, mode: 0o700 });
    const tmp = join(credentialDir(), `${provider}-${randomUUID()}.tmp`);
    try {
      await writeFile(tmp, safeStorage.encryptString(key), {
        mode: 0o600,
        flag: "wx",
      });
      await rename(tmp, credentialPath(provider));
    } finally {
      await unlink(tmp).catch(() => {});
    }
  });
  handle("credentials:delete", async (input) => {
    const provider = keyProviderSchema.parse(input);
    await unlink(credentialPath(provider)).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
    });
  });
  handle("models:list", async (input) => {
    const provider = providerSchema.parse(input);
    const key = await getKey(provider);
    const timeout = AbortSignal.timeout(20_000);
    const json = await jsonResponse(
      await checkedFetch(endpoints[provider].models, {
        headers: headers(provider, key),
        signal: timeout,
      }),
    );
    const ids = modelIds(provider, json);
    if (provider === "anthropic") {
      // Anthropic paginates its catalog; exhaust it rather than silently dropping models.
      let page = json as { has_more?: boolean; last_id?: string };
      let pages = 0;
      while (page.has_more) {
        if (++pages > 50 || !page.last_id || !/^[\w.-]+$/.test(page.last_id))
          throw new Error(
            "Model pagination could not be completed. Use an exact model ID.",
          );
        const next = await jsonResponse(
          await checkedFetch(
            `${endpoints.anthropic.models}&after_id=${encodeURIComponent(page.last_id)}`,
            { headers: headers(provider, key), signal: timeout },
          ),
        );
        ids.push(...modelIds(provider, next));
        page = next as typeof page;
      }
    }
    return [...new Set(ids)].sort();
  });
  handle("interview:generate", streamGeneration);
  handle("interview:cancel", (input) => {
    const id = z.string().uuid().parse(input);
    if (generation?.id === id)
      generation.controller.abort(new Error("Response stopped."));
  });
  handle("voice:clone", async (input) => {
    const { name, audio, mime } = z
      .object({
        name: z.string().trim().min(1).max(80),
        audio: z
          .instanceof(Uint8Array)
          .refine(
            (a) => a.byteLength >= 1024 && a.byteLength <= 10 * 1024 * 1024,
          ),
        mime: z.enum([
          "audio/mpeg",
          "audio/wav",
          "audio/x-wav",
          "audio/mp4",
          "audio/webm",
          "audio/ogg",
        ]),
        consent: z.literal(true),
      })
      .parse(input);
    const key = await getKey("elevenlabs");
    const form = new FormData();
    const extension = {
      "audio/mpeg": "mp3",
      "audio/wav": "wav",
      "audio/x-wav": "wav",
      "audio/mp4": "m4a",
      "audio/webm": "webm",
      "audio/ogg": "ogg",
    }[mime];
    form.append("name", name);
    form.append(
      "description",
      "Consented personal voice for disclosed AI interview representation.",
    );
    form.append(
      "files",
      new Blob([new Uint8Array(audio)], { type: mime }),
      `consented-recording.${extension}`,
    );
    const result = (await jsonResponse(
      await checkedFetch("https://api.elevenlabs.io/v1/voices/add", {
        method: "POST",
        headers: { "xi-api-key": key },
        body: form,
        signal: AbortSignal.timeout(90_000),
      }),
    )) as { voice_id?: string; requires_verification?: boolean };
    return {
      id: voiceIdSchema.parse(result.voice_id),
      verificationRequired: Boolean(result.requires_verification),
    };
  });
  handle("voice:delete", async (input) => {
    const id = voiceIdSchema.parse(input);
    const key = await getKey("elevenlabs");
    const response = await checkedFetch(
      `https://api.elevenlabs.io/v1/voices/${id}`,
      {
        method: "DELETE",
        headers: { "xi-api-key": key },
        signal: AbortSignal.timeout(20_000),
      },
    );
    await response.body?.cancel();
  });
  handle("voice:speak", async (input) => {
    const { id, text } = z
      .object({ id: voiceIdSchema, text: z.string().trim().min(1).max(6000) })
      .parse(input);
    speechController?.abort();
    const controller = new AbortController();
    speechController = controller;
    const timeout = setTimeout(() => {
      audioEvent({
        type: "error",
        error: "Voice provider timed out after 60 seconds.",
      });
      controller.abort();
    }, 60_000);
    try {
      const key = await getKey("elevenlabs");
      const response = await checkedFetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${id}/stream?output_format=mp3_44100_128`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "xi-api-key": key },
          body: JSON.stringify({
            text,
            model_id: "eleven_flash_v2_5",
            voice_settings: { stability: 0.5, similarity_boost: 0.75 },
          }),
          signal: controller.signal,
        },
      );
      if (!response.body) throw new Error("Voice provider returned no audio.");
      const reader = response.body.getReader();
      let bytes = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > 12_000_000)
            throw new Error("Audio exceeded the size limit.");
          if (!controller.signal.aborted)
            audioEvent({ type: "chunk", data: value });
        }
        if (!bytes) throw new Error("No audio received.");
        if (!controller.signal.aborted) audioEvent({ type: "end" });
      } finally {
        await reader.cancel().catch(() => {});
      }
    } catch (e) {
      if (!controller.signal.aborted)
        audioEvent({
          type: "error",
          error: e instanceof Error ? e.message : "Voice generation failed.",
        });
    } finally {
      clearTimeout(timeout);
      if (speechController === controller) speechController = null;
    }
  });
  handle("voice:stop", () => {
    speechController?.abort();
    speechController = null;
  });
  handle("audio:transcribe", async (input) => {
    const { audio, mime } = z
      .object({
        audio: z
          .instanceof(Uint8Array)
          .refine(
            (a) => a.byteLength >= 128 && a.byteLength <= 10 * 1024 * 1024,
          ),
        mime: z.enum(["audio/webm", "audio/mp4", "audio/ogg"]),
        consent: z.literal(true),
      })
      .parse(input);
    const key = await getKey("openai");
    const form = new FormData();
    const extension = {
      "audio/webm": "webm",
      "audio/mp4": "m4a",
      "audio/ogg": "ogg",
    }[mime];
    form.append("model", "gpt-4o-mini-transcribe");
    form.append(
      "file",
      new Blob([new Uint8Array(audio)], { type: mime }),
      `interviewer-question.${extension}`,
    );
    const result = (await jsonResponse(
      await checkedFetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { authorization: `Bearer ${key}` },
        body: form,
        signal: AbortSignal.timeout(45_000),
      }),
    )) as { text?: string };
    return z.string().trim().min(1).max(6000).parse(result.text);
  });
  handle("updates:check", async () => {
    if (!app.isPackaged || !["win32", "darwin"].includes(process.platform)) {
      sendUpdate({
        state: "disabled",
        message:
          "Automatic updates require a signed Windows or macOS release. Linux updates are manual.",
      });
      return;
    }
    await autoUpdater.checkForUpdates();
  });
  handle("updates:status", () => updateStatus);
  handle("updates:download", async () => {
    if (updateStatus.state !== "available")
      throw new Error("No update is available.");
    await autoUpdater.downloadUpdate();
  });
  handle("updates:install", () => {
    if (updateStatus.state !== "downloaded")
      throw new Error("No downloaded update is ready.");
    if (generation || speechController)
      throw new Error("Stop the active interview and speech before updating.");
    autoUpdater.quitAndInstall();
  });
}
function configureUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.on("checking-for-update", () =>
    sendUpdate({ state: "checking", message: "Checking stable releases…" }),
  );
  autoUpdater.on("update-available", (info) =>
    sendUpdate({
      state: "available",
      message: `Version ${info.version} is available. Downloading in the background.`,
    }),
  );
  autoUpdater.on("update-not-available", () =>
    sendUpdate({
      state: "current",
      message: "You are on the latest stable release.",
    }),
  );
  autoUpdater.on("download-progress", (p) =>
    sendUpdate({
      state: "downloading",
      message: "Downloading verified update…",
      percent: p.percent,
    }),
  );
  autoUpdater.on("update-downloaded", (info) =>
    sendUpdate({
      state: "downloaded",
      message: `Version ${info.version} is ready. Export your session, then restart to install.`,
    }),
  );
  autoUpdater.on("error", () =>
    sendUpdate({
      state: "error",
      message:
        "Update check failed. Check your connection and that a signed release has been published.",
    }),
  );
}
async function createWindow() {
  window = new BrowserWindow({
    width: 1370,
    height: 960,
    minWidth: 800,
    minHeight: 650,
    backgroundColor: "#f7f8f5",
    title: "I / Interview",
    icon: join(root, "dist/icon.png"),
    show: false,
    webPreferences: {
      preload: join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  window.once("ready-to-show", () => window?.show());
  window.on("closed", () => {
    generation?.controller.abort();
    speechController?.abort();
    window = null;
  });
  if (dev) await window.loadURL("http://127.0.0.1:1420");
  else await window.loadURL("interview://bundle/index.html");
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
  app
    .whenReady()
    .then(async () => {
      protocol.handle("interview", async (request) => {
        try {
          const url = new URL(request.url);
          if (url.hostname !== "bundle" || request.method !== "GET")
            return new Response("Forbidden", { status: 403 });
          const dist = join(root, "dist");
          const path = resolve(dist, `.${decodeURIComponent(url.pathname)}`);
          if (!path.startsWith(`${dist}${sep}`))
            return new Response("Forbidden", { status: 403 });
          return await net.fetch(pathToFileURL(path).toString());
        } catch {
          return new Response("Not found", { status: 404 });
        }
      });
      session.defaultSession.setPermissionRequestHandler(
        (wc, permission, callback, details) => {
          const types =
            "mediaTypes" in details ? (details.mediaTypes ?? []) : [];
          callback(
            wc === window?.webContents &&
              permission === "media" &&
              types.length > 0 &&
              types.every((type) => type === "audio"),
          );
        },
      );
      session.defaultSession.setPermissionCheckHandler(
        (wc, permission, _origin, details) =>
          wc === window?.webContents &&
          permission === "media" &&
          details.mediaType === "audio",
      );
      session.defaultSession.on("will-download", (event, item, sender) => {
        if (
          sender !== window?.webContents ||
          !item.getURL().startsWith("blob:") ||
          item.getMimeType() !== "application/json"
        ) {
          event.preventDefault();
          return;
        }
        item.setSaveDialogOptions({
          title: "Export interview transcript",
          filters: [{ name: "Interview transcript", extensions: ["json"] }],
        });
      });
      session.defaultSession.webRequest.onHeadersReceived(
        (details, callback) => {
          const csp = `default-src 'self'; script-src 'self'${dev ? " 'unsafe-inline'" : ""}; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src blob:; connect-src 'self'${dev ? " ws://127.0.0.1:1420 http://127.0.0.1:1420" : ""}; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
          callback({
            responseHeaders: {
              ...details.responseHeaders,
              "Content-Security-Policy": [csp],
            },
          });
        },
      );
      registerHandlers();
      configureUpdater();
      await createWindow();
      if (app.isPackaged && ["win32", "darwin"].includes(process.platform)) {
        void autoUpdater.checkForUpdates().catch(() => {});
        const timer = setInterval(
          () => {
            void autoUpdater.checkForUpdates().catch(() => {});
          },
          4 * 60 * 60 * 1000,
        );
        timer.unref();
      }
    })
    .catch(() => {
      console.error(
        "Desktop initialization failed. Check OS GUI libraries and credential-store availability.",
      );
      app.quit();
    });
  app.on("activate", () => {
    if (!window) void createWindow();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
