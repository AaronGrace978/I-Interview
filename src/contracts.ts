import { z } from "zod";
import { profileSchema } from "./domain.js";

export const providerSchema = z.enum([
  "openai",
  "anthropic",
  "openrouter",
  "xai",
  "ollama",
]);
export type Provider = z.infer<typeof providerSchema>;
export const providers: { id: Provider; name: string; host: string }[] = [
  { id: "openai", name: "OpenAI", host: "api.openai.com" },
  { id: "anthropic", name: "Anthropic", host: "api.anthropic.com" },
  { id: "openrouter", name: "OpenRouter", host: "openrouter.ai" },
  { id: "xai", name: "xAI", host: "api.x.ai" },
  { id: "ollama", name: "Ollama Cloud", host: "ollama.com" },
];
export const keyProviderSchema = z.enum([
  "openai",
  "anthropic",
  "openrouter",
  "xai",
  "ollama",
  "elevenlabs",
]);
export type KeyProvider = z.infer<typeof keyProviderSchema>;
export const requestSchema = z.object({
  id: z.string().uuid(),
  provider: providerSchema,
  model: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9_.:/@+-]+$/),
  mode: z.enum(["delegate", "question", "review"]),
  profile: profileSchema,
  facts: z.string().max(12000),
  messages: z
    .array(
      z.object({
        role: z.enum(["interviewer", "candidate"]),
        content: z.string().min(1).max(6000),
      }),
    )
    .max(40),
});
export type GenerateRequest = z.infer<typeof requestSchema>;
export type StreamEvent =
  | { id: string; type: "token"; text: string }
  | { id: string; type: "complete"; firstTokenMs: number; totalMs: number }
  | { id: string; type: "error"; error: string };
export type UpdateStatus = {
  state:
    | "idle"
    | "checking"
    | "available"
    | "current"
    | "downloading"
    | "downloaded"
    | "error"
    | "disabled";
  message: string;
  percent?: number;
};
export interface DesktopBridge {
  credentialStatus(): Promise<Partial<Record<KeyProvider, boolean>>>;
  saveCredential(provider: KeyProvider, key: string): Promise<void>;
  deleteCredential(provider: KeyProvider): Promise<void>;
  listModels(provider: Provider): Promise<string[]>;
  generate(request: GenerateRequest): Promise<void>;
  cancel(id: string): Promise<void>;
  onToken(callback: (event: StreamEvent) => void): () => void;
  cloneVoice(
    name: string,
    audio: Uint8Array,
    mime: string,
    consent: boolean,
  ): Promise<{ id: string; verificationRequired: boolean }>;
  deleteVoice(id: string): Promise<void>;
  speak(id: string, text: string): Promise<void>;
  stopSpeech(): Promise<void>;
  transcribe(
    audio: Uint8Array,
    mime: string,
    consent: boolean,
  ): Promise<string>;
  onAudio(
    callback: (event: {
      type: "chunk" | "end" | "error";
      data?: Uint8Array;
      error?: string;
    }) => void,
  ): () => void;
  checkUpdate(): Promise<void>;
  downloadUpdate(): Promise<void>;
  installUpdate(): Promise<void>;
  onUpdate(callback: (event: UpdateStatus) => void): () => void;
}
declare global {
  interface Window {
    interview?: DesktopBridge;
  }
}
