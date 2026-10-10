import { z } from "#compiled/zod/index.js";
import type { ScheduleEnvelope } from "#public/schedules/subscription.js";

const referenceSchema = z.string().min(1).max(2048);
const principalReferenceSchema = z
  .object({
    type: referenceSchema,
    authenticator: referenceSchema,
    issuer: referenceSchema.optional(),
    principalId: referenceSchema,
    subject: referenceSchema.optional(),
  })
  .strict();
const payloadSchema = z
  .object({
    eve: z
      .object({ application: referenceSchema, collection: referenceSchema, version: z.literal(3) })
      .strict(),
    envelope: z
      .object({
        version: z.literal(3),
        payload: z.json(),
        scope: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
        principal: principalReferenceSchema,
      })
      .strict(),
  })
  .strict();

export interface ScheduleCollectionPayload<TPayload = unknown> {
  readonly eve: { readonly application: string; readonly collection: string; readonly version: 3 };
  readonly envelope: ScheduleEnvelope<TPayload>;
}

export function createScheduleCollectionPayload<TPayload>(input: {
  readonly application: string;
  readonly collection: string;
  readonly envelope: ScheduleEnvelope<TPayload>;
}): ScheduleCollectionPayload<TPayload> {
  return parseSchedulePayload({
    eve: { application: input.application, collection: input.collection, version: 3 },
    envelope: input.envelope,
  });
}

export function parseSchedulePayload<TPayload = unknown>(
  value: unknown,
  expected?: { readonly application: string; readonly collection: string },
): ScheduleCollectionPayload<TPayload> {
  let snapshot: unknown;
  try {
    const json = JSON.stringify(value);
    if (json === undefined || Buffer.byteLength(json) > 64 * 1024) throw new Error();
    snapshot = JSON.parse(json);
  } catch {
    throw new Error("Invalid scheduled collection payload; recreate the schedule.");
  }
  const parsed = payloadSchema.safeParse(snapshot);
  if (!parsed.success)
    throw new Error("Invalid scheduled collection payload; recreate the schedule.");
  if (
    expected !== undefined &&
    (parsed.data.eve.application !== expected.application ||
      parsed.data.eve.collection !== expected.collection)
  ) {
    throw new Error("Schedule identity changed; recreate the schedule.");
  }
  return parsed.data as ScheduleCollectionPayload<TPayload>;
}

/** Shared validation for client writes and delivered occurrences. */
export async function validateSchedulePayload<T>(
  schema: { readonly "~standard": { validate(value: unknown): unknown } },
  value: unknown,
): Promise<T> {
  const result = (await schema["~standard"].validate(value)) as {
    readonly issues?: readonly { readonly message: string }[];
    readonly value?: T;
  };
  if (result.issues !== undefined || !("value" in result))
    throw new Error(
      `Invalid schedule payload: ${result.issues?.map((issue) => issue.message).join("; ") ?? "schema validation failed"}.`,
    );
  return result.value as T;
}
