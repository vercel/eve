import { closestNames } from "#execution/catalog/rank.js";
import type { ChannelEventCatalog, ChannelEventDefinition } from "#shared/channel-subscriptions.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";
import { toInputSchema } from "#tools/schema.js";

export async function readEventCatalog(
  catalog: ChannelEventCatalog,
): Promise<readonly ChannelEventDefinition[]> {
  return typeof catalog === "function" ? await catalog() : catalog;
}

export function closestEventsHint(
  name: string,
  events: readonly Pick<ChannelEventDefinition, "name" | "description">[],
): string {
  const closest = closestNames(name, events);
  return closest.length > 0 ? ` Closest events: ${closest.join(", ")}.` : "";
}

export async function checkEventInput(
  definition: ChannelEventDefinition,
  value: unknown,
): Promise<JsonObject> {
  const validated = await toInputSchema(definition.inputSchema)["~standard"].validate(value);
  if (validated.issues !== undefined)
    throw new Error(
      `Subscription input does not match the schema of "${definition.name}": ${validated.issues.map(({ message }) => message).join("; ")}`,
    );
  return parseJsonObject(validated.value);
}
