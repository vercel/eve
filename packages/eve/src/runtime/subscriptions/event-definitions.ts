import { closestNames } from "#execution/catalog/rank.js";
import type { ChannelEventDefinition } from "#shared/channel-subscriptions.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";
import { defineJsonSchema } from "#tools/schema.js";

export function closestEventsHint(name: string, events: readonly ChannelEventDefinition[]): string {
  const closest = closestNames(name, events);
  return closest.length > 0 ? ` Closest events: ${closest.join(", ")}.` : "";
}

export async function checkEventInput(
  definition: ChannelEventDefinition,
  value: unknown,
): Promise<JsonObject> {
  const validated = await defineJsonSchema(definition.inputSchema)["~standard"].validate(value);
  if (validated.issues !== undefined)
    throw new Error(
      `Subscription input does not match the schema of "${definition.name}": ${validated.issues.map(({ message }) => message).join("; ")}`,
    );
  return parseJsonObject(validated.value);
}
