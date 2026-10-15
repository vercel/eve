import { z } from "#compiled/zod/index.js";
import { interactionJsonSchema } from "#protocol/interaction-json.js";

const sessionCursorSchema = z
  .object({
    sessionId: z.string().min(1),
    streamIndex: z.number().int().nonnegative(),
  })
  .strict();
const targetSchema = z.object({ kind: z.literal("remote"), serverUrl: z.url() }).strict();
const invokeResumeSchema = z
  .object({ session: sessionCursorSchema, target: targetSchema })
  .strict();
const turnOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ message: z.string().optional(), status: z.literal("completed") }).strict(),
  z.object({ message: z.string(), status: z.literal("failed") }).strict(),
]);

const invokeResultSchema = z.discriminatedUnion("status", [
  z.object({ resume: invokeResumeSchema, status: z.literal("running") }).strict(),
  z
    .object({
      interactions: z.array(interactionJsonSchema).min(1).readonly(),
      resume: invokeResumeSchema,
      status: z.literal("input-required"),
    })
    .strict(),
  z
    .object({ outcome: turnOutcomeSchema, resume: invokeResumeSchema, status: z.literal("ready") })
    .strict(),
  z.object({ message: z.string(), status: z.literal("failed") }).strict(),
  z
    .object({
      code: z.string().optional(),
      message: z.string(),
      resume: invokeResumeSchema.optional(),
      status: z.literal("authentication-required"),
    })
    .strict(),
]);

/** Durable session coordinates emitted by `eve remote invoke`. Credentials are deliberately excluded. */
export type InvokeResume = z.infer<typeof invokeResumeSchema>;
/** Result emitted by one non-interactive agent invocation. */
export type InvokeResult = z.infer<typeof invokeResultSchema>;
export type InvokeAuthenticationFailure = Extract<
  InvokeResult,
  { status: "authentication-required" }
>;

export { interactionJson as projectInvocationInteraction } from "#protocol/interaction-json.js";

/** Parses a complete, resumable result from a previous `eve remote invoke` command. */
export function parseInvokeResumeInput(value: unknown): InvokeResult & { resume: InvokeResume } {
  const result = invokeResultSchema.safeParse(value);
  if (result.success && "resume" in result.data && result.data.resume !== undefined) {
    return result.data as InvokeResult & { resume: InvokeResume };
  }
  throw new Error("Resume JSON is not a valid resumable eve remote invoke result.");
}
