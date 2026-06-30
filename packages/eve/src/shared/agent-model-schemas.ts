import { z } from "#compiled/zod/index.js";
import type { ModelAuth, ModelRouting } from "#shared/agent-definition.js";

export const modelRoutingSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("gateway"), target: z.string(), byok: z.string().optional() })
    .strict(),
  z.object({ kind: z.literal("external"), provider: z.string() }).strict(),
]) satisfies z.ZodType<ModelRouting>;

export const modelAuthSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ai-gateway") }).strict(),
  z.object({ kind: z.literal("codex") }).strict(),
  z.object({ kind: z.literal("external"), provider: z.string() }).strict(),
]) satisfies z.ZodType<ModelAuth>;
