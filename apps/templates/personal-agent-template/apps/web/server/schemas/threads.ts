import { z } from "zod";

export const threadIdParamsSchema = z.object({
  id: z.string().trim().uuid("Thread id must be a UUID"),
});

export const createThreadBodySchema = z.object({
  id: z.string().trim().uuid().optional(),
  title: z.string().trim().min(1).max(200).optional(),
});

const eveSessionSchema = z.object({
  sessionId: z.string().trim().min(1),
  streamIndex: z.number().int().min(0),
});

export const threadStateSchema = z.object({
  session: eveSessionSchema,
  events: z.array(z.unknown()),
});

export const patchThreadBodySchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  state: threadStateSchema.optional(),
});
