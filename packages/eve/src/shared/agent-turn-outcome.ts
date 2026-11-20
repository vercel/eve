import { z } from "#compiled/zod/index.js";

import type { JsonValue } from "#shared/json.js";
import { tokenUsageWithCostSchema, type TokenUsage } from "#shared/token-usage.js";

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

export const agentTurnOutcomeWithCostSchema: z.ZodType<AgentTurnOutcome> = z.discriminatedUnion(
  "kind",
  [
    z.strictObject({
      kind: z.literal("parked"),
      result: agentTurnResultSchema,
      usageDelta: tokenUsageWithCostSchema,
    }),
    z.strictObject({
      kind: z.literal("terminal"),
      result: agentTurnResultSchema,
      usageDelta: tokenUsageWithCostSchema,
    }),
  ],
);
