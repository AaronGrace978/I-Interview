import { readFileSync } from "node:fs";
import { test, expect, type Page } from "@playwright/test";

async function profile(page: Page) {
  await page.getByText("Or paste your resume text", { exact: true }).click();
  await page
    .getByLabel("Resume text", { exact: true })
    .fill(
      "Alex Morgan\nSoftware engineer with five years of experience. Built an accessible dashboard for a logistics team. Used React, TypeScript, and PostgreSQL.",
    );
  await page.getByLabel("Your name", { exact: true }).fill("Alex Morgan");
  await page.getByLabel("Target role").fill("Senior software engineer");
}
async function mockDesktop(
  page: Page,
  behavior: "normal" | "slow" | "error" = "normal",
) {
  await page.addInitScript(
    ({ behavior, tone }) => {
      const listeners = new Set<(data: unknown) => void>();
      const audioListeners = new Set<(data: unknown) => void>();
      const keys: Record<string, boolean> = {};
      (window as unknown as { interview: unknown }).interview = {
        credentialStatus: async () => ({
          openai: true,
          elevenlabs: true,
          ...keys,
        }),
        saveCredential: async (provider: string) => {
          keys[provider] = true;
        },
        deleteCredential: async (provider: string) => {
          keys[provider] = false;
        },
        listModels: async (provider: string) => [
          `${provider}/newest-test-model`,
          `${provider}/another-model`,
        ],
        onToken: (cb: (data: unknown) => void) => {
          listeners.add(cb);
          return () => {
            listeners.delete(cb);
          };
        },
        generate: async (request: {
          id: string;
          provider: string;
          model: string;
          mode: string;
          profile: { resume: string };
        }) => {
          (window as unknown as { lastRequest: unknown }).lastRequest = request;
          if (behavior === "error") {
            setTimeout(
              () =>
                listeners.forEach((cb) =>
                  cb({
                    id: request.id,
                    type: "error",
                    error: "Provider request failed (429). Rate limit reached.",
                  }),
                ),
              10,
            );
            return;
          }
          if (behavior === "slow") {
            setTimeout(
              () =>
                listeners.forEach((cb) =>
                  cb({
                    id: request.id,
                    type: "token",
                    text: "An interrupted answer",
                  }),
                ),
              10,
            );
            return;
          }
          const text =
            request.mode === "delegate"
              ? "Alex built an accessible logistics dashboard using React and TypeScript. The resume does not specify a quantified impact, so I cannot provide one."
              : "What is a difficult problem you solved?";
          setTimeout(() => {
            listeners.forEach((cb) =>
              cb({ id: request.id, type: "token", text }),
            );
            listeners.forEach((cb) =>
              cb({
                id: request.id,
                type: "complete",
                firstTokenMs: 180,
                totalMs: 650,
              }),
            );
          }, 20);
        },
        cancel: async () => {},
        onAudio: (callback: (data: unknown) => void) => {
          audioListeners.add(callback);
          return () => {
            audioListeners.delete(callback);
          };
        },
        cloneVoice: async () => ({
          id: "test-voice",
          verificationRequired: false,
        }),
        speak: async () => {
          const bytes = new Uint8Array(tone);
          for (let offset = 0; offset < bytes.length; offset += 1024) {
            const data = bytes.slice(offset, offset + 1024);
            audioListeners.forEach((callback) =>
              callback({ type: "chunk", data }),
            );
          }
          audioListeners.forEach((callback) => callback({ type: "end" }));
        },
        stopSpeech: async () => {},
        transcribe: async (
          audio: Uint8Array,
          mime: string,
          consent: boolean,
        ) => {
          (window as unknown as { transcription: unknown }).transcription = {
            bytes: audio.byteLength,
            mime,
            consent,
          };
          return "What did Alex build for the logistics team?";
        },
        onUpdate: () => () => {},
        checkUpdate: async () => {},
      };
    },
    {
      behavior,
      tone: Array.from(readFileSync("tests/fixtures/test-tone.mp3")),
    },
  );
}
test("local resume import, five-question practice, feedback, and private transcript export", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Upload resume").setInputFiles({
    name: "resume.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Alex built a customer dashboard using React and SQL."),
  });
  await expect(page.getByLabel("Resume text", { exact: true })).toHaveValue(
    /Alex built/,
  );
  await page.getByLabel("Your name", { exact: true }).fill("Alex");
  await page.getByLabel("Target role").fill("Engineer");
  await page
    .getByRole("button", { name: "Practice room", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Start a practice interview" })
    .click();
  for (let i = 0; i < 5; i++) {
    await page
      .getByLabel("Your answer", { exact: true })
      .fill(
        `In project ${i + 1}, I worked with a logistics team to build a useful dashboard. I implemented the accessible React interface, worked with the data team, and delivered the agreed requirements.`,
      );
    await page.getByRole("button", { name: "Submit answer" }).click();
  }
  await expect(
    page.getByText("You completed 5 practice answers.", { exact: false }),
  ).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Save this session" }).click();
  expect((await download).suggestedFilename()).toBe("i-interview-session.json");
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
});
test("resume parser rejects unsupported and oversized input without losing valid text", async ({
  page,
}) => {
  await page.goto("/");
  await profile(page);
  await page.getByLabel("Upload resume").setInputFiles({
    name: "bad.exe",
    mimeType: "application/octet-stream",
    buffer: Buffer.from("bad"),
  });
  await expect(page.getByRole("alert")).toContainText(
    "Use a PDF, TXT, or Markdown resume",
  );
  await expect(page.getByLabel("Resume text", { exact: true })).toHaveValue(
    /Alex Morgan/,
  );
  await page.getByLabel("Upload resume").setInputFiles({
    name: "huge.txt",
    mimeType: "text/plain",
    buffer: Buffer.alloc(10 * 1024 * 1024 + 1, "a"),
  });
  await expect(page.getByRole("alert")).toContainText("smaller than 10 MB");
});
test("browser preview refuses native provider operations", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Save connection", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Interview delegate", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Answer on my behalf" }),
  ).toBeDisabled();
});
test("delegate uses selected provider and live model catalog, requires disclosure, and preserves session across navigation", async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto("/");
  await profile(page);
  await page.getByRole("button", { name: "Launch interview delegate" }).click();
  await page.getByLabel("AI provider", { exact: true }).selectOption("ollama");
  await page.getByRole("button", { name: "Refresh models" }).click();
  await page
    .getByLabel("Browse provider catalog")
    .selectOption("ollama/newest-test-model");
  await page
    .getByLabel("Interviewer’s question")
    .fill("What did Alex build and what was the measured outcome?");
  await expect(
    page.getByRole("button", { name: "Answer on my behalf" }),
  ).toBeDisabled();
  await page.getByLabel("The interviewer knows", { exact: false }).check();
  await page.getByRole("button", { name: "Answer on my behalf" }).click();
  await expect(
    page.getByText("Alex built an accessible logistics dashboard", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(page.getByText("180 ms", { exact: true })).toBeVisible();
  const r = await page.evaluate(
    () =>
      (
        window as unknown as {
          lastRequest: { provider: string; model: string; mode: string };
        }
      ).lastRequest,
  );
  expect(r).toMatchObject({
    provider: "ollama",
    model: "ollama/newest-test-model",
    mode: "delegate",
  });
  await page
    .getByRole("button", { name: "Identity studio", exact: false })
    .click();
  await page
    .getByRole("button", { name: "Interview delegate", exact: true })
    .click();
  await expect(
    page.getByText("Alex built an accessible logistics dashboard", {
      exact: false,
    }),
  ).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  expect((await download).suggestedFilename()).toBe(
    "i-interview-delegate.json",
  );
});
test("stopping a response keeps the interrupted answer out of history and permits retry", async ({
  page,
}) => {
  await mockDesktop(page, "slow");
  await page.goto("/");
  await profile(page);
  await page.getByRole("button", { name: "Launch interview delegate" }).click();
  await page.getByLabel("Exact model ID").fill("test-model");
  await page.getByLabel("The interviewer knows", { exact: false }).check();
  await page.getByLabel("Interviewer’s question").fill("Tell me about Alex.");
  await page.getByRole("button", { name: "Answer on my behalf" }).click();
  await expect(
    page.getByText("An interrupted answer", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Stop now" }).click();
  await expect(
    page.getByText("Interrupted draft, not sent to history", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Answer on my behalf" }),
  ).toBeEnabled();
  await expect(page.getByLabel("Interviewer’s question")).toHaveValue(
    "Tell me about Alex.",
  );
});
test("provider failures leave the question intact and show actionable errors", async ({
  page,
}) => {
  await mockDesktop(page, "error");
  await page.goto("/");
  await profile(page);
  await page.getByRole("button", { name: "Launch interview delegate" }).click();
  await page.getByLabel("Exact model ID").fill("test-model");
  await page.getByLabel("The interviewer knows", { exact: false }).check();
  await page.getByLabel("Interviewer’s question").fill("Tell me about Alex.");
  await page.getByRole("button", { name: "Answer on my behalf" }).click();
  await expect(page.getByRole("alert")).toContainText("429");
  await expect(page.getByLabel("Interviewer’s question")).toHaveValue(
    "Tell me about Alex.",
  );
});
test("responsive studio and delegate fit a narrow viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await page.screenshot({
    path: "/tmp/i-interview-studio.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("heading", { name: /Your experience/, level: 1 }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Interview delegate", exact: true })
    .click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

function resumePdf(text: string): Buffer {
  const stream = `BT /F1 12 Tf 50 750 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((o, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => `${String(n).padStart(10, "0")} 00000 n \n`)
    .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}
test("real PDF extraction runs locally and handles a PDF with no text", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Upload resume").setInputFiles({
    name: "resume.pdf",
    mimeType: "application/pdf",
    buffer: resumePdf("Alex Morgan builds accessible software."),
  });
  await expect(page.getByLabel("Resume text", { exact: true })).toHaveValue(
    "Alex Morgan builds accessible software.",
  );
  await page.getByLabel("Upload resume").setInputFiles({
    name: "scanned.pdf",
    mimeType: "application/pdf",
    buffer: resumePdf(""),
  });
  await expect(page.getByRole("alert")).toContainText("No readable text found");
  await expect(page.getByLabel("Resume text", { exact: true })).toHaveValue(
    "Alex Morgan builds accessible software.",
  );
});
test("microphone question capture requires consent and produces a reviewable transcript", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["microphone"]);
  await mockDesktop(page);
  await page.goto("/");
  await profile(page);
  await page.getByRole("button", { name: "Launch interview delegate" }).click();
  await expect(
    page.getByRole("button", { name: "Record interviewer’s question" }),
  ).toBeDisabled();
  await page
    .getByLabel("The speaker consents to recording", { exact: false })
    .check();
  await page
    .getByRole("button", { name: "Record interviewer’s question" })
    .click();
  await expect(
    page.getByText("Recording · 1s", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Stop and transcribe" }).click();
  await expect(page.getByLabel("Interviewer’s question")).toHaveValue(
    "What did Alex build for the logistics team?",
  );
  const transcription = await page.evaluate(
    () =>
      (
        window as unknown as {
          transcription: { bytes: number; mime: string; consent: boolean };
        }
      ).transcription,
  );
  expect(transcription.bytes).toBeGreaterThan(128);
  expect(transcription.mime).toBe("audio/webm");
  expect(transcription.consent).toBe(true);
  await expect(
    page.getByRole("button", { name: "Answer on my behalf" }),
  ).toBeDisabled();
});

test("consented voice preview and sentence-streamed delegate audio complete with playback telemetry", async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto("/");
  await profile(page);
  await page.getByRole("button", { name: "Connections", exact: true }).click();
  await page.getByLabel("This is my own voice.", { exact: false }).check();
  await page
    .getByLabel("Voice recording", { exact: true })
    .setInputFiles("tests/fixtures/test-tone.mp3");
  await page
    .getByRole("button", { name: "Create my voice", exact: true })
    .click();
  await expect(
    page.getByText("Voice created. Preview it", { exact: false }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Interview delegate", exact: true })
    .click();
  await page.getByLabel("Exact model ID").fill("test-model");
  await page.getByLabel("The interviewer knows", { exact: false }).check();
  await page.getByLabel("Answer output", { exact: true }).selectOption("audio");
  await page
    .getByLabel("Speak answers automatically", { exact: false })
    .check();
  await page.getByLabel("Interviewer’s question").fill("What did Alex build?");
  await page.getByRole("button", { name: "Answer on my behalf" }).click();
  await expect(
    page.getByRole("button", { name: "Answer on my behalf" }),
  ).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page
      .locator("dl > div")
      .filter({ hasText: "First audible playback" })
      .locator("dd"),
  ).toHaveText(/\d+ ms/);
});

test("video replica receives real WebRTC test-pattern frames and routes delegate speech to the local engine", async ({
  page,
}) => {
  test.setTimeout(45000);
  await mockDesktop(page);
  await page.goto("/");
  await profile(page);
  const iceCandidates = await page.evaluate(async () => {
    const probe = new RTCPeerConnection({ iceServers: [] });
    probe.addTransceiver("video", { direction: "recvonly" });
    await probe.setLocalDescription(await probe.createOffer());
    if (probe.iceGatheringState !== "complete")
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 7000);
        probe.addEventListener("icegatheringstatechange", () => {
          if (probe.iceGatheringState === "complete") {
            clearTimeout(timer);
            resolve();
          }
        });
      });
    const count = probe
      .localDescription!.sdp.split("\n")
      .filter((line) => line.startsWith("a=candidate:")).length;
    probe.close();
    return count;
  });
  test.skip(
    iceCandidates === 0,
    "This execution browser exposes zero ICE candidates. Real media transport must be tested in a WebRTC-capable runtime; no transport readiness is claimed here.",
  );
  await page.evaluate(() => {
    const api = window.interview!;
    let remote: RTCPeerConnection | null = null;
    let frameTimer: ReturnType<typeof setInterval> | null = null;
    let source: MediaStream | null = null;
    let audio: AudioContext | null = null;
    api.avatarStatus = async () => ({
      configured: true,
      avatars: ["aaron"],
      session_active: false,
      profile: "test fixture",
      video_runtime: "simulated control plane; no GPU inference",
      message: "Test renderer configured.",
    });
    api.avatarOffer = async (_id, sdp) => {
      remote = new RTCPeerConnection({ iceServers: [] });
      const canvas = document.createElement("canvas");
      canvas.width = 320;
      canvas.height = 240;
      const context = canvas.getContext("2d")!;
      let frame = 0;
      frameTimer = setInterval(() => {
        context.fillStyle = frame++ % 2 ? "#31533d" : "#42694b";
        context.fillRect(0, 0, 320, 240);
        context.fillStyle = "#e2eed3";
        context.font = "16px sans-serif";
        context.fillText("SYNTHETIC TRANSPORT TEST", 20, 110);
      }, 100);
      source = canvas.captureStream(10);
      audio = new AudioContext();
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      gain.gain.value = 0;
      const destination = audio.createMediaStreamDestination();
      oscillator.connect(gain);
      gain.connect(destination);
      oscillator.start();
      await audio.resume();
      for (const track of [
        ...source.getTracks(),
        ...destination.stream.getTracks(),
      ])
        remote.addTrack(track);
      await remote.setRemoteDescription({ type: "offer", sdp });
      await remote.setLocalDescription(await remote.createAnswer());
      if (remote.iceGatheringState !== "complete")
        await new Promise<void>((resolve) => {
          remote!.addEventListener("icegatheringstatechange", () => {
            if (remote!.iceGatheringState === "complete") resolve();
          });
        });
      return {
        type: "answer",
        sdp: remote.localDescription!.sdp,
        sessionid: "synthetic-session",
      };
    };
    api.avatarSpeak = async (request) => {
      const state = window as unknown as { localSpeech: unknown[] };
      state.localSpeech ||= [];
      state.localSpeech.push(request);
      return { startedMs: 90 };
    };
    api.avatarInterrupt = async () => {};
    api.avatarStop = async () => {
      remote?.close();
      source?.getTracks().forEach((track) => track.stop());
      if (frameTimer) clearInterval(frameTimer);
      await audio?.close();
    };
  });
  await page
    .getByRole("button", { name: "Video replica", exact: false })
    .click();
  await page.getByRole("button", { name: "Check engine", exact: true }).click();
  await page
    .getByLabel("The video and voice are mine", { exact: false })
    .check();
  await page.getByRole("button", { name: "Start my video replica" }).click();
  await expect(
    page.locator(".replica-preview-card .replica-live-state"),
  ).toContainText("Receiving real video frames", { timeout: 25000 });
  expect(
    await page
      .locator(".replica-preview-card video")
      .evaluate((element) => (element as HTMLVideoElement).videoWidth),
  ).toBe(320);
  await page
    .getByRole("button", { name: "Interview delegate", exact: true })
    .click();
  await page.getByLabel("Exact model ID").fill("test-model");
  await page.getByLabel("The interviewer knows", { exact: false }).check();
  await page
    .getByLabel("Speak answers automatically", { exact: false })
    .check();
  await page.getByLabel("Interviewer’s question").fill("What did Alex build?");
  await page.getByRole("button", { name: "Answer on my behalf" }).click();
  await expect(
    page.getByText("Alex built an accessible logistics dashboard", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Answer on my behalf" }),
  ).toBeVisible();
  const speech = await page.evaluate(
    () =>
      (window as unknown as { localSpeech: { mode: string; text: string }[] })
        .localSpeech,
  );
  expect(speech.length).toBeGreaterThan(0);
  expect(speech.every((entry) => entry.mode === "local")).toBe(true);
  await page
    .getByRole("button", { name: "Video replica", exact: false })
    .click();
  await page.getByRole("button", { name: "Disconnect video" }).click();
  await expect(
    page.locator(".replica-preview-card .replica-live-state"),
  ).toContainText("Not connected");
});

test("video setup reports a missing local runtime without displaying a stock person", async ({
  page,
}) => {
  await mockDesktop(page);
  await page.goto("/");
  await page.evaluate(() => {
    window.interview!.avatarStatus = async () => {
      throw new Error("Local engine is not running on 127.0.0.1:17860.");
    };
  });
  await page
    .getByRole("button", { name: "Video replica", exact: false })
    .click();
  await page.getByRole("button", { name: "Check engine", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("not running");
  await expect(
    page.getByRole("button", { name: "Start my video replica" }),
  ).toBeDisabled();
  await expect(
    page.locator(".replica-preview-card .replica-live-state"),
  ).toHaveText("Not connected");
  await expect(page.locator(".replica-preview-card img")).toHaveCount(0);
});
