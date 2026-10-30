import { AgentSpanIdGenerator } from "#compiled/@vercel/agent-runs/index.js";
import { describe, expect, it } from "vitest";
import { ContextContainer, contextStorage } from "#context/container.js";
import { ChannelInstrumentationKey } from "#context/keys.js";
import type { DeliverHookPayload } from "#channel/types.js";
import {
  createInstrumentationHooks,
  type InstrumentationEvent,
} from "#instrumentation/lifecycle.js";
import { bindInstrumentationRuntime } from "#instrumentation/runtime.js";
import { ConversationContextKey } from "#shared/conversation-context.js";
import { eventsOf } from "#harness/publication.js";
import {
  enterSessionProjectionAt,
  nextLinePosition,
  recordPublishedLine,
} from "#harness/session-machine/current.js";
import type { SessionEvent } from "#protocol/session-event.js";

function session(audience: "public" | "private") {
  const ctx = new ContextContainer();
  enterSessionProjectionAt(ctx, undefined);
  ctx.set(ChannelInstrumentationKey, { kind: "channel:slack", metadata: {} });
  ctx.set(ConversationContextKey, {
    audience,
    channel: { kind: "channel:slack", name: "slack" },
    environment: "production",
    principalType: "anonymous",
  });
  const content: InstrumentationEvent[] = [],
    metadata: InstrumentationEvent[] = [];
  const events = (list: InstrumentationEvent[]) => ({
    "delivery.consumed": (event: InstrumentationEvent<"delivery.consumed">) => {
      list.push(event);
    },
    "delivery.settled": (event: InstrumentationEvent<"delivery.settled">) => {
      list.push(event);
    },
  });
  const hooks = createInstrumentationHooks([
    {
      name: "content",
      tracePolicy: () => ({ emit: true, recordInputs: true, recordOutputs: true }),
      events: events(content),
    },
    {
      name: "metadata",
      tracePolicy: () => ({ emit: true, recordInputs: false, recordOutputs: false }),
      events: events(metadata),
    },
  ]);
  const runtime = bindInstrumentationRuntime(
    {
      hooks,
      forceFlush: async () => {},
      shutdown: async () => {},
      idGenerator: new AgentSpanIdGenerator(),
      otelSettings: undefined,
      runInContext: (_operation, execute) => execute(),
    },
    ctx,
    { agentName: "assistant", rootSessionId: "s", sessionId: "s" },
  )!;
  const publish = () =>
    runtime.createHandleEvent({
      handleEvent: async (publication) => {
        const facts = eventsOf(publication);
        recordPublishedLine(
          ctx,
          { at: "2026-10-09T00:00:00.000Z", facts },
          nextLinePosition(ctx),
          facts,
        );
      },
    })!;
  return {
    prepare: runtime.prepareDelivery,
    content,
    metadata,
    commit: (...facts: SessionEvent[]) => contextStorage.run(ctx, () => publish()(facts)),
  };
}
const consumed = (deliveryId: string): SessionEvent => ({
  type: "delivery.consumed",
  data: { deliveryId, turnId: "turn_0", parts: [] },
});
const settled = (deliveryId: string, outcome: "awaiting-input" | "handled"): SessionEvent => ({
  type: "delivery.settled",
  data: { deliveryId, turnId: "turn_0", outcome },
});
function register(
  prepare: (input: DeliverHookPayload) => void,
  deliveryId: string,
  message: string,
) {
  prepare({
    kind: "deliver",
    payloads: [{ message, interaction: { secret: true } }],
    deliveryMetadata: [
      { channelKind: "channel:slack", channelName: "slack", deliveryId, payloadIndex: 0 },
    ],
  });
}

describe("committed delivery instrumentation", () => {
  it.each(["public", "private"] as const)(
    "projects known content by provider policy in a %s conversation",
    async (audience) => {
      const { prepare, content, metadata, commit } = session(audience);
      register(prepare, "d_0", "Alice's report");
      expect(content).toEqual([]);
      await commit(consumed("d_0"));
      expect(content[0]).toMatchObject({
        type: "delivery.consumed",
        deliveryId: "d_0",
        delivery: { channelName: "slack" },
        input: { message: "Alice's report" },
      });
      expect((content[0] as InstrumentationEvent<"delivery.consumed">).input).not.toHaveProperty(
        "interaction",
      );
      expect(metadata[0]).toMatchObject({ input: undefined });
    },
  );
  it("settles the paused delivery and attributes resumed work to the answer, not turn endings", async () => {
    const { prepare, content, commit } = session("public");
    register(prepare, "d_question", "Review Alice's report");
    await commit(consumed("d_question"), settled("d_question", "awaiting-input"));
    register(prepare, "d_answer", "Continue with Bob's report");
    await commit(consumed("d_answer"), settled("d_answer", "handled"));
    await commit({ type: "turn.settled", data: { turnId: "turn_0", outcome: "completed" } });
    expect(
      content.map((event) => [
        event.type,
        "deliveryId" in event ? event.deliveryId : undefined,
        "outcome" in event ? event.outcome : undefined,
      ]),
    ).toEqual([
      ["delivery.consumed", "d_question", undefined],
      ["delivery.settled", "d_question", "awaiting-input"],
      ["delivery.consumed", "d_answer", undefined],
      ["delivery.settled", "d_answer", "handled"],
    ]);
  });
});
