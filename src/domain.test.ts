import { describe, expect, it } from "vitest";
import {
  exportTranscript,
  feedbackSchema,
  practiceFeedback,
  profileSchema,
  speechChunks,
} from "./domain";
import { requestSchema } from "./contracts";

describe("interview data boundaries", () => {
  it("bounds long utterances without dropping words or splitting surrogate pairs", () => {
    const text = `${"A concrete achievement with evidence. ".repeat(140)}🧑‍💻`;
    const chunks = speechChunks(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 1500)).toBe(true);
    expect(chunks.join(" ").split(/\s+/)).toEqual(text.trim().split(/\s+/));
    expect(speechChunks("")).toEqual([]);
  });
  it("rejects resumes and answers beyond the IPC limits", () => {
    expect(
      profileSchema.safeParse({
        name: "Alex",
        role: "Engineer",
        resume: "x".repeat(24001),
      }).success,
    ).toBe(false);
    expect(
      requestSchema.safeParse({
        id: crypto.randomUUID(),
        provider: "openai",
        model: "model",
        mode: "delegate",
        profile: { name: "", role: "", resume: "" },
        facts: "",
        messages: [{ role: "interviewer", content: "x".repeat(6001) }],
      }).success,
    ).toBe(false);
  });
  it("rejects arbitrary provider URLs and malformed model IDs", () => {
    const request = {
      id: crypto.randomUUID(),
      provider: "openai",
      model: "org/current-model:cloud",
      mode: "delegate",
      profile: { name: "", role: "", resume: "" },
      facts: "",
      messages: [],
    };
    expect(requestSchema.safeParse(request).success).toBe(true);
    expect(
      requestSchema.safeParse({ ...request, provider: "https://attacker.test" })
        .success,
    ).toBe(false);
    expect(
      requestSchema.safeParse({ ...request, model: "../../x?key=secret" })
        .success,
    ).toBe(false);
  });
  it("produces a structure checklist without a hiring score", () => {
    const result = practiceFeedback([
      { role: "interviewer", content: "Tell me about yourself." },
      { role: "candidate", content: "I build products." },
    ]);
    expect(result.summary).toContain("1 practice answer");
    expect(result.improvements[0]).toContain("Develop short answers");
    expect(feedbackSchema.safeParse(result).success).toBe(true);
    expect(
      feedbackSchema.safeParse({
        summary: "Fine",
        strengths: [],
        improvements: [],
      }).success,
    ).toBe(false);
  });
  it("exports the conversation without embedding the private resume", () => {
    const value = JSON.parse(
      exportTranscript(
        { name: "Alex", role: "Engineer", resume: "PRIVATE RESUME" },
        [{ role: "candidate", content: "My answer" }],
        null,
      ),
    );
    expect(value.profile).toEqual({ name: "Alex", role: "Engineer" });
    expect(value.messages[0].content).toBe("My answer");
    expect(JSON.stringify(value)).not.toContain("PRIVATE RESUME");
  });
});
