import { contextStorage } from "#context/container.js";
import { AuthKey, SessionIdKey, SessionTraceSeedKey } from "#context/keys.js";
import { channelEventId } from "#runtime/channels/events/id.js";
import { installedDurableHost } from "#execution/hosts.js";
import { principalOf } from "#execution/session/principal.js";
import {
  sameChannelEventOwner,
  type ChannelEventBinding,
  type ChannelEventStatus,
} from "#runtime/channels/events/state.js";
import { requireCompiledBundle, SessionAgentKey } from "#runtime/sessions/runtime-context-keys.js";
import type { ResolvedChannelDefinition } from "#runtime/types.js";
import type { ChannelEventDefinition } from "#shared/channel-subscriptions.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";
import { defineTool } from "#tools/definition.js";
import type { DynamicToolEntry } from "#tools/dynamic.js";
import { defineJsonSchema } from "#tools/schema.js";

const MIN_TTL_MS = 60_000;
const MAX_TTL_MS = 31_536_000_000;
export const GET_TOOL = "get_event_subscription";
export const STOP_TOOL = "stop_event_subscription";

interface OfferedEvent {
  readonly channelName: string;
  readonly event: string;
  readonly definition: ChannelEventDefinition;
}

/**
 * The model-facing tools for the events the agent's channels offer: one subscribe tool per event,
 * plus get and stop for subscriptions the caller holds. Returns `null` when no channel offers one.
 */
export function channelEventTools(
  channels: readonly Pick<ResolvedChannelDefinition, "name" | "definition">[],
): Record<string, DynamicToolEntry> | null {
  const offered = offeredEvents(channels);
  if (offered.length === 0) return null;
  const tools: Record<string, DynamicToolEntry> = {};
  for (const entry of offered) {
    tools[subscribeToolName(entry)] = defineTool({
      description: `Subscribe this conversation to ${entry.event} on the ${entry.channelName} channel. ${entry.definition.description} Each occurrence reaches this conversation as a queued message, after the current turn, for ttlMs milliseconds or until stopped. Set ttlMs to null to watch until stopped. Subscribing again with the same arguments returns the existing subscription. Only one session can hold a subscription for the same event and arguments.`,
      inputSchema: defineJsonSchema<{ arguments: JsonObject; ttlMs: number | null }>({
        type: "object",
        additionalProperties: false,
        required: ["arguments", "ttlMs"],
        properties: {
          arguments: entry.definition.inputSchema,
          ttlMs: {
            type: ["integer", "null"],
            minimum: MIN_TTL_MS,
            maximum: MAX_TTL_MS,
            description: `How long to watch, in milliseconds (${MIN_TTL_MS} to ${MAX_TTL_MS}), or null until stopped`,
          },
        },
      }),
      label: { start: () => `Subscribe to ${entry.event}` },
      execute: (input, { abortSignal }) => subscribe(entry, input, abortSignal),
    }) as DynamicToolEntry;
  }
  tools[GET_TOOL] = defineTool({
    description:
      "Get one of this caller's event subscriptions, by the id its subscribe call returned.",
    inputSchema: idSchema(),
    label: { start: () => "Get event subscription" },
    execute: async ({ id }) => {
      const found = await ownedBinding(id);
      return found.status === undefined ? pending(found.binding) : found.status;
    },
  }) as DynamicToolEntry;
  tools[STOP_TOOL] = defineTool({
    description:
      "Stop one of this caller's event subscriptions, by the id its subscribe call returned. Events after it ends are not delivered.",
    inputSchema: idSchema(),
    label: { start: () => "Stop event subscription" },
    execute: async ({ id }) => {
      await ownedBinding(id);
      if (!(await owners().retire(id))) throw unknownSubscription();
      return { id, status: "stopping" as const };
    },
  }) as DynamicToolEntry;
  return tools;
}

function offeredEvents(
  channels: readonly Pick<ResolvedChannelDefinition, "name" | "definition">[],
): readonly OfferedEvent[] {
  const seen = new Set<string>();
  const offered: OfferedEvent[] = [];
  for (const channel of channels) {
    if (seen.has(channel.name)) continue;
    seen.add(channel.name);
    for (const [event, definition] of Object.entries(channel.definition?.subscriptions ?? {}))
      offered.push({ channelName: channel.name, event, definition });
  }
  return offered;
}

function subscribeToolName({ channelName, event }: OfferedEvent): string {
  return `subscribe_${channelName.replace(/[^A-Za-z0-9_]/g, "_")}_${event}`;
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
  const host = installedDurableHost()?.channelEvents;
  if (host === undefined)
    throw new Error(
      "This host keeps no channel event subscriptions: subscribe from a deployed agent.",
    );
  return host;
}

function scope() {
  const ctx = contextStorage.getStore();
  if (ctx === undefined) throw new Error("Event subscriptions require an active eve session.");
  if (ctx.get(SessionAgentKey)?.nodeId !== undefined)
    throw new Error("Event subscriptions currently require a root-agent session.");
  const auth = ctx.get(AuthKey) ?? null;
  return {
    ctx,
    auth,
    sessionId: ctx.require(SessionIdKey),
    executionPrincipal: principalOf(auth),
  };
}

async function subscribe(
  entry: OfferedEvent,
  input: { readonly arguments: JsonObject; readonly ttlMs: number | null },
  signal: AbortSignal | undefined,
): Promise<ChannelEventStatus | ReturnType<typeof pending>> {
  const { ctx, auth, sessionId, executionPrincipal } = scope();
  const host = owners();
  const validated = await defineJsonSchema(entry.definition.inputSchema)["~standard"].validate(
    input.arguments,
  );
  if (validated.issues !== undefined)
    throw new Error(
      `Event arguments do not match the event's schema: ${validated.issues.map(({ message }) => message).join("; ")}`,
    );
  const normalized = parseJsonObject(
    entry.definition.normalize?.(parseJsonObject(validated.value)) ?? validated.value,
  );
  const id = channelEventId(entry.channelName, entry.event, normalized);
  const binding: ChannelEventBinding = {
    id,
    channelName: entry.channelName,
    event: entry.event,
    arguments: structuredClone(normalized),
    sessionId,
    executionPrincipal,
    auth: structuredClone(auth),
    traceSeed: ctx.get(SessionTraceSeedKey),
    ttlMs: input.ttlMs,
  };
  const status = await host.start(binding, requireCompiledBundle(ctx), signal);
  if (status === undefined) return pending(binding);
  if (status.sessionId !== sessionId) {
    const holder = await host.find(id);
    throw new Error(
      holder !== undefined && sameChannelEventOwner(holder.binding, binding)
        ? `An earlier session of yours already holds this subscription. Stop it with ${STOP_TOOL} (id ${id}), then subscribe again.`
        : "Another session already holds a subscription for this event and these arguments.",
    );
  }
  return status;
}

async function ownedBinding(id: string) {
  const found = await owners().find(id);
  if (found === undefined || found.binding.executionPrincipal !== scope().executionPrincipal)
    throw unknownSubscription();
  return found;
}

function unknownSubscription(): Error {
  return new Error("Unknown subscription for this caller.");
}

function pending(binding: ChannelEventBinding) {
  return {
    id: binding.id,
    event: binding.event,
    arguments: binding.arguments,
    status: "pending" as const,
  };
}
