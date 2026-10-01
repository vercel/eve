import { z } from "#compiled/zod/index.js";
import type { ScheduleEnvelope } from "#public/schedules/collection.js";
import { SCHEDULE_DELIVERY_NAME_PATTERN } from "#runtime/schedules/validation.js";

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
const deliveryNameSchema = z.string().regex(SCHEDULE_DELIVERY_NAME_PATTERN);
const deliveryBindingSchema = z
  .object({ label: z.string().max(256).optional(), binding: z.json().optional() })
  .strict();
const envelopeSchema = z
  .object({
    version: z.literal(2),
    request: z.unknown(),
    scope: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
    principal: principalReferenceSchema,
    metadata: z.unknown(),
    deliveries: z
      .record(deliveryNameSchema, deliveryBindingSchema)
      .refine((value) => Object.keys(value).length > 0),
  })
  .strict();
const payloadSchema = z
  .object({
    eve: z
      .object({ application: referenceSchema, collection: referenceSchema, version: z.literal(2) })
      .strict(),
    envelope: envelopeSchema,
  })
  .strict();

export interface ScheduleCollectionPayload<TRequest = unknown, TMetadata = unknown> {
  readonly eve: { readonly application: string; readonly collection: string; readonly version: 2 };
  readonly envelope: ScheduleEnvelope<TRequest, TMetadata>;
}

export function createScheduleCollectionPayload<TRequest, TMetadata>(input: {
  readonly application: string;
  readonly collection: string;
  readonly envelope: ScheduleEnvelope<TRequest, TMetadata>;
}): ScheduleCollectionPayload<TRequest, TMetadata> {
  return parseSchedulePayload({
    eve: { application: input.application, collection: input.collection, version: 2 },
    envelope: input.envelope,
  });
}

export function parseSchedulePayload<TRequest = unknown, TMetadata = unknown>(
  value: unknown,
  expected?: { readonly application: string; readonly collection: string },
): ScheduleCollectionPayload<TRequest, TMetadata> {
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
  return parsed.data as ScheduleCollectionPayload<TRequest, TMetadata>;
}
