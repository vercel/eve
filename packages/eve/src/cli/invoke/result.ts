import { z } from "#compiled/zod/index.js";
import type { AskedInteraction } from "#protocol/session-reader.js";

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
const invocationInteractionSchema = z
  .object({
    allowFreeform: z.boolean().optional(),
    interactionId: z.string(),
    kind: z.string(),
    options: z
      .array(
        z
          .object({ description: z.string().optional(), id: z.string(), label: z.string() })
          .strict(),
      )
      .optional(),
    prompt: z.string(),
    // A sign-in completes in a browser; the invocation follows the session until it does.
    signIn: z
      .object({
        displayName: z.string().optional(),
        expiresAt: z.string().optional(),
        instructions: z.string().optional(),
        name: z.string(),
        url: z.string().optional(),
        userCode: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const turnOutcomeSchema = z.discriminatedUnion("status", [
  z.object({ message: z.string().optional(), status: z.literal("completed") }).strict(),
  z.object({ message: z.string(), status: z.literal("failed") }).strict(),
]);

const invokeResultSchema = z.discriminatedUnion("status", [
  z.object({ resume: invokeResumeSchema, status: z.literal("running") }).strict(),
  z
    .object({
      interactions: z.array(invocationInteractionSchema).min(1).readonly(),
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
type InvocationInteraction = z.infer<typeof invocationInteractionSchema>;
/** Result emitted by one non-interactive agent invocation. */
export type InvokeResult = z.infer<typeof invokeResultSchema>;
export type InvokeAuthenticationFailure = Extract<
  InvokeResult,
  { status: "authentication-required" }
>;

/** An open interaction as the invocation reports it. A sign-in's callback stays private. */
export function projectInvocationInteraction(request: AskedInteraction): InvocationInteraction {
  const { allowFreeform, kind, options, prompt, interactionId, signIn } = request;
  const projected: { -readonly [K in keyof InvocationInteraction]: InvocationInteraction[K] } = {
    allowFreeform,
    interactionId,
    kind,
    options: options?.map(({ description, id, label }) => ({ description, id, label })),
    prompt,
  };
  if (signIn !== undefined) {
    const { callbackUrl: _callbackUrl, ...visible } = signIn;
    projected.signIn = visible;
  }
  return projected;
}

/** Parses a complete, resumable result from a previous `eve remote invoke` command. */
export function parseInvokeResumeInput(value: unknown): InvokeResult & { resume: InvokeResume } {
  const result = invokeResultSchema.safeParse(value);
  if (result.success && "resume" in result.data && result.data.resume !== undefined) {
    return result.data as InvokeResult & { resume: InvokeResume };
  }
  throw new Error("Resume JSON is not a valid resumable eve remote invoke result.");
}
