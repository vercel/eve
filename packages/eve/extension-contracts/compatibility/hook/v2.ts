import { defineHook } from "#public/hooks/index.js";

/**
 * Epoch 2 authors keyed their own bookkeeping off the turn coordinates in
 * `data` and read `meta` defensively. Both patterns must keep compiling.
 */
export default defineHook({
  events: {
    "turn.started"(event, ctx) {
      console.info("turn started", {
        agentName: ctx.agent.name,
        sequence: event.data.sequence,
        sessionId: ctx.session.id,
        turnId: event.data.turnId,
      });
    },
    "action.result"(event) {
      console.info("tool call settled", {
        status: event.data.status,
        stepIndex: event.data.stepIndex,
      });
    },
    "*"(event, ctx) {
      console.info("stream event", {
        at: event.meta?.at,
        channelKind: ctx.channel.kind,
        type: event.type,
      });
    },
  },
});
