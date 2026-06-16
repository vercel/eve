import type { StandardJSONSchemaV1 } from "#compiled/@standard-schema/spec/index.js";

import type { HandleMessageStreamEvent, ResultCompletedStreamEvent } from "#protocol/message.js";
import { normalizeJsonSchemaDefinition } from "#shared/json-schema.js";
import type { JsonObject } from "#shared/json.js";

/**
 * Normalizes a client-supplied output schema into the wire-safe JSON Schema
 * representation accepted by eve message routes.
 */
export function normalizeOutputSchemaForRequest<TOutput>(
  schema: StandardJSONSchemaV1<unknown, TOutput> | JsonObject | undefined,
): JsonObject | undefined {
  return schema === undefined ? undefined : normalizeJsonSchemaDefinition(schema, "output");
}

/**
 * Extracts the most recent finalized structured result from a turn event list.
 */
export function extractCompletedResult<TOutput>(
  events: readonly HandleMessageStreamEvent[],
): TOutput | undefined {
  let result: TOutput | undefined;

  for (const event of events) {
    if (isResultCompletedEvent(event)) {
      result = event.data.result as TOutput;
    }
  }

  return result;
}

function isResultCompletedEvent(
  event: HandleMessageStreamEvent,
): event is ResultCompletedStreamEvent {
  return event.type === "result.completed";
}
