import { contextStorage } from "#context/container.js";
import { ConnectionRegistryKey } from "#context/providers/connection-key.js";
import { AuthKey, SessionIdKey, SessionTraceSeedKey } from "#context/keys.js";
import { installedDurableHost } from "#execution/hosts.js";
import { principalOf } from "#execution/session/principal.js";
import { channelEventKey, channelSubscriptionId } from "#runtime/subscriptions/id.js";
import type {
  ChannelSubscriptionSource,
  OpenedSubscription,
  SubscriptionBinding,
} from "#runtime/subscriptions/state.js";
import { requireCompiledBundle, SessionAgentKey } from "#runtime/sessions/runtime-context-keys.js";
import type { ResolvedChannelDefinition } from "#runtime/types.js";
import {
  subscriptionCatalogOf,
  type ChannelSubscriptionCatalog,
} from "#shared/channel-subscriptions.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { ToolExecuteOptions } from "#tools/definition.js";
import { defineJsonSchema } from "#tools/schema.js";
import {
  EVENT_GET_ACTION,
  EVENT_STOP_ACTION,
  MAX_TTL_MS,
  MIN_TTL_MS,
} from "#runtime/subscriptions/actions.js";

export const SUBSCRIBE_TOOL = "subscribe";
const GET_TOOL = "get_subscription";
const STOP_TOOL = "stop_subscription";

export interface OfferedSubscription {
  readonly channelName: string;
  readonly catalog: ChannelSubscriptionCatalog | undefined;
}

export interface SubscribeInput {
  readonly subscription: {
    readonly source: string;
    readonly event: string;
    readonly input: JsonObject;
  };
  readonly ttlMs: number | null;
}

export const CHANNEL_SUBSCRIBE_ENTRY = "eve__subscribe_channel";

export function channelSubscriptionSchemas(offered: readonly OfferedSubscription[]): JsonObject[] {
  return offered.map(({ channelName, catalog }) => {
    const event: JsonObject =
      catalog === undefined
        ? {
            type: "string",
            description: "The event name, as the agent's instructions describe it.",
          }
        : {
            type: "string",
            enum: [...catalog.events],
            description: "The event name to subscribe to.",
          };
    const input: JsonObject =
      catalog === undefined
        ? {
            type: "object",
            description: "The event's scope, as the agent's instructions describe it.",
          }
        : catalog.inputSchema;
    return {
      type: "object",
      additionalProperties: false,
      required: ["source", "event", "input"],
      properties: { source: { const: channelName }, event, input },
    };
  });
}

export function ttlSchema() {
  return {
    type: ["integer", "null"],
    minimum: MIN_TTL_MS,
    maximum: MAX_TTL_MS,
    description: `How long to keep the subscription active, in milliseconds (${MIN_TTL_MS} for 2 minutes up to ${MAX_TTL_MS} for 365 days), or null until stopped.`,
  };
}

export function channelSubscribeEntry(
  offered: readonly OfferedSubscription[],
): HarnessToolDefinition {
  return {
    name: CHANNEL_SUBSCRIBE_ENTRY,
    description: "Subscribes this conversation to a channel's event.",
    inputSchema: defineJsonSchema<SubscribeInput>({
      type: "object",
      additionalProperties: false,
      required: ["subscription", "ttlMs"],
      properties: {
        subscription: { anyOf: channelSubscriptionSchemas(offered) },
        ttlMs: ttlSchema(),
      },
    }),
    label: { start: () => "Subscribe" },
    execute: (input: SubscribeInput, { abortSignal }) => subscribe(offered, input, abortSignal),
  };
}

export function subscriptionManagementEntries(): readonly HarnessToolDefinition[] {
  return [
    {
      name: GET_TOOL,
      description: "Check the status of an active subscription by the ID returned from subscribe.",
      inputSchema: idSchema(),
      label: { start: () => "Get subscription" },
      execute: (input: { id: string }, options) => getSubscription(input.id, options),
    },
    {
      name: STOP_TOOL,
      description: "Stop an active subscription by ID so future events are not delivered.",
      inputSchema: idSchema(),
      label: { start: () => "Stop subscription" },
      execute: (input: { id: string }, options) => stopSubscription(input.id, options),
    },
  ];
}

export function offeredSubscriptions(
  channels: readonly Pick<ResolvedChannelDefinition, "name" | "definition">[],
): readonly OfferedSubscription[] {
  const seen = new Set<string>();
  const offered: OfferedSubscription[] = [];
  for (const channel of channels) {
    const onEvent = channel.definition?.onEvent;
    if (onEvent === undefined || seen.has(channel.name)) continue;
    seen.add(channel.name);
    offered.push({ channelName: channel.name, catalog: subscriptionCatalogOf(onEvent) });
  }
  return offered;
}

function idSchema() {
  return defineJsonSchema<{ id: string }>({
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
    additionalProperties: false,
  });
}

function owners() {
  const host = installedDurableHost()?.subscriptions;
  if (host === undefined)
    throw new Error("Subscriptions are not supported on this host. Run from a deployed agent.");
  return host;
}

function scope() {
  const ctx = contextStorage.getStore();
  if (ctx === undefined) throw new Error("Subscriptions require an active eve session.");
  if (ctx.get(SessionAgentKey)?.nodeId !== undefined)
    throw new Error("Subscriptions currently require a root-agent session.");
  const auth = ctx.get(AuthKey) ?? null;
  return {
    ctx,
    auth,
    sessionId: ctx.require(SessionIdKey),
    executionPrincipal: principalOf(auth),
  };
}

async function subscribe(
  offered: readonly OfferedSubscription[],
  input: SubscribeInput,
  signal: AbortSignal | undefined,
): Promise<ReturnType<typeof active> | ReturnType<typeof pending>> {
  const { ctx, auth, sessionId, executionPrincipal } = scope();
  const host = owners();
  const { source: channelName, event, input: eventInput } = input.subscription;
  const entry = offered.find((candidate) => candidate.channelName === channelName);
  if (entry === undefined) throw new Error(`Channel "${channelName}" offers no subscriptions.`);
  const { catalog } = entry;
  let subscriptionInput = parseJsonObject(eventInput);
  if (catalog !== undefined) {
    if (!catalog.events.includes(event))
      throw new Error(`Channel "${channelName}" emits no event named "${event}".`);
    const validated = await defineJsonSchema(catalog.inputSchema)["~standard"].validate(eventInput);
    if (validated.issues !== undefined)
      throw new Error(
        `Subscription input does not match the channel's schema: ${validated.issues.map(({ message }) => message).join("; ")}`,
      );
    subscriptionInput = parseJsonObject(validated.value);
  }
  const key = channelEventKey(event, subscriptionInput);
  const binding: SubscriptionBinding = {
    id: channelSubscriptionId({ channelName, key, sessionId, executionPrincipal }),
    source: {
      kind: "channel",
      name: channelName,
      event,
      key,
      input: structuredClone(subscriptionInput),
      ttlMs: input.ttlMs,
    },
    sessionId,
    executionPrincipal,
    auth: structuredClone(auth),
    traceSeed: ctx.get(SessionTraceSeedKey),
  };
  const opened = await host.start(binding, requireCompiledBundle(ctx), signal);
  return opened === undefined ? pending(binding) : active(binding, opened);
}

async function getSubscription(id: string, options: ToolExecuteOptions): Promise<unknown> {
  const found = await owners().find(id);
  if (found === undefined) throw unknownSubscription();
  const { binding, opened } = found;
  if (binding.source.kind === "connection")
    return connectionAction(binding, EVENT_GET_ACTION, options);
  ownedByCaller(binding);
  return opened === undefined ? pending(binding) : active(binding, opened);
}

async function stopSubscription(id: string, options: ToolExecuteOptions): Promise<unknown> {
  const found = await owners().find(id);
  if (found === undefined) throw unknownSubscription();
  const { binding } = found;
  if (binding.source.kind === "connection")
    return connectionAction(binding, EVENT_STOP_ACTION, options);
  ownedByCaller(binding);
  if (!(await owners().retire(id))) throw unknownSubscription();
  return { id, status: "stopping" as const };
}

function ownedByCaller(binding: SubscriptionBinding): void {
  if (binding.executionPrincipal !== scope().executionPrincipal) throw unknownSubscription();
}

async function connectionAction(
  binding: SubscriptionBinding,
  action: typeof EVENT_GET_ACTION | typeof EVENT_STOP_ACTION,
  options: ToolExecuteOptions,
): Promise<unknown> {
  const registry = scope().ctx.get(ConnectionRegistryKey);
  const actions = registry?.getClient(binding.source.name).eventActions;
  if (actions === undefined) throw unknownSubscription();
  return actions.execute(
    action,
    { id: binding.id },
    { abortSignal: options.abortSignal, callId: options.toolCallId },
  );
}

function unknownSubscription(): Error {
  return new Error("Unknown subscription for this caller.");
}

function channelOf(binding: SubscriptionBinding): ChannelSubscriptionSource {
  if (binding.source.kind !== "channel") throw unknownSubscription();
  return binding.source;
}

function active(binding: SubscriptionBinding, opened: OpenedSubscription) {
  const { name, event, input } = channelOf(binding);
  return {
    id: binding.id,
    source: name,
    event,
    input,
    status: "active" as const,
    expiresAt: opened.expiresAt,
  };
}

function pending(binding: SubscriptionBinding) {
  const { name, event, input } = channelOf(binding);
  return { id: binding.id, source: name, event, input, status: "pending" as const };
}
