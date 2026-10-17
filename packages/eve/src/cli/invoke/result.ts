import { z } from "#compiled/zod/index.js";
import { interactionJsonSchema } from "#protocol/interaction-json.js";
import { errorInfo } from "#protocol/session-events/common.js";
import { jsonValueSchema } from "#shared/json-schemas.js";

const sessionCursorSchema = z
  .object({
    sessionId: z.string().min(1),
    streamIndex: z.number().int().nonnegative(),
  })
  .strict();
const targetSchema = z.object({ kind: z.literal("remote"), serverUrl: z.url() }).strict();
const invokeResumeSchema = z
  .object({
    session: sessionCursorSchema,
    target: targetSchema,
    deliveryId: z.string().min(1),
  })
  .strict();
const invokeResultSchema = z
  .object({
    status: z.enum(["working", "awaiting-input", "completed", "failed", "cancelled"]),
    sessionEnded: z.boolean(),
    resume: invokeResumeSchema,
    interactions: z.array(interactionJsonSchema).readonly(),
    reply: z.string().optional(),
    data: jsonValueSchema.optional(),
    error: errorInfo.optional(),
  })
  .strict()
  .refine((result) => result.status !== "awaiting-input" || result.interactions.length > 0, {
    message: "An awaiting-input invocation must include its pending interactions.",
  });

/** Durable coordinates for one invocation. Credentials are deliberately excluded. */
export type InvokeResume = z.infer<typeof invokeResumeSchema>;
/** One request's outcome, independent of whether its session has ended. */
export type InvokeResult = z.infer<typeof invokeResultSchema>;

export { interactionJson as projectInvocationInteraction } from "#protocol/interaction-json.js";

/** Parses a complete result from a previous `eve remote invoke` command. */
export function parseInvokeResumeInput(value: unknown): InvokeResult {
  const result = invokeResultSchema.safeParse(value);
  if (result.success) return result.data;
  throw new Error("Resume JSON is not a valid resumable eve remote invoke result.");
}
