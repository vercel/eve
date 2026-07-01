import { z } from "#compiled/zod/index.js";
import type { ModelRouting } from "#shared/agent-definition.js";

const gatewayRouting = z.object({
  kind: z.literal("gateway"),
  target: z.string(),
  byok: z.string().optional(),
});
const externalRouting = z.object({ kind: z.literal("external"), provider: z.string() });

/** Strict variant for compiled-manifest validation: unknown keys are compiler drift. */
export const modelRoutingSchema = z.discriminatedUnion("kind", [
  gatewayRouting.strict(),
  externalRouting.strict(),
]) satisfies z.ZodType<ModelRouting>;

/**
 * Strip-mode variant for clients parsing responses from possibly newer
 * servers: unknown keys are dropped instead of failing the parse.
 */
export const modelRoutingClientSchema = z.discriminatedUnion("kind", [
  gatewayRouting,
  externalRouting,
]) satisfies z.ZodType<ModelRouting>;
