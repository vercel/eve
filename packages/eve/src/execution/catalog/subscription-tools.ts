import { connectionToolName } from "#connections/ownership.js";
import type {
  Route,
  RouteIssue,
  RouteMiss,
  RouteTarget,
  ToolEntry,
} from "#definitions/definition.js";
import { eventActionName } from "#runtime/subscriptions/actions.js";
import {
  CHANNEL_SUBSCRIBE_ENTRY,
  channelSubscribeEntry,
  channelSubscriptionSchemas,
  offeredSubscriptions,
  subscriptionManagementEntries,
  SUBSCRIBE_TOOL,
  ttlSchema,
} from "#runtime/subscriptions/tools.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import { isObject } from "#shared/guards.js";
import { defineJsonSchema } from "#tools/schema.js";

import type { Callable } from "./step-catalog.js";

/**
 * The tools that subscribe the conversation to events and manage those subscriptions, whichever
 * source reports them: `subscribe` names a source (a channel or an MCP connection), one of its
 * events and that event's input. A channel that publishes its events, such as GitHub, lists them in
 * the schema; one that only defines `onEvent` takes any event name. A connection lists its events
 * at runtime, so `subscribe` hands the call to that connection's own generated tool, which keeps
 * its sign-in, approval and event catalog check.
 */
export function subscriptionTools(callable: Callable): ReadonlyMap<string, ToolEntry> {
  const channels = offeredSubscriptions(callable.channels);
  const connections = callable.connections.filter(
    (connection) => connection.experimental_events !== undefined,
  );
  if (channels.length === 0 && connections.length === 0) return new Map();
  const channelEntry = channelSubscribeEntry(channels);
  const channelNames = new Set(channels.map(({ channelName }) => channelName));
  const connectionNames = new Set(connections.map(({ connectionName }) => connectionName));
  const route: Route = {
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["subscription", "ttlMs"],
      properties: {
        subscription: {
          anyOf: [
            ...channelSubscriptionSchemas(channels),
            ...(connections.length === 0
              ? []
              : [
                  {
                    type: "object",
                    additionalProperties: false,
                    required: ["source", "event", "input"],
                    properties: {
                      source: { enum: [...connectionNames] },
                      event: { type: "string", description: "The connection's event name." },
                      input: { type: "object", description: "The event's arguments." },
                    },
                  },
                ]),
          ],
        },
        ttlMs: ttlSchema(),
      },
    },
    owns: channels.length === 0 ? [] : [channelEntry],
    target: (input) => {
      const subscription = isObject(input) ? input.subscription : undefined;
      if (!isObject(subscription) || typeof subscription.source !== "string")
        return miss("Name the source to subscribe to.");
      const { source, event } = subscription;
      if (channelNames.has(source)) return { input, name: CHANNEL_SUBSCRIBE_ENTRY };
      if (!connectionNames.has(source) || typeof event !== "string")
        return miss(`No source named "${source}" offers subscriptions.`);
      return {
        input: { arguments: subscription.input ?? {}, ttlMs: (input as { ttlMs?: unknown }).ttlMs },
        name: connectionToolName(source, eventActionName(event)),
      } satisfies RouteTarget;
    },
    explain: (_entry, issues) => issues.map(towardSubscribeInput),
  };
  return new Map<string, ToolEntry>([
    [
      SUBSCRIBE_TOOL,
      {
        definition: {
          name: SUBSCRIBE_TOOL,
          frameworkTool: true,
          description: subscribeDescription(channels, connections),
          inputSchema: defineJsonSchema(route.inputSchema),
        },
        route,
      },
    ],
    ...subscriptionManagementEntries().map((definition): [string, ToolEntry] => [
      definition.name,
      { definition },
    ]),
  ]);
}

function subscribeDescription(
  channels: ReturnType<typeof offeredSubscriptions>,
  connections: readonly ResolvedConnectionDefinition[],
): string {
  const sources = [
    ...channels.map(({ channelName, catalog }) =>
      catalog === undefined
        ? `Channel ${channelName}: Pass the event name and input the agent's instructions describe for this channel. An event the channel never reports leaves the subscription open without delivering anything.`
        : `Channel ${channelName}: ${catalog.description}`,
    ),
    ...connections.map(({ connectionName, description }) => {
      const summary = description?.trim();
      return `Connection ${connectionName}: ${summary ? `${summary} ` : ""}Pass the event name and its input arguments. Passing an unknown event name returns the events this connection supports.`;
    }),
  ];
  const intro = [
    "Subscribe to future events from a channel or connected service for `ttlMs` milliseconds, or pass `null` to keep the subscription active until stopped.",
    ...(channels.length > 0
      ? ["Channel events arrive in this conversation as queued messages after the current turn."]
      : []),
    "Calling `subscribe` again with the same source, event, and input returns the existing subscription.",
  ].join(" ");
  return `${intro}\n\n${sources.join("\n\n")}`;
}

/** Reports a connection event's `arguments` problems where the model wrote them, in `subscription.input`. */
function towardSubscribeInput(issue: RouteIssue): RouteIssue {
  const [first, ...rest] = issue.path ?? [];
  return first === "arguments" ? { ...issue, path: ["subscription", "input", ...rest] } : issue;
}

function miss(issue: string): RouteMiss {
  return { issue, path: "subscription" };
}
