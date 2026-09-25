import { z } from "#compiled/zod/index.js";
import { inputOptionSchema, inputRequestSchema, type InputRequest } from "#shared/input.js";
import type { ConnectionAuthorizationChallenge } from "#connections/errors.js";

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
const invocationInputRequestSchema = inputRequestSchema
  .omit({ action: true, display: true, options: true })
  .extend({ options: z.array(inputOptionSchema.omit({ style: true })).optional() });
const authorizationChallengeSchema: z.ZodType<ConnectionAuthorizationChallenge> = z
  .object({
    displayName: z.string().optional(),
    expiresAt: z.string().optional(),
    instructions: z.string().optional(),
    url: z.string().optional(),
    userCode: z.string().optional(),
  })
  .strict();
const authorizationInterruptSchema = z
  .object({
    authorization: authorizationChallengeSchema.optional(),
    description: z.string(),
    name: z.string(),
    webhookUrl: z.string().optional(),
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
      requests: z.array(invocationInputRequestSchema).readonly(),
      resume: invokeResumeSchema,
      status: z.literal("input-required"),
    })
    .strict(),
  z
    .object({
      authorizations: z.array(authorizationInterruptSchema).min(1).readonly(),
      resume: invokeResumeSchema,
      status: z.literal("authorization-required"),
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
export type InvocationInputRequest = z.infer<typeof invocationInputRequestSchema>;
/** Result emitted by one non-interactive agent invocation. */
export type InvokeResult = z.infer<typeof invokeResultSchema>;
export type InvokeAuthenticationFailure = Extract<
  InvokeResult,
  { status: "authentication-required" }
>;

/** Projects a runtime input request to the stable invocation-facing contract. */
export function projectInvocationInputRequest(request: InputRequest): InvocationInputRequest {
  const { allowFreeform, kind, options, prompt, requestId } = request;
  return {
    allowFreeform,
    kind,
    options: options?.map(({ description, id, label }) => ({ description, id, label })),
    prompt,
    requestId,
  };
}

/** Parses a complete, resumable result from a previous `eve remote invoke` command. */
export function parseInvokeResumeInput(value: unknown): InvokeResult & { resume: InvokeResume } {
  const result = invokeResultSchema.safeParse(value);
  if (result.success && "resume" in result.data && result.data.resume !== undefined) {
    return result.data as InvokeResult & { resume: InvokeResume };
  }
  throw new Error("Resume JSON is not a valid resumable eve remote invoke result.");
}
