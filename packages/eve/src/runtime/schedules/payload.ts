import { z } from "#compiled/zod/index.js";
import { parseForwardedPrincipal } from "#channel/forwarded-principal.js";
import {
  slackActionContextSchema,
  type SlackActionContext,
} from "#public/experimental/slack/action-context-schema.js";
import type { SessionAuthContext } from "#channel/types.js";
import type {
  ScheduleCollectionDefinition,
  ScheduleScopeContext,
} from "#public/schedules/collection.js";

const authSchema = z
  .custom<SessionAuthContext>((value) => parseForwardedPrincipal({ current: value }).ok)
  .nullable();
const referenceSchema = z.string().min(1).max(2048);
const bindingSchema = z
  .object({
    application: referenceSchema,
    collection: referenceSchema,
    namespace: referenceSchema,
    name: referenceSchema,
  })
  .strict();
const payloadSchema = z
  .object({
    version: z.literal(1),
    request: z
      .string()
      .max(2000)
      .refine((value) => value.trim().length > 0),
    binding: bindingSchema,
    runAs: z.enum(["creator", "app"]),
    origin: z
      .object({
        sessionId: referenceSchema,
        slack: slackActionContextSchema.optional(),
        auth: z.object({ current: authSchema, initiator: authSchema }).strict(),
        channel: z
          .object({
            kind: referenceSchema.optional(),
            continuationToken: referenceSchema.optional(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export type ScheduleCollectionPayload = z.infer<typeof payloadSchema>;
export type ScheduleCollectionOrigin = ScheduleCollectionPayload["origin"];
export type SchedulePayloadBinding = ScheduleCollectionPayload["binding"];

export function createSchedulePayload(input: {
  readonly request: unknown;
  readonly binding: SchedulePayloadBinding;
  readonly runAs: ScheduleCollectionDefinition["runAs"];
  readonly context: ScheduleScopeContext;
  readonly slack?: SlackActionContext;
}): ScheduleCollectionPayload {
  validateScheduleRequest(input.request);
  return parseSchedulePayload({
    version: 1,
    request: input.request,
    binding: input.binding,
    runAs: input.runAs,
    origin: {
      sessionId: input.context.session.id,
      slack: input.slack,
      auth: input.context.session.auth,
      channel: {
        kind: input.context.channel.kind,
        continuationToken: input.context.channel.continuationToken,
      },
    },
  });
}

/** Bounds and copies the persisted snapshot without exposing identity data in errors. */
export function parseSchedulePayload(
  value: unknown,
  expected?: SchedulePayloadBinding & { readonly runAs: ScheduleCollectionDefinition["runAs"] },
): ScheduleCollectionPayload {
  let snapshot: unknown;
  try {
    const json = JSON.stringify(value);
    if (json === undefined || Buffer.byteLength(json) > 64 * 1024) throw new Error();
    snapshot = JSON.parse(json);
  } catch {
    throw new Error("Invalid scheduled request payload; recreate the schedule.");
  }
  const parsed = payloadSchema.safeParse(snapshot);
  if (!parsed.success) throw new Error("Invalid scheduled request payload; recreate the schedule.");
  const payload = parsed.data;
  if (payload.runAs === "creator" && payload.origin.auth.current?.principalType !== "user") {
    throw new Error('Schedules with runAs: "creator" require an authenticated user.');
  }
  if (
    expected !== undefined &&
    (payload.runAs !== expected.runAs ||
      payload.binding.application !== expected.application ||
      payload.binding.collection !== expected.collection ||
      payload.binding.namespace !== expected.namespace ||
      payload.binding.name !== expected.name)
  ) {
    throw new Error("Schedule identity or execution policy changed; recreate the schedule.");
  }
  return payload;
}

export function validateScheduleRequest(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 2_000) {
    throw new Error("Scheduled request must be a non-empty string of at most 2000 characters.");
  }
  return value;
}
