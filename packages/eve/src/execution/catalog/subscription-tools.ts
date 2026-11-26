import { scopeApprovalEvaluation } from "#approval/evaluation.js";
import { resolveApprovalPolicy, type Approval, type ApprovalPrompt } from "#approval/definition.js";
import { requesterOnlyResponse } from "#approval/requester-only.js";
import type { ToolEntry } from "#definitions/definition.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { SEARCH_TOOL_NAME } from "#protocol/catalog-tools.js";
import {
  EVENT_SUBSCRIBE_ACTION,
  toolFilterMayOfferEvents,
} from "#runtime/subscriptions/actions.js";
import {
  stopSubscriptionEntry,
  subscribeToChannel,
  offeredSubscriptions,
  SUBSCRIBE_TOOL,
  ttlSchema,
  type ConnectionSubscriptionGate,
  type OfferedSubscription,
  type SubscribeInput,
} from "#runtime/subscriptions/tools.js";
import type { ResolvedConnectionDefinition } from "#runtime/types.js";
import { formatDuration } from "#shared/format-duration.js";
import { isObject } from "#shared/guards.js";
import { defineJsonSchema } from "#tools/schema.js";

import { connectionEventActionApproval, runConnectionEventAction } from "./connection-entry.js";
import type { Callable } from "./step-catalog.js";

export interface SubscriptionSources {
  readonly channels: readonly OfferedSubscription[];
  readonly connections: readonly ResolvedConnectionDefinition[];
}

export function subscriptionSources(
  callable: Pick<Callable, "channels" | "connections" | "subagent">,
): SubscriptionSources {
  if (callable.subagent) return { channels: [], connections: [] };
  return {
    channels: offeredSubscriptions(callable.channels),
    connections: callable.connections.filter(
      (connection) =>
        connection.experimental_events !== undefined && toolFilterMayOfferEvents(connection.tools),
    ),
  };
}

export function subscriptionTools(
  callable: Pick<Callable, "agentApproval" | "channels" | "connections" | "registry" | "subagent">,
): ReadonlyMap<string, ToolEntry> {
  const { channels, connections } = subscriptionSources(callable);
  if (channels.length === 0 && connections.length === 0) return new Map();
  const channelNames = new Set(channels.map(({ channelName }) => channelName));
  const connectionNames = new Set(connections.map(({ connectionName }) => connectionName));
  const gate = connectionGate(callable);
  const subscribePrompt: ApprovalPrompt = (context) => {
    const source = typeof context.input.source === "string" ? context.input.source : undefined;
    const authored = connectionNames.has(source ?? "") ? gate.authoredPrompt(source) : undefined;
    return authored?.(context) ?? defaultSubscribePrompt(context.input);
  };
  const subscribe: HarnessToolDefinition = {
    name: SUBSCRIBE_TOOL,
    description: subscribeDescription(),
    approval: gate.approval(
      (toolInput) => {
        const source = isObject(toolInput) ? toolInput.source : undefined;
        return typeof source === "string" && connectionNames.has(source) ? source : undefined;
      },
      subscribePrompt,
      (toolInput) => String(isObject(toolInput) ? toolInput.event : ""),
    ),
    agentApprovalIncluded: true,
    frameworkTool: true,
    rootOnly: true,
    inputSchema: defineJsonSchema<SubscribeInput>({
      type: "object",
      additionalProperties: false,
      required: ["source", "event", "input", "ttlMs"],
      properties: {
        source: {
          type: "string",
          description: `The channel or connection that emits the event, as ${SEARCH_TOOL_NAME} returns it.`,
        },
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
    execute: (input: SubscribeInput, options) => {
      if (channelNames.has(input.source))
        return subscribeToChannel(channels, input, options.abortSignal);
      if (connectionNames.has(input.source))
        return gate.run(
          input.source,
          EVENT_SUBSCRIBE_ACTION,
          { event: input.event, arguments: input.input, ttlMs: input.ttlMs },
          options,
        );
      throw new Error(
        `Unknown subscription source "${input.source}". Find sources and their events with ${SEARCH_TOOL_NAME}.`,
      );
    },
  };
  return new Map<string, ToolEntry>(
    [subscribe, stopSubscriptionEntry(gate)].map((definition) => [definition.name, { definition }]),
  );
}

function defaultSubscribePrompt(input: Record<string, unknown>): string {
  const ttl =
    typeof input.ttlMs === "number" ? `for ${formatDuration(input.ttlMs)}` : "until stopped";
  return `Subscribe to ${JSON.stringify(input.event)} events from ${JSON.stringify(input.source)} ${ttl}, with input ${JSON.stringify(input.input)}?`;
}

function connectionGate(
  callable: Pick<Callable, "agentApproval" | "connections" | "registry">,
): ConnectionSubscriptionGate {
  const { agentApproval } = callable;
  const approvalOf = (name: string | undefined) => {
    const connection = callable.connections.find(({ connectionName }) => connectionName === name);
    return connection === undefined || callable.registry === undefined
      ? undefined
      : connectionEventActionApproval(connection, agentApproval);
  };
  const gated = async (connectionOf: () => Promise<string | undefined> | string | undefined) =>
    approvalOf(await connectionOf());
  return {
    authoredPrompt: (name) => {
      const approval = approvalOf(name);
      return typeof approval === "object" ? approval.prompt : undefined;
    },
    approval: (connectionOf, prompt, consentKey) => ({
      prompt,
      request: async (context) => {
        const connection = await connectionOf(context.toolInput);
        const approval = approvalOf(connection);
        if (approval === undefined)
          return agentApproval === undefined ? undefined : agentApproval(context);
        return resolveApprovalPolicy(approval)(
          scopeApprovalEvaluation(
            context,
            JSON.stringify([connection, consentKey(context.toolInput)]),
          ),
        );
      },
      response: async (context) => {
        const approval: Approval | undefined = await gated(() =>
          connectionOf(context.request.toolInput),
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
      return runConnectionEventAction(
        callable.registry,
        connection,
        action,
        input,
        options,
        agentApproval,
      );
    },
  };
}

function subscribeDescription(): string {
  return [
    "Subscribe to future events from a channel or an MCP connection for `ttlMs` milliseconds, or pass `null` to keep the subscription until stopped.",
    `Find the source, the event name and the event's \`input\` with ${SEARCH_TOOL_NAME} first, for example { query: "subscriptions__<source>__" } or words such as "check suite"; an event the source does not emit is rejected with the closest names.`,
    "Channel events arrive in this conversation as queued messages after the current turn.",
    "Subscribing again with the same source, event, and input returns the existing subscription.",
  ].join(" ");
}
