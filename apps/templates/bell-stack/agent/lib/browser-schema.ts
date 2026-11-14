import { z } from "zod";

export const browserActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("goto"), url: z.string().url() }),
  z.object({ action: z.literal("click"), target: z.string() }),
  z.object({
    action: z.literal("fill"),
    target: z.string(),
    value: z.string(),
  }),
  z.object({
    action: z.literal("type"),
    target: z.string(),
    value: z.string(),
  }),
  z.object({
    action: z.literal("press"),
    target: z.string().optional(),
    key: z.string(),
  }),
  z.object({
    action: z.literal("select"),
    target: z.string(),
    value: z.string(),
  }),
  z.object({
    action: z.literal("wait"),
    milliseconds: z.number().int().positive().max(10_000),
  }),
]);
