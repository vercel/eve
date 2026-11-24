import { resolveApprovalPolicy, type Approval } from "#approval/definition.js";
import { requesterOnlyResponse } from "#approval/requester-only.js";
import type { ToolEntry } from "#definitions/definition.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { SEARCH_TOOL_NAME } from "#protocol/catalog-tools.js";
import { EVENT_SUBSCRIBE_ACTION } from "#runtime/subscriptions/actions.js";
import {
  stopSubscriptionEntry,
  subscribeToChannel,
  offeredSubscriptions,
  SUBSCRIBE_TOOL,
  ttlSchema,
  type ConnectionSubscriptionAction,
  type ConnectionSubscriptionGate,
  type OfferedSubscription,
  type SubscribeInput,
} from "#runtime/subscriptions/tools.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import { isObject } from "#shared/guards.js";
import { defineJsonSchema } from "#tools/schema.js";

import { connectionEventActionApproval, runConnectionEventAction } from "./connection-entry.js";
import type { Callable } from "./step-catalog.js";

export interface SubscriptionSources {
  readonly channels: readonly OfferedSubscription[];
  readonly connections: readonly ResolvedConnectionDefinition[];
}

export function subscriptionSources(
  callable: Pick<Callable, "channels" | "connections">,
): SubscriptionSources {
  return {
    channels: offeredSubscriptions(callable.channels),
    connections: callable.connections.filter(
      (connection) => connection.experimental_events !== undefined,
    ),
  };
}

export function subscriptionTools(
  callable: Pick<Callable, "channels" | "connections" | "registry">,
): ReadonlyMap<string, ToolEntry> {
  const { channels, connections } = subscriptionSources(callable);
  if (channels.length === 0 && connections.length === 0) return new Map();
  const channelNames = new Set(channels.map(({ channelName }) => channelName));
  const connectionNames = new Set(connections.map(({ connectionName }) => connectionName));
  const shared = [...channelNames].filter((name) => connectionNames.has(name));
  if (shared.length > 0)
    throw new Error(
      `A channel and a connection are both named ${shared.map((name) => `"${name}"`).join(", ")} and both offer subscriptions, so ${SUBSCRIBE_TOOL} could not tell them apart. Rename one.`,
    );
  const gate = connectionGate(callable);
  const subscribe: HarnessToolDefinition = {
    name: SUBSCRIBE_TOOL,
    description: subscribeDescription(channels, connections),
    approval: gate.approval(EVENT_SUBSCRIBE_ACTION, (toolInput) => {
      const source = isObject(toolInput) ? toolInput.source : undefined;
      return typeof source === "string" && connectionNames.has(source) ? source : undefined;
    }),
    frameworkTool: true,
    rootOnly: true,
    inputSchema: defineJsonSchema<SubscribeInput>({
      type: "object",
      additionalProperties: false,
      required: ["source", "event", "input", "ttlMs"],
      properties: {
        source: { enum: [...channelNames, ...connectionNames] },
        event: {
          type: "string",
          description: `The event's exact name, as ${SEARCH_TOOL_NAME} returns it.`,
        },
        input: {
          type: "object",
          description: `The event's input, matching the signature ${SEARCH_TOOL_NAME} returns.`,
        },
        ttlMs: ttlSchema(),
      },
    }),
    label: { start: () => "Subscribe" },
    execute: (input: SubscribeInput, options) =>
      channelNames.has(input.source)
        ? subscribeToChannel(channels, input, options.abortSignal)
        : gate.run(
            input.source,
            EVENT_SUBSCRIBE_ACTION,
            { event: input.event, arguments: input.input, ttlMs: input.ttlMs },
            options,
          ),
  };
  return new Map<string, ToolEntry>(
    [subscribe, stopSubscriptionEntry(gate)].map((definition) => [definition.name, { definition }]),
  );
}

function connectionGate(
  callable: Pick<Callable, "connections" | "registry">,
): ConnectionSubscriptionGate {
  const gated = async (
    connectionOf: () => Promise<string | undefined> | string | undefined,
    action: ConnectionSubscriptionAction,
  ) => {
    const name = await connectionOf();
    const connection = callable.connections.find(({ connectionName }) => connectionName === name);
    return connection === undefined || callable.registry === undefined
      ? undefined
      : connectionEventActionApproval(callable.registry, connection, action);
  };
  return {
    approval: (action, connectionOf) => ({
      request: async (context) => {
        const approval = await gated(() => connectionOf(context.toolInput), action);
        return approval === undefined ? undefined : resolveApprovalPolicy(approval)(context);
      },
      response: async (context) => {
        const approval: Approval | undefined = await gated(
          () => connectionOf(context.request.toolInput),
          action,
        );
        return typeof approval === "object" && approval.response !== undefined
          ? approval.response(context)
          : requesterOnlyResponse(context);
      },
    }),
    run: (connectionName, action, input, options) => {
      const connection = callable.connections.find(
        (entry) => entry.connectionName === connectionName,
      );
      if (connection === undefined || callable.registry === undefined)
        throw new Error("Unknown subscription for this caller.");
      return runConnectionEventAction(callable.registry, connection, action, input, options);
    },
  };
}

function subscribeDescription(
  channels: readonly OfferedSubscription[],
  connections: readonly ResolvedConnectionDefinition[],
): string {
  const names = [
    ...channels.map(({ channelName }) => channelName),
    ...connections.map(({ connectionName }) => connectionName),
  ];
  const sources = [
    ...channels.map(({ channelName, events }) =>
      events === undefined
        ? `${channelName} (channel, events are in the agent's instructions)`
        : `${channelName} (channel)`,
    ),
    ...connections.map(({ connectionName }) => `${connectionName} (connection)`),
  ];
  return [
    `Subscribe to future events from ${sources.join(", ")} for \`ttlMs\` milliseconds, or pass \`null\` to keep the subscription until stopped.`,
    `Find the event names and each one's \`input\` with ${SEARCH_TOOL_NAME} first, for example { query: "subscriptions__${names[0]}__" }; an event the source does not emit is rejected with the closest names.`,
    "Channel events arrive in this conversation as queued messages after the current turn.",
    "Subscribing again with the same source, event, and input returns the existing subscription.",
  ].join(" ");
}
