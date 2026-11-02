import { z } from "zod";

export const MAX_FILE_SIZE = 10 * 1024 * 1024;
export const MAX_RESUME_LENGTH = 24_000;
export const MAX_ANSWER_LENGTH = 6_000;
export const profileSchema = z.object({
  name: z.string().max(80),
  role: z.string().max(160),
  resume: z.string().max(MAX_RESUME_LENGTH),
});
export type Profile = z.infer<typeof profileSchema>;
export type Message = { role: "interviewer" | "candidate"; content: string };
export type Feedback = {
  summary: string;
  strengths: string[];
  improvements: string[];
};

export function speechChunks(text: string, limit = 1500): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }
    const space = remaining.lastIndexOf(" ", limit);
    let cut = space > limit / 2 ? space : limit;
    const last = remaining.charCodeAt(cut - 1);
    if (last >= 0xd800 && last <= 0xdbff) cut--;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  return chunks;
}
export const feedbackSchema = z.object({
  summary: z.string().min(1).max(2000),
  strengths: z.array(z.string().max(1000)).min(1).max(5),
  improvements: z.array(z.string().max(1000)).min(1).max(5),
});
export const questions = [
  "Tell me about yourself and the experience that makes you a strong fit for this role.",
  "Walk me through a difficult problem you solved. What did you personally do, and what changed?",
  "Tell me about a time you disagreed with a teammate. How did you move forward?",
  "Describe a project that did not go as planned. What did you learn?",
  "What would you focus on in your first 90 days in this role?",
];
export function practiceFeedback(messages: Message[]): Feedback {
  const answers = messages.filter((m) => m.role === "candidate");
  const words = answers.map((m) => m.content.trim().split(/\s+/).length);
  return {
    summary: `You completed ${answers.length} practice answer${answers.length === 1 ? "" : "s"}. This is a local structure checklist, not a hiring assessment.`,
    strengths: [
      answers.length >= 3
        ? "You practiced across several different interview situations."
        : "You started translating your experience into an interview answer.",
    ],
    improvements: [
      words.some((n) => n < 40)
        ? "Develop short answers with context, your specific action, and an outcome."
        : "Keep the context brief so your personal contribution stays at the center.",
      "Use a concrete result you can substantiate. Never invent a metric or an experience.",
      "Read your answer aloud and check that it sounds like you.",
    ],
  };
}
export function exportTranscript(
  profile: Profile,
  messages: Message[],
  feedback: Feedback | null,
): string {
  return JSON.stringify(
    {
      version: 1,
      exportedAt: new Date().toISOString(),
      profile: { name: profile.name, role: profile.role },
      disclosure: "AI-assisted interview practice",
      messages,
      feedback,
    },
    null,
    2,
  );
}
