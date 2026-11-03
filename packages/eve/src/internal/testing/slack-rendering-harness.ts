import { buildAdapterContext } from "#channel/adapter-context.js";
import { isCompiledChannel } from "#channel/compiled-channel.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { emptySessionView } from "#protocol/session-projection/fold.js";
import type { SlackChannelState, SlackEventContext } from "#public/channels/slack/slackChannel.js";

/** A turn event {@link SlackRenderingHarness.step} fires, in the order a real turn emits them. */
export type SlackTurnStep = "turn" | "model" | "tool" | "no_reply" | "end";

export interface SlackRenderingHarness {
  /** The context the channel's handlers receive. */
  readonly channel: SlackEventContext;
  /** Runs the channel's handler for one session event. */
  event(fact: SessionEvent): Promise<void>;
  /** Runs the channel's `deliver` hook, as the runtime does when it admits a message. */
  deliver(payload: unknown): Promise<void>;
  /**
   * Fires one turn event: `turn` starts turn `t1`, `model` starts the next model run, `tool` and
   * `no_reply` call a tool from the current run and settle it, and `end` settles the turn.
   */
  step(step: SlackTurnStep): Promise<void>;
}

/** Drives a compiled Slack channel's renderer and `deliver` hook outside a running session. */
export function slackRenderingHarness(
  definition: unknown,
  state: Partial<SlackChannelState>,
): SlackRenderingHarness {
  if (!isCompiledChannel(definition)) throw new Error("Expected a compiled channel.");
  const adapter = { ...definition.adapter, state: { ...definition.adapter.state, ...state } };
  const store = new ContextContainer();
  store.setVirtualContext(SessionKey, {
    sessionId: "s1",
    auth: { current: null, initiator: null },
    turn: { id: "t1", sequence: 0 },
  });
  const channel = {
    ...buildAdapterContext(adapter, { get: () => undefined, set: () => {} } as never),
    view: emptySessionView(),
  };
  const event = async (fact: SessionEvent) => {
    const handler = adapter[fact.type as keyof typeof adapter] as
      | ((event: SessionEvent, context: typeof channel) => Promise<void>)
      | undefined;
    if (!handler) throw new Error(`No handler for ${fact.type}`);
    await contextStorage.run(store, () => handler(fact, channel));
  };
  let run = 0;
  let call = 0;
  const callTool = async (name: string) => {
    const runId = `r${run}`;
    const callId = `c${++call}`;
    const scope = { runId, turnId: "t1" };
    await event({
      type: "call.requested",
      data: { callId, owner: { runId }, capability: { kind: "tool", name }, input: {} },
      scope,
    });
    await event({ type: "call.settled", data: { callId, outcome: "completed" }, scope });
  };
  return {
    channel: channel as SlackEventContext,
    event,
    async deliver(payload) {
      await adapter.deliver?.(payload as never, channel as never);
    },
    async step(step) {
      if (step === "turn") {
        await event({
          type: "turn.started",
          data: { cause: { deliveryId: "d1" }, follows: null, turnId: "t1" },
        });
      } else if (step === "model") {
        const runId = `r${++run}`;
        await event({
          type: "model.started",
          data: { attempt: 0, modelId: "test-model", runId },
          scope: { runId, turnId: "t1" },
        });
      } else if (step === "tool") {
        await callTool("get_weather");
      } else if (step === "no_reply") {
        await callTool("no_reply");
      } else {
        await event({ type: "turn.settled", data: { turnId: "t1", outcome: "completed" } });
      }
    },
  };
}
