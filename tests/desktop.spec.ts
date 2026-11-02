import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("packaged renderer runs in sandboxed Electron with validated IPC and no renderer Node access", async () => {
  const userData = await mkdtemp(join(tmpdir(), "i-interview-desktop-"));
  const app = await electron.launch({
    chromiumSandbox: true,
    executablePath: process.env.DESKTOP_TEST_EXECUTABLE,
    args: [
      ...(process.env.DESKTOP_TEST_EXECUTABLE ? [] : ["."]),
      `--user-data-dir=${userData}`,
    ],
    env: { ...process.env, INTERVIEW_DEV: "", ELECTRON_RUN_AS_NODE: "" },
  });
  try {
    const page = await app.firstWindow();
    const failures: string[] = [];
    page.on("pageerror", (e) => failures.push(e.message));
    await expect(
      page.getByRole("heading", { level: 1, name: /Your experience/ }),
    ).toBeVisible();
    await page
      .getByLabel("Upload resume")
      .setInputFiles("tests/fixtures/resume.pdf");
    await expect(page.getByLabel("Resume text", { exact: true })).toHaveValue(
      "Alex Morgan builds accessible software.",
    );
    const renderers = await app.evaluate(({ app }) => ({
      noSandbox: app.commandLine.hasSwitch("no-sandbox"),
      processes: app
        .getAppMetrics()
        .filter((m) => m.type === "Tab")
        .map((m) => ({ pid: m.pid, sandboxed: m.sandboxed })),
    }));
    expect(renderers.noSandbox).toBe(false);
    expect(renderers.processes.length).toBeGreaterThan(0);
    for (const renderer of renderers.processes) {
      if (process.platform === "linux") {
        const status = await readFile(`/proc/${renderer.pid}/status`, "utf8");
        expect(status).toMatch(/NoNewPrivs:\s+1/);
        expect(status).toMatch(/Seccomp:\s+2/);
      } else expect(renderer.sandboxed).toBe(true);
    }
    expect(
      await page.evaluate(() => ({
        require: typeof (window as unknown as { require?: unknown }).require,
        bridge: typeof window.interview?.generate,
      })),
    ).toEqual({ require: "undefined", bridge: "function" });
    const inlineScriptExecuted = await page.evaluate(() => {
      const script = document.createElement("script");
      script.textContent = "window.__interviewInlineExecuted = true";
      document.head.appendChild(script);
      script.remove();
      return Boolean(
        (window as unknown as { __interviewInlineExecuted?: boolean })
          .__interviewInlineExecuted,
      );
    });
    expect(inlineScriptExecuted).toBe(false);
    const status = await page.evaluate(() =>
      window.interview!.credentialStatus(),
    );
    expect(Object.keys(status).sort()).toEqual([
      "anthropic",
      "elevenlabs",
      "ollama",
      "openai",
      "openrouter",
      "xai",
    ]);
    const error = await page.evaluate(async () => {
      try {
        await window.interview!.saveCredential("openai", "x");
        return "";
      } catch (e) {
        return String(e);
      }
    });
    expect(error).toContain("Error");
    const missingKey = await page.evaluate(async () => {
      try {
        await window.interview!.listModels("openai");
        return "";
      } catch (e) {
        return String(e);
      }
    });
    expect(missingKey).toMatch(/Connect openai|credential store/);
    await page
      .getByRole("button", { name: "Connections", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Check for updates", exact: true })
      .click();
    await expect(
      page.getByText(
        "Automatic updates require a signed Windows or macOS release. Linux updates are manual.",
        { exact: true },
      ),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Identity studio", exact: false })
      .click();
    await page.getByLabel("Target role").fill("Software engineer");
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
          "I built an accessible interface with the team and delivered the agreed scope.",
        );
      await page.getByRole("button", { name: "Submit answer" }).click();
    }
    const exportPath = join(userData, "native-export.json");
    await app.evaluate(({ session }, path) => {
      session.defaultSession.once("will-download", (_event, item) =>
        item.setSavePath(path),
      );
    }, exportPath);
    await page.getByRole("button", { name: "Save this session" }).click();
    await expect
      .poll(async () => {
        try {
          return JSON.parse(await readFile(exportPath, "utf8")).messages.length;
        } catch {
          return 0;
        }
      })
      .toBe(10);
    expect(failures).toEqual([]);
    await page.screenshot({
      path: "/tmp/i-interview-desktop.png",
      fullPage: true,
    });
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});
