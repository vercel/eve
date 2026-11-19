import { contextStorage } from "#context/container.js";
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

interface OfferedSubscription {
  readonly channelName: string;
  readonly declaration: ChannelSubscriptions;
}

interface SubscribeInput {
  readonly subscription: {
    readonly channel: string;
    readonly event: string;
    readonly input: JsonObject;
  };
  readonly ttlMs: number | null;
}

/**
 * The model-facing tools for what the agent's channels let a session subscribe to: one `subscribe`
 * whose input is the union of every channel's own scope, plus get and stop for subscriptions the
 * caller holds. Returns `null` when no channel offers subscriptions.
 */
export function channelSubscriptionTools(
  channels: readonly Pick<ResolvedChannelDefinition, "name" | "definition">[],
): Record<string, DynamicToolEntry> | null {
  const offered = offeredSubscriptions(channels);
  if (offered.length === 0) return null;
  return {
    [SUBSCRIBE_TOOL]: defineTool({
      description: `Subscribe this conversation to something a channel reports later. Each occurrence reaches this conversation as a queued message, after the current turn, for ttlMs milliseconds or until stopped. Set ttlMs to null to watch until stopped. Subscribing again with the same event and input returns the existing subscription.\n\n${offered
        .map(({ channelName, declaration }) => `Channel ${channelName}: ${declaration.description}`)
        .join("\n\n")}`,
      inputSchema: defineJsonSchema<SubscribeInput>({
        type: "object",
        additionalProperties: false,
        required: ["subscription", "ttlMs"],
        properties: {
          subscription: {
            anyOf: offered.map(({ channelName, declaration }) => ({
              type: "object",
              additionalProperties: false,
              required: ["channel", "event", "input"],
              properties: {
                channel: { const: channelName },
                event: {
                  type: "string",
                  enum: [...declaration.events],
                  description: "The event name to watch.",
                },
                input: declaration.inputSchema,
              },
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
        const { binding, opened } = await ownedSubscription(id);
        return opened === undefined ? pending(binding) : active(binding, opened);
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
): readonly OfferedSubscription[] {
  const seen = new Set<string>();
  const offered: OfferedSubscription[] = [];
  for (const channel of channels) {
    const declaration = channel.definition?.subscriptions;
    if (declaration === undefined || seen.has(channel.name)) continue;
    seen.add(channel.name);
    offered.push({ channelName: channel.name, declaration });
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
  offered: readonly OfferedSubscription[],
  input: SubscribeInput,
  signal: AbortSignal | undefined,
): Promise<ReturnType<typeof active> | ReturnType<typeof pending>> {
  const { ctx, auth, sessionId, executionPrincipal } = scope();
  const host = owners();
  const { channel: channelName, event, input: eventInput } = input.subscription;
  const entry = offered.find((candidate) => candidate.channelName === channelName);
  if (entry === undefined) throw new Error(`Channel "${channelName}" offers no subscriptions.`);
  if (!entry.declaration.events.includes(event))
    throw new Error(`Channel "${channelName}" emits no event named "${event}".`);
  const validated = await defineJsonSchema(entry.declaration.inputSchema)["~standard"].validate(
    eventInput,
  );
  if (validated.issues !== undefined)
    throw new Error(
      `Subscription input does not match the channel's schema: ${validated.issues.map(({ message }) => message).join("; ")}`,
    );
  const subscriptionInput = parseJsonObject(validated.value);
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

async function ownedSubscription(id: string) {
  const found = await owners().find(id);
  if (
    found === undefined ||
    found.binding.source.kind !== "channel" ||
    found.binding.executionPrincipal !== scope().executionPrincipal
  )
    throw unknownSubscription();
  return found;
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
    channel: name,
    event,
    input,
    status: "active" as const,
    expiresAt: opened.expiresAt,
  };
}

function pending(binding: SubscriptionBinding) {
  const { name, event, input } = channelOf(binding);
  return { id: binding.id, channel: name, event, input, status: "pending" as const };
}
