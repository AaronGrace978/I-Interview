import { describe, expect, it } from "vitest";
import { LocalAvatarClient } from "./avatar.js";

const status = {
  configured: true,
  avatars: ["aaron"],
  session_active: false,
  profile: "single stream",
  video_runtime: "CUDA 12.8",
  message: "Configured, not inference validated.",
};
const answer = {
  type: "answer",
  sdp: "v=0\r\na=example-answer",
  sessionid: "owned-session",
};

describe("local video engine bridge", () => {
  it("sends the local token only to a fixed loopback destination", async () => {
    const requests: { url: string; authorization: string }[] = [];
    const transport: typeof fetch = async (input, options) => {
      requests.push({
        url: String(input),
        authorization: (options?.headers as Record<string, string>)
          .Authorization,
      });
      return Response.json(status);
    };
    const client = new LocalAvatarClient(
      async () => "private-local-token",
      async () => new Uint8Array(),
      transport,
    );
    expect((await client.status()).avatars).toEqual(["aaron"]);
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:17860/v1/status",
        authorization: "Bearer private-local-token",
      },
    ]);
  });
  it("does not accept traversal IDs or arbitrary job paths", async () => {
    let calls = 0;
    const client = new LocalAvatarClient(
      async () => "token",
      async () => new Uint8Array(),
      async () => {
        calls++;
        return Response.json(answer);
      },
    );
    await expect(
      client.offer("../../other", "v=0\r\nexample"),
    ).rejects.toThrow();
    await expect(client.job("https://remote.example")).rejects.toThrow();
    expect(calls).toBe(0);
  });
  it("rejects invalid engine JSON and bounded-error responses", async () => {
    const client = new LocalAvatarClient(
      async () => "token",
      async () => new Uint8Array(),
      async () => new Response("<html>not JSON</html>"),
    );
    await expect(client.status()).rejects.toThrow("invalid JSON");
    const unavailable = new LocalAvatarClient(
      async () => "token",
      async () => new Uint8Array(),
      async () =>
        Response.json({ detail: "CUDA runtime is missing." }, { status: 409 }),
    );
    await expect(unavailable.status()).rejects.toThrow(
      "CUDA runtime is missing",
    );
  });
  it("never feeds a late ElevenLabs clip after interruption", async () => {
    let release!: (data: Uint8Array) => void;
    let started!: () => void;
    const clipStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const clip = new Promise<Uint8Array>((resolve) => {
      release = resolve;
    });
    const paths: string[] = [];
    const transport: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      return Response.json(
        path === "/v1/offer"
          ? answer
          : path === "/v1/speech-ticket"
            ? { epoch: 1, sessionid: "owned-session" }
            : { stopped: true },
      );
    };
    const client = new LocalAvatarClient(
      async () => "token",
      async () => {
        started();
        return clip;
      },
      transport,
    );
    await client.offer("aaron", "v=0\r\nexample offer");
    const speech = client.speak({
      text: "Approved response",
      mode: "elevenlabs",
      voiceId: "own_voice",
    });
    await clipStarted;
    await client.interrupt();
    release(new Uint8Array([1, 2, 3]));
    await expect(speech).rejects.toThrow("stopped");
    expect(paths).not.toContain("/v1/audio");
  });
  it("observes renderer playback before declaring speech finished", async () => {
    let polls = 0;
    const transport: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      if (path === "/v1/offer") return Response.json(answer);
      if (path === "/v1/speech-ticket")
        return Response.json({ epoch: 1, sessionid: "owned-session" });
      if (path === "/v1/speaking")
        return Response.json({ speaking: ++polls === 1 });
      return Response.json({ queued: true });
    };
    const client = new LocalAvatarClient(
      async () => "token",
      async () => new Uint8Array(),
      transport,
    );
    await client.offer("aaron", "v=0\r\nexample offer");
    const result = await client.speak({
      text: "Approved response",
      mode: "local",
    });
    expect(polls).toBe(2);
    expect(result.startedMs).toBeGreaterThanOrEqual(0);
  });
});
