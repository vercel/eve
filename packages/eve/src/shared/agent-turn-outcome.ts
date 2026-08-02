import { z } from "#compiled/zod/index.js";

import type { JsonValue } from "#shared/json.js";
import { tokenUsageSchema, type TokenUsage } from "#shared/token-usage.js";

/**
 * What one delegated child turn produced, independent of whether the child
 * session survived it.
 */
export type AgentTurnResult =
  | {
      readonly kind: "succeeded";
      readonly output: JsonValue;
    }
  | {
      readonly kind: "failed";
      readonly error: JsonValue;
    }
  | {
      readonly kind: "cancelled";
    };

/**
 * How one delegated child turn settled.
 *
 * `parked` means the child session survived the turn and can accept another
 * delivery; `terminal` means the child session ended with this turn. The
 * lifecycle is carried explicitly: a failed turn can leave the child parked,
 * and a succeeded turn can be terminal (task mode). Consumers must never
 * infer lifecycle from success or error codes.
 *
 * `usageDelta` is the provider-reported usage this turn added to the child's
 * session subtree: the child captures its session totals at turn entry and
 * reports final-minus-entry when the turn settles. The parent folds each
 * delta exactly once, so repeated turns of a persistent child never re-report
 * earlier turns.
 */
export type AgentTurnOutcome =
  | {
      readonly kind: "parked";
      readonly result: AgentTurnResult;
      readonly usageDelta: TokenUsage;
    }
  | {
      readonly kind: "terminal";
      readonly result: AgentTurnResult;
      readonly usageDelta: TokenUsage;
    };

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const agentTurnResultSchema: z.ZodType<AgentTurnResult> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("succeeded"), output: jsonValueSchema }),
  z.strictObject({ error: jsonValueSchema, kind: z.literal("failed") }),
  z.strictObject({ kind: z.literal("cancelled") }),
]);

/**
 * Zod schema for {@link AgentTurnOutcome}.
 *
 * Validates outcomes crossing the process boundary (remote session
 * callbacks). Local notification paths construct the type directly.
 */
export const agentTurnOutcomeSchema: z.ZodType<AgentTurnOutcome> = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("parked"),
    result: agentTurnResultSchema,
    usageDelta: tokenUsageSchema,
  }),
  z.strictObject({
    kind: z.literal("terminal"),
    result: agentTurnResultSchema,
    usageDelta: tokenUsageSchema,
  }),
]);
