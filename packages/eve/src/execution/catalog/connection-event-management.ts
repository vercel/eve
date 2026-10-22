import {
  EVENT_WATCH_GET_TOOL_NAME,
  EVENT_WATCH_STOP_TOOL_NAME,
} from "#protocol/event-watch-tools.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { defineJsonSchema } from "#tools/schema.js";

/** Creator-authorized housekeeping, independent of the current connection catalog. */
export function connectionEventManagementEntry(name: string): HarnessToolDefinition | undefined {
  if (name !== EVENT_WATCH_GET_TOOL_NAME && name !== EVENT_WATCH_STOP_TOOL_NAME) return undefined;
  return {
    name,
    deferred: true,
    rootOnly: true,
    description:
      "Inspect or stop an opted-in event watch owned by the current caller, using its saved watch id.",
    inputSchema: defineJsonSchema({
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "string", pattern: "^[a-f0-9]{64}$" } },
    }),
    async execute(input) {
      const { manageCreatorWatch } = await import("#runtime/connections/events/management.js");
      return manageCreatorWatch(name === EVENT_WATCH_STOP_TOOL_NAME ? "stop" : "get", input);
    },
  };
}
