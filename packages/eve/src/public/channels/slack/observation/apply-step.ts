import { getStepMetadata } from "#compiled/@workflow/core/index.js";
import { deserializeContext } from "#context/serialize.js";
import { callSlackApi } from "#public/channels/slack/api.js";
import { SLACK_MESSAGE_TEXT_MAX_LENGTH } from "#public/channels/slack/limits.js";
import { getSlackObservation } from "#public/channels/slack/observation/ownership.js";
import type { PlannedSlackOperation } from "#public/channels/slack/observation/plan.js";
import type { SlackTransportOptions } from "#public/channels/slack/transport.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

const FETCH_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 512 * 1024;

export interface SlackObservationDestination {
  readonly channelId: string;
  readonly threadTs: string;
  readonly installationTeamId?: string;
}

export type SlackDeliveryOutcome =
  | {
      readonly kind: "confirmed";
      readonly ts: string;
      readonly text: string;
      readonly recovered?: true;
    }
  | { readonly kind: "unknown" }
  | { readonly kind: "blocked"; readonly code: string }
  | { readonly kind: "retryable"; readonly code: string; readonly retryAfterMs?: number };

/** One effect per journaled step. Ambiguous creates never automatically become another post. */
export async function applySlackObservationStep(input: {
  readonly serializedContext: Record<string, unknown>;
  readonly destination: SlackObservationDestination;
  readonly operation: PlannedSlackOperation;
  readonly ownerId: string;
}): Promise<SlackDeliveryOutcome> {
  const { operation, destination } = input;
  const ctx = await deserializeContext(input.serializedContext);
  const presentation = getSlackObservation(ctx.require(ChannelKey));
  if (presentation === undefined) return { kind: "blocked", code: "missing_renderer" };
  if (operation.message.text.length > SLACK_MESSAGE_TEXT_MAX_LENGTH) {
    return { kind: "blocked", code: "message_too_long" };
  }
  if (
    operation.kind === "recover" ||
    (operation.kind === "create" && getStepMetadata().attempt > 1)
  ) {
    return await recover(input, presentation);
  }
  let rateLimited = false;
  let retryAfterMs: number | undefined;
  const api = boundedSlackApi(presentation.api, (response) => {
    if (response.status === 429) {
      rateLimited = true;
      retryAfterMs = readRetryAfterMs(response.headers);
    }
  });
  try {
    const response = await callSlackApi({
      api,
      botToken: presentation.botToken,
      context: { teamId: destination.installationTeamId },
      operation: operation.kind === "create" ? "chat.postMessage" : "chat.update",
      body:
        operation.kind === "create"
          ? {
              channel: destination.channelId,
              thread_ts: destination.threadTs,
              text: operation.message.text,
              metadata: {
                event_type: "eve_observation",
                event_payload: { owner: input.ownerId, key: operation.key },
              },
            }
          : {
              channel: destination.channelId,
              ts: operation.providerMessageId,
              text: operation.message.text,
            },
    });
    if (response.ok === true && typeof response.ts === "string") {
      return { kind: "confirmed", ts: response.ts, text: operation.message.text };
    }
    if (response.error === "ratelimited" || response.error === "rate_limited") {
      return { kind: "retryable", code: "rate_limited", retryAfterMs };
    }
    return {
      kind: "blocked",
      code: safeSlackErrorCode(response.error),
    };
  } catch (error) {
    if (rateLimited) return { kind: "retryable", code: "rate_limited", retryAfterMs };
    if (operation.kind === "create") throw error;
    return { kind: "retryable", code: "transport_failure" };
  }
}

export async function applySlackObservationStatusStep(input: {
  readonly serializedContext: Record<string, unknown>;
  readonly destination: SlackObservationDestination;
  readonly status: string;
}): Promise<boolean> {
  const ctx = await deserializeContext(input.serializedContext);
  const presentation = getSlackObservation(ctx.require(ChannelKey));
  if (presentation === undefined) return false;
  try {
    const body: Record<string, unknown> = {
      channel_id: input.destination.channelId,
      thread_ts: input.destination.threadTs,
      status: input.status,
    };
    if (input.status) body.loading_messages = [input.status];
    const response = await callSlackApi({
      api: boundedSlackApi(presentation.api),
      botToken: presentation.botToken,
      context: { teamId: input.destination.installationTeamId },
      operation: "assistant.threads.setStatus",
      body,
    });
    return response.ok === true;
  } catch {
    return false;
  }
}

async function recover(
  input: {
    readonly destination: SlackObservationDestination;
    readonly operation: PlannedSlackOperation;
    readonly ownerId: string;
  },
  presentation: NonNullable<ReturnType<typeof getSlackObservation>>,
): Promise<SlackDeliveryOutcome> {
  let rateLimited = false;
  let retryAfterMs: number | undefined;
  try {
    const response = await callSlackApi({
      api: boundedSlackApi(presentation.api, (answer) => {
        if (answer.status === 429) {
          rateLimited = true;
          retryAfterMs = readRetryAfterMs(answer.headers);
        }
      }),
      botToken: presentation.botToken,
      context: { teamId: input.destination.installationTeamId },
      operation: "conversations.replies",
      body: {
        channel: input.destination.channelId,
        ts: input.destination.threadTs,
        inclusive: true,
        limit: 100,
      },
    });
    if (rateLimited || response.error === "ratelimited" || response.error === "rate_limited")
      return { kind: "retryable", code: "recovery_rate_limited", retryAfterMs };
    if (response.ok !== true || !Array.isArray(response.messages)) return { kind: "unknown" };
    for (const message of response.messages) {
      if (message === null || typeof message !== "object") continue;
      const metadata = Reflect.get(message, "metadata");
      if (
        metadata === null ||
        typeof metadata !== "object" ||
        Reflect.get(metadata, "event_type") !== "eve_observation"
      )
        continue;
      const payload = Reflect.get(metadata, "event_payload");
      if (payload === null || typeof payload !== "object") continue;
      if (
        Reflect.get(payload, "owner") !== input.ownerId ||
        Reflect.get(payload, "key") !== input.operation.key
      )
        continue;
      const ts = Reflect.get(message, "ts");
      if (typeof ts === "string") {
        const text = Reflect.get(message, "text");
        return {
          kind: "confirmed",
          ts,
          text: typeof text === "string" ? text : "",
          recovered: true,
        };
      }
    }
    // A bounded page cannot prove absence. Do not issue a second create.
    return { kind: "unknown" };
  } catch {
    if (rateLimited) return { kind: "retryable", code: "recovery_rate_limited", retryAfterMs };
    return { kind: "unknown" };
  }
}

function boundedSlackApi(
  api: SlackTransportOptions | undefined,
  onResponse?: (response: Response) => void,
): SlackTransportOptions {
  const originalFetch = api?.fetch ?? globalThis.fetch;
  return {
    ...api,
    fetch: async (request, init) => {
      const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
      const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      const response = await originalFetch(request, { ...init, signal });
      onResponse?.(response);
      const declaredBytes = Number(response.headers.get("content-length"));
      if (declaredBytes > MAX_RESPONSE_BYTES) {
        await response.body?.cancel().catch(() => {});
        throw new Error("Slack observation response exceeded the byte limit.");
      }
      if (response.body === null) return response;
      let bytes = 0;
      const boundedBody = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            bytes += chunk.byteLength;
            if (bytes > MAX_RESPONSE_BYTES)
              throw new Error("Slack observation response exceeded the byte limit.");
            controller.enqueue(chunk);
          },
        }),
      );
      return new Response(boundedBody, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      });
    },
  };
}

function readRetryAfterMs(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (value === null) return undefined;
  const seconds = Number(value);
  const milliseconds = Number.isFinite(seconds)
    ? seconds * 1_000
    : new Date(value).getTime() - Date.now();
  return Number.isFinite(milliseconds)
    ? Math.min(60_000, Math.max(1_000, Math.ceil(milliseconds)))
    : undefined;
}

function safeSlackErrorCode(value: unknown): string {
  if (typeof value !== "string") return "invalid_response";
  switch (value) {
    case "channel_not_found":
    case "not_in_channel":
    case "missing_scope":
    case "invalid_auth":
    case "not_authed":
    case "cant_update_message":
    case "message_not_found":
    case "msg_too_long":
      return value;
    default:
      return "provider_rejected";
  }
}
