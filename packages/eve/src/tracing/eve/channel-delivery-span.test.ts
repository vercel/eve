import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { callAdapterEventHandler, type ChannelAdapter } from "#channel/adapter.js";
import type { ChannelAdapterContext } from "#channel/adapter.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionIdKey } from "#context/keys.js";
import { fromCompiledBundle } from "#definitions/compiled-agent.js";
import { createLogger } from "#internal/logging.js";
import { eventTracing } from "#internal/testing/event-tracing.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { reportUndeliveredReply } from "#public/channels/undelivered-reply.js";
import { type CompiledBundle, SessionAgentKey } from "#runtime/sessions/runtime-context-keys.js";

const reply = {
  data: { kind: "text", partId: "part_0", phase: "reply", value: "It's sunny in Oslo." },
  scope: { turnId: "turn_0" },
  type: "content.completed",
} as SessionEvent;
const narration = {
  ...reply,
  data: { kind: "text", partId: "part_1", phase: "narration", value: "Checking the weather." },
} as SessionEvent;

let tracing: ReturnType<typeof eventTracing>;
let ctx: ContextContainer;

beforeEach(() => {
  tracing = eventTracing();
  tracing.enable();
  ctx = new ContextContainer();
  ctx.set(
    SessionAgentKey,
    fromCompiledBundle({
      compiledArtifactsSource: {},
      resolvedAgent: { config: { name: "weather" } },
    } as CompiledBundle),
  );
  ctx.set(SessionIdKey, "session-1");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await tracing.close();
});

async function deliver(adapter: Partial<ChannelAdapter>, event: SessionEvent) {
  const scope = "scope" in event ? event.scope : undefined;
  await contextStorage.run(ctx, () =>
    callAdapterEventHandler({ kind: "slack", ...adapter } as ChannelAdapter, event, {
      scope,
    } as ChannelAdapterContext),
  );
  return tracing.exporter
    .getFinishedSpans()
    .filter((span) => span.name === "agent.channel.deliver");
}

describe("agent.channel.deliver", () => {
  it("records a final reply the channel posted", async () => {
    const spans = await deliver({ "content.completed": async () => {} }, reply);

    expect(spans).toHaveLength(1);
    expect(spans[0]?.status.code).toBe(1);
    expect(spans[0]?.attributes).toMatchObject({
      "agent.channel.delivery.outcome": "completed",
      "agent.channel.event.type": "content.completed",
      "agent.channel.kind": "slack",
      "agent.run.id": "session-1",
      "agent.turn.id": "turn_0",
    });
  });

  it("records nothing for narration the channel posted", async () => {
    expect(await deliver({ "content.completed": async () => {} }, narration)).toEqual([]);
  });

  it("records a handler that threw with its error id, for any event", async () => {
    const spans = await deliver(
      {
        "content.completed": async () => {
          throw new Error("channel_not_found for alice@example.com");
        },
      },
      narration,
    );

    expect(spans).toHaveLength(1);
    expect(spans[0]?.status.code).toBe(2);
    expect(spans[0]?.attributes).toMatchObject({
      "agent.channel.delivery.outcome": "failed",
      "error.type": "channel_handler_failed",
      "eve.error.id": expect.any(String),
    });
    expect(JSON.stringify([spans[0]?.status, spans[0]?.events])).not.toContain("alice@example.com");
  });

  it("records a final reply the channel reported undelivered", async () => {
    const spans = await deliver(
      {
        "content.completed": async () => {
          await reportUndeliveredReply(
            {
              log: createLogger("test"),
              name: "Slack",
              post: async () => undefined,
              state: {},
            },
            "turn_0",
            new Error("msg_too_long"),
          );
        },
      },
      reply,
    );

    expect(spans).toHaveLength(1);
    expect(spans[0]?.attributes).toMatchObject({
      "agent.channel.delivery.outcome": "failed",
      "error.type": "reply_undelivered",
      "eve.error.id": expect.any(String),
    });
  });
});
