import { expect } from "vitest";
import { getWorld } from "#internal/workflow/runtime.js";
import { captureTurnEvents, filterEventsByType } from "#internal/testing/events.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { sessionInboxHookToken } from "#execution/session-inbox/address.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import { ConversationContextKey } from "#shared/conversation-context.js";

export function buildSerializedContext(overrides: {
  acceptedDeploymentId?: string;
  audience?: "public" | "private" | "unknown";
  auth?: Record<string, unknown>;
  channelKind: string;
  channelState?: Record<string, unknown>;
  continuationToken?: string;
  parent?: {
    readonly callId: string;
    readonly rootSessionId: string;
    readonly sessionId: string;
    readonly turn: {
      readonly id: string;
      readonly sequence: number;
    };
  };
}): Record<string, unknown> {
  const channel: { kind: unknown; state: unknown } = {
    kind: overrides.channelKind,
    state: overrides.channelState ?? {},
  };
  const context: Record<string, unknown> = {
    "eve.auth": overrides.auth ?? null,
    "eve.bundle": { source: createBundledRuntimeCompiledArtifactsSource() },
    "eve.channel": channel,
  };
  if (overrides.audience !== undefined) {
    context[ConversationContextKey.name] = {
      audience: overrides.audience,
      channel: { kind: overrides.channelKind },
      environment: "production",
      principalType: "anonymous",
    };
  }
  if (overrides.acceptedDeploymentId !== undefined) {
    context["eve.channelDelivery"] = {
      acceptedDeploymentId: overrides.acceptedDeploymentId,
      channelKind: overrides.channelKind,
      channelName: "test",
      deliveryId: "delivery-initial",
    };
  }
  if (overrides.continuationToken !== undefined) {
    context["eve.continuationToken"] = overrides.continuationToken;
  }
  if (overrides.parent !== undefined) {
    context["eve.parentSession"] = overrides.parent;
  }
  return context;
}

export function expectSingleTurn(events: readonly MessageStreamEvent[], turnId: string): void {
  expect(filterEventsByType(events, "turn.started")).toHaveLength(1);
  const eventTurnIds = events.flatMap((event) => {
    if (!("data" in event) || typeof event.data !== "object" || event.data === null) return [];
    if (!("turnId" in event.data) || typeof event.data.turnId !== "string") return [];
    return [event.data.turnId];
  });
  expect(eventTurnIds.length).toBeGreaterThan(0);
  expect(new Set(eventTurnIds)).toEqual(new Set([turnId]));
}

const CALLER_STEP_NAMES = new Set([
  "bindTurnCallerContextStep",
  "notifyTurnCallerStep",
  "resolveInitialTurnCallerStep",
]);

export async function listCallerStepNames(runId: string): Promise<string[]> {
  return (await listStepNames(runId)).filter((name) => CALLER_STEP_NAMES.has(name)).sort();
}

async function listStepNames(runId: string): Promise<string[]> {
  const world = await getWorld();
  const steps = await world.steps.list({
    pagination: { limit: 1_000 },
    resolveData: "none",
    runId,
  });
  return steps.data.map((step) => step.stepName.split("//").at(-1) ?? "");
}

export interface CapturedEventStream {
  dispose(): void;
  nextUntil(
    label: string,
    predicate: (event: MessageStreamEvent) => boolean,
  ): Promise<MessageStreamEvent[]>;
}

export function captureEvents(run: Parameters<typeof captureTurnEvents>[0]): CapturedEventStream {
  const reader = run.readable.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let disposed = false;

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      reader.releaseLock();
    },
    nextUntil(label, predicate) {
      if (disposed) {
        return Promise.reject(new Error("CapturedEventStream: stream already disposed."));
      }
      return withTimeout(readUntil(reader, decoder, buffer, predicate), label).then((result) => {
        buffer = result.buffer;
        return result.events;
      });
    },
  };
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: InstanceType<typeof TextDecoder>,
  initialBuffer: string,
  predicate: (event: MessageStreamEvent) => boolean,
): Promise<{ buffer: string; events: MessageStreamEvent[] }> {
  const events: MessageStreamEvent[] = [];
  let buffer = initialBuffer;

  while (true) {
    const { done, value } = await reader.read();

    if (done) {
      throw new Error("Workflow stream closed before reaching the expected event.");
    }

    buffer += decoder.decode(value, { stream: true });

    for (
      let newlineIndex = buffer.indexOf("\n");
      newlineIndex !== -1;
      newlineIndex = buffer.indexOf("\n")
    ) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (line.length === 0) {
        continue;
      }

      const event = JSON.parse(line) as MessageStreamEvent;
      events.push(event);

      if (predicate(event)) {
        return { buffer, events };
      }
    }
  }
}

export async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Timed out waiting for ${label}.`));
        }, 30_000);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

export async function expectHookClaims(
  runId: string,
  tokens: string[],
  options: { readonly turnStarted?: boolean } = {},
): Promise<void> {
  const events = await (
    await getWorld()
  ).events.list({
    runId,
    pagination: { limit: 1000 },
    resolveData: "all",
  });
  const claims = events.data.flatMap((event) =>
    event.eventType === "hook_created" ? [event.eventData.token] : [],
  );
  const signals = claims.filter((token) => token.startsWith("abrt_"));
  expect(signals).toHaveLength(options.turnStarted === false ? 0 : 2);
  expect(claims.filter((token) => !token.startsWith("abrt_")).sort()).toEqual(
    tokens.map(sessionInboxHookToken).sort(),
  );
}

/** A queued follow-up delivery accepted by `acceptedDeploymentId`. */
export function handoffFollowUp(acceptedDeploymentId: string, message: string, deliveryId: string) {
  return {
    turnPolicy: "queue" as const,
    auth: null,
    delivery: {
      acceptedDeploymentId,
      channelKind: "http",
      channelName: "test",
      deliveryId,
    },
    kind: "send" as const,
    payload: { message },
  };
}
