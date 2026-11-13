import { calls, deliveries, reply, turns, usage } from "eve/events";
import { defineHook, type HookContext } from "eve/hooks";
import { createLogger, initLogger } from "evlog";
import { contentText, deliveredText } from "@agent/lib/content-text";

// evlog's eve hook (evlog/eve) still reads v26 session events, which eve 1.0
// no longer emits. This hook keeps the same per-turn wide event from v27
// events until evlog ships an eve 1.0 integration.
let loggerInitialized = false;

function logger(context: Parameters<typeof createLogger>[0]) {
  if (!loggerInitialized) {
    initLogger({ env: { service: "open-instinct" }, redact: false });
    loggerInitialized = true;
  }
  return createLogger(context);
}

function channelKind(ctx: Pick<HookContext, "channel">) {
  return ctx.channel.kind.replace(/^channel:/, "");
}

export default defineHook({
  events: {
    "turn.settled"(event, ctx) {
      try {
        const { outcome, turnId } = event.data;
        const received = deliveries(ctx.view, { turnId })
          .map(({ parts }) => deliveredText(parts ?? []))
          .filter(Boolean)
          .join("\n\n");
        const log = logger({
          agent: { name: ctx.agent.name },
          channel: { kind: channelKind(ctx) },
          // Matches the evlog.request_id that agent/instrumentation/evlog.ts
          // puts on this turn's model-call spans.
          requestId: `${ctx.session.id}:${turnId}`,
          message: {
            received,
            response: contentText(
              reply(ctx.view, turnId).filter(({ kind }) => kind === "text")
            ),
          },
          session: { id: ctx.session.id },
          tools: calls(ctx.view, { kind: "tool", turnId }).map((call) => ({
            name: call.name,
            outcome: call.outcome ?? call.state,
          })),
          turn: { id: turnId, outcome },
          usage: usage(ctx.view).total,
        });
        if (outcome === "failed") {
          log.error(event.data.error?.message ?? "The turn failed.");
        }
        log.emit();
      } catch (error) {
        // Telemetry must never fail the turn.
        console.warn("[evlog] turn event failed", { cause: error });
      }
    },
    "session.ended"(event, ctx) {
      try {
        const log = logger({
          agent: { name: ctx.agent.name },
          channel: { kind: channelKind(ctx) },
          requestId: ctx.session.id,
          session: {
            id: ctx.session.id,
            outcome: event.data.outcome,
            turns: turns(ctx.view).length,
          },
          usage: usage(ctx.view).total,
        });
        if (event.data.outcome === "failed") {
          log.error(event.data.error?.message ?? "The session failed.");
        }
        log.emit();
      } catch (error) {
        console.warn("[evlog] session event failed", { cause: error });
      }
    },
  },
});
