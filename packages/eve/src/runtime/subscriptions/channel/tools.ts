import { contextStorage } from "#context/container.js";
import { AuthKey, SessionIdKey, SessionTraceSeedKey } from "#context/keys.js";
import { installedDurableHost } from "#execution/hosts.js";
import { principalOf } from "#execution/session/principal.js";
import { channelSubscriptionId } from "#runtime/subscriptions/channel/id.js";
import {
  type ChannelSubscriptionBinding,
  type ChannelSubscriptionStatus,
} from "#runtime/subscriptions/channel/state.js";
import { requireCompiledBundle, SessionAgentKey } from "#runtime/sessions/runtime-context-keys.js";
import type { ResolvedChannelDefinition } from "#runtime/types.js";
import type { ChannelSubscriptions } from "#shared/channel-subscriptions.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";
import { defineTool } from "#tools/definition.js";
import type { DynamicToolEntry } from "#tools/dynamic.js";
import { defineJsonSchema } from "#tools/schema.js";

const MIN_TTL_MS = 60_000;
const MAX_TTL_MS = 31_536_000_000;
export const SUBSCRIBE_TOOL = "subscribe";
export const GET_TOOL = "get_subscription";
export const STOP_TOOL = "stop_subscription";

interface OfferedSubscriptions {
  readonly channelName: string;
  readonly subscriptions: ChannelSubscriptions;
}

interface SubscribeInput {
  readonly subscription: { readonly channel: string; readonly input: JsonObject };
  readonly ttlMs: number | null;
}

/**
 * The model-facing tools for what the agent's channels let a session subscribe to: one `subscribe`
 * whose input is the union of every channel's own input, plus get and stop for subscriptions the
 * caller holds. Returns `null` when no channel offers subscriptions.
 */
export function channelSubscriptionTools(
  channels: readonly Pick<ResolvedChannelDefinition, "name" | "definition">[],
): Record<string, DynamicToolEntry> | null {
  const offered = offeredSubscriptions(channels);
  if (offered.length === 0) return null;
  return {
    [SUBSCRIBE_TOOL]: defineTool({
      description: `Subscribe this conversation to something a channel reports later. Each occurrence reaches this conversation as a queued message, after the current turn, for ttlMs milliseconds or until stopped. Set ttlMs to null to watch until stopped. Subscribing again with the same input returns the existing subscription.\n\n${offered
        .map(({ channelName, subscriptions }) => `${channelName}: ${subscriptions.description}`)
        .join("\n")}`,
      inputSchema: defineJsonSchema<SubscribeInput>({
        type: "object",
        additionalProperties: false,
        required: ["subscription", "ttlMs"],
        properties: {
          subscription: {
            anyOf: offered.map(({ channelName, subscriptions }) => ({
              type: "object",
              additionalProperties: false,
              required: ["channel", "input"],
              properties: { channel: { const: channelName }, input: subscriptions.inputSchema },
            })),
          },
          ttlMs: {
            type: ["integer", "null"],
            minimum: MIN_TTL_MS,
            maximum: MAX_TTL_MS,
            description: `How long to watch, in milliseconds (${MIN_TTL_MS} to ${MAX_TTL_MS}), or null until stopped`,
          },
        },
      }),
      label: { start: () => "Subscribe" },
      execute: (input, { abortSignal }) => subscribe(offered, input, abortSignal),
    }) as DynamicToolEntry,
    [GET_TOOL]: defineTool({
      description: "Get one of this caller's subscriptions, by the id its subscribe call returned.",
      inputSchema: idSchema(),
      label: { start: () => "Get subscription" },
      execute: async ({ id }) => {
        const found = await ownedSubscription(id);
        return found.status ?? pending(found.binding);
      },
    }) as DynamicToolEntry,
    [STOP_TOOL]: defineTool({
      description:
        "Stop one of this caller's subscriptions, by the id its subscribe call returned. Occurrences after it ends are not delivered.",
      inputSchema: idSchema(),
      label: { start: () => "Stop subscription" },
      execute: async ({ id }) => {
        await ownedSubscription(id);
        if (!(await owners().retire(id))) throw unknownSubscription();
        return { id, status: "stopping" as const };
      },
    }) as DynamicToolEntry,
  };
}

function offeredSubscriptions(
  channels: readonly Pick<ResolvedChannelDefinition, "name" | "definition">[],
): readonly OfferedSubscriptions[] {
  const seen = new Set<string>();
  const offered: OfferedSubscriptions[] = [];
  for (const channel of channels) {
    const subscriptions = channel.definition?.subscriptions;
    if (subscriptions === undefined || seen.has(channel.name)) continue;
    seen.add(channel.name);
    offered.push({ channelName: channel.name, subscriptions });
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
  const host = installedDurableHost()?.channelSubscriptions;
  if (host === undefined)
    throw new Error("This host keeps no channel subscriptions: subscribe from a deployed agent.");
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
  offered: readonly OfferedSubscriptions[],
  input: SubscribeInput,
  signal: AbortSignal | undefined,
): Promise<ChannelSubscriptionStatus | ReturnType<typeof pending>> {
  const { ctx, auth, sessionId, executionPrincipal } = scope();
  const host = owners();
  const { channel: channelName, input: channelInput } = input.subscription;
  const entry = offered.find((candidate) => candidate.channelName === channelName);
  if (entry === undefined) throw new Error(`Channel "${channelName}" offers no subscriptions.`);
  const validated = await defineJsonSchema(entry.subscriptions.inputSchema)["~standard"].validate(
    channelInput,
  );
  if (validated.issues !== undefined)
    throw new Error(
      `Subscription input does not match the channel's schema: ${validated.issues.map(({ message }) => message).join("; ")}`,
    );
  const subscriptionInput = parseJsonObject(validated.value);
  const { key } = await entry.subscriptions.onSubscribe({
    auth,
    sessionId,
    input: subscriptionInput,
  });
  const binding: ChannelSubscriptionBinding = {
    id: channelSubscriptionId({ channelName, key, sessionId, executionPrincipal }),
    channelName,
    key,
    input: structuredClone(subscriptionInput),
    sessionId,
    executionPrincipal,
    auth: structuredClone(auth),
    traceSeed: ctx.get(SessionTraceSeedKey),
    ttlMs: input.ttlMs,
  };
  return (await host.start(binding, requireCompiledBundle(ctx), signal)) ?? pending(binding);
}

async function ownedSubscription(id: string) {
  const found = await owners().find(id);
  if (found === undefined || found.binding.executionPrincipal !== scope().executionPrincipal)
    throw unknownSubscription();
  return found;
}

function unknownSubscription(): Error {
  return new Error("Unknown subscription for this caller.");
}

function pending(binding: ChannelSubscriptionBinding) {
  return {
    id: binding.id,
    channel: binding.channelName,
    input: binding.input,
    status: "pending" as const,
  };
}
