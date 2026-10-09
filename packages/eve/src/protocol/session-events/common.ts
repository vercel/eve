// Schemas for the values facts share, and the check that ties each schema to its public type.
// Schemas serve tests and development only; readers never load them.

import { z } from "#compiled/zod/index.js";

import type {
  Cause,
  ErrorInfo,
  JsonValue,
  Principal,
  Scope,
  Usage,
  UserPart,
  ValueReference,
} from "./envelope.js";

/**
 * A schema whose parsed output is a `T` with exactly `T`'s fields. Checked at compile time, so a
 * field added to a public type without its schema, or the reverse, fails the build.
 */
export function conforming<T>() {
  return <TSchema extends z.ZodType>(
    schema: TSchema &
      ([z.output<TSchema>] extends [T]
        ? [Exclude<KeysOf<T>, KeysOf<z.output<TSchema>>>] extends [never]
          ? unknown
          : { readonly missingFromSchema: Exclude<KeysOf<T>, KeysOf<z.output<TSchema>>> }
        : { readonly schemaDoesNotParseTo: T }),
  ): TSchema => schema;
}

type KeysOf<T> = T extends unknown ? keyof T : never;

export const id = z.string().min(1);

export const jsonValue: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);

export const scope = conforming<Scope>()(
  z.object({
    changeId: id.optional(),
    runId: id.optional(),
    taskId: id.optional(),
    turnId: id.optional(),
  }),
);

export const cause = conforming<Cause>()(
  z.union([
    z.object({ deliveryId: id }),
    z.object({ turnId: id }),
    z.object({ taskId: id }),
    z.object({ callId: id }),
    z.object({ interactionId: id }),
    z.object({ responseId: id }),
    z.object({ changeId: id }),
    z.object({ policy: z.string() }),
    z.object({ hook: z.string() }),
  ]),
);

export const principal = conforming<Principal>()(
  z.object({ id, issuer: z.string().optional(), type: z.string() }),
);

export const errorInfo = conforming<ErrorInfo>()(
  z.object({ code: z.string(), message: z.string() }),
);

const count = z.number().int().nonnegative();

export const usage = conforming<Usage>()(
  z.object({
    cacheReadTokens: count,
    cacheWriteTokens: count,
    costUsd: z.number().finite().nonnegative().optional(),
    inputTokens: count,
    outputTokens: count,
  }),
);

export const valueReference = conforming<ValueReference>()(
  z.object({
    mediaType: z.string().optional(),
    preview: z.string().optional(),
    ref: z.string().optional(),
    size: count.optional(),
    withheld: z.literal(true).optional(),
  }),
);

export const userPart = conforming<UserPart>()(
  z.union([
    z.object({ kind: z.literal("text"), text: z.string() }),
    z.object({
      filename: z.string().optional(),
      kind: z.literal("file"),
      mediaType: z.string(),
      ref: z.string().optional(),
      size: count.optional(),
      unavailable: z.literal(true).optional(),
      url: z.string().optional(),
    }),
  ]),
);

/** The schema of one fact or progress record's envelope around its payload. */
export function envelopeOf<TType extends string>(type: TType, data: z.ZodType) {
  return z.object({ data, scope: scope.optional(), type: z.literal(type) });
}
