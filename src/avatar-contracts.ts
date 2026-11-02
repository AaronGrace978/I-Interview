import { z } from "zod";

export const avatarIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export const avatarStatusSchema = z.object({
  configured: z.boolean(),
  avatars: z.array(avatarIdSchema),
  session_active: z.boolean(),
  profile: z.string().max(200),
  video_runtime: z.string().max(200),
  message: z.string().max(1000),
});
export type AvatarStatus = z.infer<typeof avatarStatusSchema>;
export const avatarJobSchema = z.object({
  task_id: z.string().uuid(),
  status: z.enum(["pending", "running", "completed", "failed"]),
  avatar_id: avatarIdSchema,
  error: z.string().max(2000).nullable(),
});
export type AvatarJob = z.infer<typeof avatarJobSchema>;
export const avatarAnswerSchema = z.object({
  type: z.literal("answer"),
  sdp: z.string().min(10).max(150000),
  sessionid: z.string().min(1).max(128),
});
export type AvatarAnswer = z.infer<typeof avatarAnswerSchema>;
export const avatarSpeechSchema = z.object({
  text: z.string().trim().min(1).max(2000),
  mode: z.enum(["local", "elevenlabs"]),
  voiceId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/)
    .optional(),
});
export type AvatarSpeech = z.infer<typeof avatarSpeechSchema>;
export type GpuStatus = {
  available: boolean;
  device: string;
  vram_gib: number;
  cuda: string;
  torch: string;
  capability: number[];
  kernel_check: boolean;
};
