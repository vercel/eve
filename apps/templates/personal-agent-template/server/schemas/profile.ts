import { z } from "zod";

export const patchProfileBodySchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
  locale: z.string().trim().min(2).max(16).optional(),
  bio: z.string().trim().max(500).optional(),
  phoneNumber: z.string().trim().max(20).nullable().optional(),
});
