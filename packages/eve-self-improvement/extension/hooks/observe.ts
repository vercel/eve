import { defineHook } from "eve/hooks";
import { call, turn } from "eve/events";
import { isScheduleAuth } from "eve/schedules";
import extension from "../extension.js";
import { feedbackScope, fingerprint, observe } from "../lib/observe.js";

let warned = false;
function warnTelemetry() {
  if (warned) return;
  warned = true;
  console.warn(
    "Self-improvement telemetry unavailable; check the host's private storage access and HMAC configuration",
  );
}

export default defineHook({
  events: {
    "turn.started"(event) {
      feedbackScope.update((state) =>
        state.current === event.data.turnId
          ? state
          : {
              current: event.data.turnId,
              previous: state.current,
              currentTargets: [],
              previousTargets: state.currentTargets,
            },
      );
    },
    async "call.settled"(event, ctx) {
      if (ctx.session.parent || isScheduleAuth(ctx.session.auth.current)) return;
      const observed = call(ctx.view, event.data.callId);
      if (!observed || observed.kind !== "tool" || !observed.turnId) return;
      feedbackScope.update((state) =>
        state.current === observed.turnId
          ? {
              ...state,
              currentTargets: [...new Set([...state.currentTargets, observed.name])].slice(0, 100),
            }
          : state,
      );
      try {
        const started = observed.startedAt ? Date.parse(observed.startedAt) : undefined;
        const ended = observed.endedAt ? Date.parse(observed.endedAt) : ctx.now.getTime();
        await observe(extension.config, {
          id: `${ctx.session.id}:${ctx.occurrence.idempotencyKey}`,
          at: ended,
          session: ctx.session.id,
          turn: observed.turnId,
          principal: ctx.session.auth.current
            ? `${ctx.session.auth.current.authenticator}:${ctx.session.auth.current.principalId}`
            : `anonymous-session:${ctx.session.id}`,
          kind: "tool",
          target: observed.name,
          outcome: event.data.outcome,
          durationMs: started !== undefined && ended >= started ? ended - started : undefined,
          fingerprint:
            observed.input !== undefined
              ? fingerprint(extension.config, observed.input)
              : undefined,
          revision: process.env.VERCEL_GIT_COMMIT_SHA,
        });
      } catch {
        warnTelemetry();
      }
    },
    async "turn.settled"(event, ctx) {
      if (ctx.session.parent || isScheduleAuth(ctx.session.auth.current)) return;
      const observed = turn(ctx.view, event.data.turnId);
      try {
        const started = observed?.startedAt ? Date.parse(observed.startedAt) : undefined;
        const ended = observed?.endedAt ? Date.parse(observed.endedAt) : ctx.now.getTime();
        await observe(extension.config, {
          id: `${ctx.session.id}:${ctx.occurrence.idempotencyKey}`,
          at: ended,
          session: ctx.session.id,
          turn: event.data.turnId,
          principal: ctx.session.auth.current
            ? `${ctx.session.auth.current.authenticator}:${ctx.session.auth.current.principalId}`
            : `anonymous-session:${ctx.session.id}`,
          kind: "turn",
          target: "agent",
          outcome: event.data.outcome,
          durationMs: started !== undefined && ended >= started ? ended - started : undefined,
          revision: process.env.VERCEL_GIT_COMMIT_SHA,
        });
      } catch {
        warnTelemetry();
      }
    },
  },
});
