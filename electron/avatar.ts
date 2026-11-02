import { z } from "zod";
import {
  avatarAnswerSchema,
  avatarIdSchema,
  avatarJobSchema,
  avatarSpeechSchema,
  avatarStatusSchema,
  type AvatarSpeech,
  type GpuStatus,
} from "../src/avatar-contracts.js";

const BASE = "http://127.0.0.1:17860";
export class LocalAvatarClient {
  private speech: AbortController | null = null;
  private connected = false;
  private epoch = 0;
  constructor(
    private token: () => Promise<string>,
    private voiceClip: (
      id: string,
      text: string,
      signal: AbortSignal,
    ) => Promise<Uint8Array>,
    private transport: typeof fetch = fetch,
  ) {}

  private async request(
    path: string,
    init: RequestInit = {},
    timeout = 10000,
  ): Promise<unknown> {
    const token = await this.token();
    const response = await this.transport(`${BASE}${path}`, {
      ...init,
      redirect: "error",
      headers: { ...init.headers, Authorization: `Bearer ${token}` },
      signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(timeout)])
        : AbortSignal.timeout(timeout),
    });
    if (Number(response.headers.get("content-length")) > 1_000_000)
      throw new Error("Local avatar response exceeds the size limit.");
    const reader = response.body?.getReader();
    if (!reader)
      throw new Error("The local avatar engine returned no response.");
    let text = "";
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (text.length > 1_000_000)
          throw new Error("Local avatar response exceeds the size limit.");
      }
      text += decoder.decode();
    } finally {
      await reader.cancel().catch(() => {});
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error("The local avatar engine returned invalid JSON.");
    }
    if (!response.ok) {
      const error = z.object({ detail: z.string().max(2000) }).safeParse(data);
      throw new Error(
        error.success
          ? error.data.detail
          : `Local avatar request failed (${response.status}).`,
      );
    }
    return data;
  }
  private post(
    path: string,
    data: unknown,
    timeout?: number,
    signal?: AbortSignal,
  ) {
    return this.request(
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        signal,
      },
      timeout,
    );
  }
  async status() {
    return avatarStatusSchema.parse(await this.request("/v1/status"));
  }
  async gpu(): Promise<GpuStatus> {
    return z
      .object({
        available: z.boolean(),
        device: z.string(),
        vram_gib: z.number(),
        cuda: z.string(),
        torch: z.string(),
        capability: z.array(z.number()),
        kernel_check: z.boolean(),
      })
      .parse(await this.request("/v1/gpu", {}, 50000));
  }
  async prepare(avatarId: string, file: Uint8Array, filename: string) {
    avatarIdSchema.parse(avatarId);
    if (file.length < 1024 || file.length > 150 * 1024 * 1024)
      throw new Error("Choose a reference video between 1 KB and 150 MB.");
    const form = new FormData();
    form.append("avatar_id", avatarId);
    form.append("consent", "true");
    form.append("video", new Blob([new Uint8Array(file)]), filename);
    return avatarJobSchema.parse(
      await this.request("/v1/avatars", { method: "POST", body: form }, 60000),
    );
  }
  async job(id: string) {
    return avatarJobSchema.parse(
      await this.request(`/v1/jobs/${z.string().uuid().parse(id)}`),
    );
  }
  async importVoice(file: Uint8Array, filename: string) {
    if (file.length < 1024 || file.length > 10 * 1024 * 1024)
      throw new Error("Choose a voice reference between 1 KB and 10 MB.");
    const form = new FormData();
    form.append("consent", "true");
    form.append("audio", new Blob([new Uint8Array(file)]), filename);
    await this.request("/v1/voice", { method: "POST", body: form }, 45000);
  }
  async offer(avatarId: string, sdp: string) {
    avatarIdSchema.parse(avatarId);
    z.string().min(10).max(150000).parse(sdp);
    const epoch = ++this.epoch;
    const answer = avatarAnswerSchema.parse(
      await this.post(
        "/v1/offer",
        { avatar_id: avatarId, sdp, consent: true },
        140000,
      ),
    );
    if (epoch !== this.epoch) {
      await this.post("/v1/stop", {}).catch(() => {});
      throw new Error("Video connection was stopped.");
    }
    this.connected = true;
    return answer;
  }
  async speak(input: AvatarSpeech) {
    const request = avatarSpeechSchema.parse(input);
    if (!this.connected)
      throw new Error("Connect your self-hosted video replica first.");
    if (this.speech) throw new Error("The video replica is already speaking.");
    const controller = new AbortController();
    this.speech = controller;
    const start = performance.now();
    try {
      const ticket = z
        .object({
          epoch: z.number().int().nonnegative(),
          sessionid: z.string().min(1).max(128),
        })
        .parse(
          await this.request("/v1/speech-ticket", {
            signal: controller.signal,
          }),
        );
      if (request.mode === "elevenlabs") {
        if (!request.voiceId)
          throw new Error(
            "Create or select your consented ElevenLabs voice first.",
          );
        const bytes = await this.voiceClip(
          request.voiceId,
          request.text,
          controller.signal,
        );
        if (controller.signal.aborted) throw new Error("Speech stopped.");
        const form = new FormData();
        form.append("epoch", String(ticket.epoch));
        form.append(
          "audio",
          new Blob([new Uint8Array(bytes)], { type: "audio/mpeg" }),
          "answer.mp3",
        );
        await this.request(
          "/v1/audio",
          { method: "POST", body: form, signal: controller.signal },
          45000,
        );
      } else
        await this.post(
          "/v1/speak",
          { text: request.text, epoch: ticket.epoch },
          100000,
          controller.signal,
        );
      // Observe actual renderer speech state, not just the upload acknowledgement.
      let startedMs: number | null = null;
      for (let attempt = 0; attempt < 500; attempt++) {
        if (controller.signal.aborted) throw new Error("Speech stopped.");
        const status = z
          .object({ speaking: z.boolean() })
          .parse(
            await this.request("/v1/speaking", { signal: controller.signal }),
          );
        if (status.speaking && startedMs === null)
          startedMs = Math.round(performance.now() - start);
        if (!status.speaking && startedMs !== null) return { startedMs };
        if (startedMs === null && attempt >= 75)
          throw new Error(
            "Audio was queued but the renderer did not report playback within 15 seconds.",
          );
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(new Error("Speech stopped."));
          };
          const timer = setTimeout(() => {
            controller.signal.removeEventListener("abort", abort);
            resolve();
          }, 200);
          controller.signal.addEventListener("abort", abort, { once: true });
        });
      }
      throw new Error("Video speech playback exceeded the time limit.");
    } finally {
      if (this.speech === controller) this.speech = null;
    }
  }
  async interrupt() {
    this.speech?.abort();
    this.speech = null;
    await this.post("/v1/interrupt", {});
  }
  async stop() {
    ++this.epoch;
    this.connected = false;
    this.speech?.abort();
    this.speech = null;
    await this.post("/v1/stop", {});
  }
}
