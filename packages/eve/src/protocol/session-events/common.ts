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
 * A schema that parses to exactly `T`. Checked at compile time both ways, so the build fails when
 * the two drift apart: a field one has and the other lacks, a field one requires and the other
 * leaves optional, or a value one accepts and the other doesn't.
 */
export function conforming<T>() {
  return <TSchema extends z.ZodType>(
    schema: TSchema &
      ([z.output<TSchema>] extends [T]
        ? [T] extends [DeepReadonly<z.output<TSchema>>]
          ? [Exclude<KeysOf<T>, KeysOf<z.output<TSchema>>>] extends [never]
            ? [Exclude<KeysOf<z.output<TSchema>>, KeysOf<T>>] extends [never]
              ? unknown
              : { readonly missingFromType: Exclude<KeysOf<z.output<TSchema>>, KeysOf<T>> }
            : { readonly missingFromSchema: Exclude<KeysOf<T>, KeysOf<z.output<TSchema>>> }
          : { readonly schemaRejectsSome: T }
        : { readonly schemaDoesNotParseTo: T }),
  ): TSchema => schema;
}

type KeysOf<T> = T extends unknown ? keyof T : never;

/** Public types are read-only and parsed values aren't; only the shapes are compared. */
type DeepReadonly<T> = T extends readonly (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

/**
 * A string whose values the stream names: it parses open, so a reader keeps what a newer writer
 * sends, and types as the values known today, so a reader's switch keeps a default branch.
 * A plain string, not `z.custom`, so schemas published as JSON Schema (MCP tool output) can
 * still describe it.
 */
export function known<T extends string>(): z.ZodType<T>;
export function known(): z.ZodType<string> {
  return z.string();
}

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
  z.object({
    code: z.string(),
    name: z.string().optional(),
    hint: z.string().optional(),
    id: z.string().optional(),
    message: z.string(),
  }),
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
