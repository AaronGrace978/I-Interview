import type {
  DesktopBridge,
  GenerateRequest,
  KeyProvider,
  Provider,
} from "./contracts";
import {
  feedbackSchema,
  type Feedback,
  type Message,
  type Profile,
  MAX_FILE_SIZE,
  MAX_RESUME_LENGTH,
} from "./domain";
export const desktop = Boolean(window.interview);
export function bridge(): DesktopBridge {
  if (!window.interview)
    throw new Error(
      "This action requires the Electron desktop app. Local practice works in browser preview.",
    );
  return window.interview;
}
export async function readResume(file: File): Promise<string> {
  if (file.size > MAX_FILE_SIZE)
    throw new Error("Choose a resume smaller than 10 MB.");
  let text: string;
  if (file.name.toLowerCase().endsWith(".pdf")) {
    const pdf = await import("pdfjs-dist");
    pdf.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ).toString();
    const task = pdf.getDocument({ data: await file.arrayBuffer() });
    const doc = await task.promise;
    try {
      if (doc.numPages > 15)
        throw new Error("Choose a resume with 15 pages or fewer.");
      const pages: string[] = [];
      for (let i = 1; i <= doc.numPages; i++) {
        const content = await (await doc.getPage(i)).getTextContent();
        pages.push(
          content.items
            .map((item) => ("str" in item ? item.str : ""))
            .join(" "),
        );
      }
      text = pages.join("\n\n");
    } finally {
      await task.destroy();
    }
  } else if (/\.(txt|md)$/i.test(file.name)) text = await file.text();
  else throw new Error("Use a PDF, TXT, or Markdown resume.");
  if (!text.trim())
    throw new Error(
      "No readable text found. For a scanned PDF, paste the resume text below.",
    );
  if (text.length > MAX_RESUME_LENGTH)
    throw new Error(
      "Resume text exceeds 24,000 characters. Paste a shorter version.",
    );
  return text.trim();
}
export async function connectionStatus(): Promise<
  Partial<Record<KeyProvider, boolean>>
> {
  return desktop ? bridge().credentialStatus() : {};
}
export type ModelConfig = { provider: Provider; model: string };
export type GeneratedText = {
  text: string;
  firstTokenMs: number;
  totalMs: number;
};
export function generateText(
  input: Omit<GenerateRequest, "id">,
  onToken?: (text: string) => void,
  signal?: AbortSignal,
): Promise<GeneratedText> {
  const api = bridge();
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let text = "";
    let settled = false;
    const cleanup = () => {
      settled = true;
      off();
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    };
    const abort = () => {
      void api.cancel(id).catch(() => {});
      cleanup();
      reject(new Error("Response stopped."));
    };
    const off = api.onToken((event) => {
      if (event.id !== id || settled) return;
      if (event.type === "token") {
        text += event.text;
        onToken?.(event.text);
      } else if (event.type === "complete") {
        cleanup();
        resolve({
          text,
          firstTokenMs: event.firstTokenMs,
          totalMs: event.totalMs,
        });
      } else {
        cleanup();
        reject(new Error(event.error));
      }
    });
    const timeout = setTimeout(() => {
      void api.cancel(id).catch(() => {});
      cleanup();
      reject(new Error("Response timed out."));
    }, 130_000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    api.generate({ ...input, id }).catch((e) => {
      if (!settled) {
        cleanup();
        reject(e);
      }
    });
  });
}
export async function nextQuestion(
  profile: Profile,
  messages: Message[],
  config: ModelConfig,
): Promise<string> {
  return (
    await generateText({
      ...config,
      profile,
      messages,
      facts: "",
      mode: "question",
    })
  ).text;
}
export async function reviewAnswers(
  profile: Profile,
  messages: Message[],
  config: ModelConfig,
): Promise<Feedback> {
  const result = await generateText({
    ...config,
    profile,
    messages,
    facts: "",
    mode: "review",
  });
  return feedbackSchema.parse(JSON.parse(result.text));
}
export async function cloneVoice(
  name: string,
  file: File,
): Promise<{ id: string; verificationRequired: boolean }> {
  if (
    ![
      "audio/mpeg",
      "audio/wav",
      "audio/x-wav",
      "audio/mp4",
      "audio/webm",
      "audio/ogg",
    ].includes(file.type)
  )
    throw new Error("Use an MP3, WAV, M4A, WebM, or OGG recording.");
  if (file.size > MAX_FILE_SIZE || file.size < 1024)
    throw new Error("Use a recording between 1 KB and 10 MB.");
  return bridge().cloneVoice(
    name,
    new Uint8Array(await file.arrayBuffer()),
    file.type,
    true,
  );
}
let activeStop: (() => void) | null = null;
export function stopVoice() {
  activeStop?.();
  activeStop = null;
  if (desktop)
    void bridge()
      .stopSpeech()
      .catch(() => {});
}
// Play MP3 chunks through MediaSource as they arrive; buffer only on platforms
// without MP3 MSE support. Never wait for the full file on supported Chromium.
export async function playVoice(
  voiceId: string,
  text: string,
  onFirstAudio?: (ms: number) => void,
): Promise<void> {
  stopVoice();
  const api = bridge();
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const media =
      typeof MediaSource !== "undefined" &&
      MediaSource.isTypeSupported("audio/mpeg")
        ? new MediaSource()
        : null;
    const audio = new Audio();
    let buffer: SourceBuffer | null = null;
    let url = "";
    const queue: Uint8Array[] = [];
    const fallback: Uint8Array[] = [];
    let ended = false;
    let settled = false;
    let began = false;
    const cleanup = () => {
      off();
      audio.pause();
      if (url) URL.revokeObjectURL(url);
      clearTimeout(timeout);
      if (activeStop === cancel) activeStop = null;
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const cancel = () => {
      void api.stopSpeech().catch(() => {});
      finish(new Error("Speech stopped."));
    };
    const startPlayback = () => {
      if (!began) {
        began = true;
        void audio
          .play()
          .catch(() =>
            finish(
              new Error(
                "Audio playback was blocked. Press Speak answer to play it.",
              ),
            ),
          );
      }
    };
    const pump = () => {
      if (!buffer || buffer.updating || settled) return;
      try {
        if (queue.length) buffer.appendBuffer(new Uint8Array(queue.shift()!));
        else if (ended && media?.readyState === "open") media.endOfStream();
      } catch {
        finish(new Error("Could not decode streamed voice audio."));
      }
    };
    audio.onplaying = () =>
      onFirstAudio?.(Math.round(performance.now() - started));
    audio.onended = () => finish();
    audio.onerror = () =>
      finish(new Error("Could not play the generated audio."));
    if (media) {
      url = URL.createObjectURL(media);
      audio.src = url;
      media.addEventListener(
        "sourceopen",
        () => {
          try {
            buffer = media.addSourceBuffer("audio/mpeg");
            buffer.addEventListener("updateend", () => {
              startPlayback();
              pump();
            });
            pump();
          } catch {
            finish(new Error("Streaming audio is unsupported on this device."));
          }
        },
        { once: true },
      );
    }
    const off = api.onAudio((event) => {
      if (settled) return;
      if (event.type === "error")
        finish(new Error(event.error || "Voice generation failed."));
      else if (event.type === "chunk" && event.data) {
        const chunk = new Uint8Array(event.data);
        if (media) {
          queue.push(chunk);
          pump();
        } else fallback.push(chunk);
      } else if (event.type === "end") {
        ended = true;
        if (media) pump();
        else {
          url = URL.createObjectURL(
            new Blob(
              fallback.map((a) => new Uint8Array(a)),
              { type: "audio/mpeg" },
            ),
          );
          audio.src = url;
          startPlayback();
        }
      }
    });
    const timeout = setTimeout(() => {
      void api.stopSpeech().catch(() => {});
      finish(new Error("Speech playback timed out."));
    }, 180_000);
    activeStop = cancel;
    api
      .speak(voiceId, text)
      .catch((e) =>
        finish(e instanceof Error ? e : new Error("Voice generation failed.")),
      );
  });
}
