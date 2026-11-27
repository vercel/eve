import { defineHook } from "eve/hooks";
import { call, turn } from "eve/events";
import { isScheduleAuth } from "eve/schedules";
import extension from "../extension.js";
import {
  feedbackScope,
  fingerprint,
  observeBatch,
  pseudonymizeObservation,
} from "../lib/observe.js";
import type { Observation } from "../lib/types.js";

const MAX_BUFFERED_OBSERVATIONS = 200;
const FLUSH_TIMEOUT_MS = 15_000;

let warned = false;
function warnTelemetry() {
  if (warned) return;
  warned = true;
  console.warn(
    "Self-improvement telemetry unavailable; check the host's private storage access and HMAC configuration",
  );
}

function flushSignal(): AbortSignal {
  return AbortSignal.timeout(FLUSH_TIMEOUT_MS);
}

function drainPendingObservations(): Observation[] {
  const buffered = feedbackScope.get().pendingObservations ?? [];
  if (buffered.length === 0) return [];
  feedbackScope.update((state) => ({ ...state, pendingObservations: [] }));
  return buffered;
}

async function flushObservations(extra?: Observation, signal?: AbortSignal): Promise<void> {
  const batch = drainPendingObservations();
  if (extra !== undefined) batch.push(extra);
  if (batch.length === 0) return;
  try {
    const outcome = await observeBatch(extension.config, batch, { signal });
    if (outcome === "failed") warnTelemetry();
  } catch {
    warnTelemetry();
  }
}

export default defineHook({
  events: {
    "turn.started"(event) {
      feedbackScope.update((state) =>
        state.current === event.data.turnId
          ? state
          : {
              ...state,
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
      let sample: Observation | undefined;
      try {
        const started = observed.startedAt ? Date.parse(observed.startedAt) : undefined;
        const ended = observed.endedAt ? Date.parse(observed.endedAt) : ctx.now.getTime();
        sample = pseudonymizeObservation(extension.config, {
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
      const writeImmediately = event.data.outcome !== "completed";
      let shouldFlush = false;
      feedbackScope.update((state) => {
        const nextPending =
          sample === undefined || writeImmediately
            ? (state.pendingObservations ?? [])
            : [...(state.pendingObservations ?? []), sample];
        if (nextPending.length >= MAX_BUFFERED_OBSERVATIONS) shouldFlush = true;
        return {
          ...state,
          ...(state.current === observed.turnId && {
            currentTargets: [...new Set([...state.currentTargets, observed.name])].slice(0, 100),
          }),
          pendingObservations: nextPending,
        };
      });
      if (writeImmediately && sample !== undefined) {
        try {
          const outcome = await observeBatch(extension.config, [sample], {
            signal: flushSignal(),
          });
          if (outcome === "failed") warnTelemetry();
        } catch {
          warnTelemetry();
        }
      } else if (shouldFlush) {
        await flushObservations(undefined, flushSignal());
      }
    },
    async "turn.paused"(_event, ctx) {
      if (ctx.session.parent || isScheduleAuth(ctx.session.auth.current)) return;
      await flushObservations(undefined, flushSignal());
    },
    async "turn.settled"(event, ctx) {
      if (ctx.session.parent || isScheduleAuth(ctx.session.auth.current)) return;
      const observed = turn(ctx.view, event.data.turnId);
      let sample: Observation | undefined;
      try {
        const started = observed?.startedAt ? Date.parse(observed.startedAt) : undefined;
        const ended = observed?.endedAt ? Date.parse(observed.endedAt) : ctx.now.getTime();
        sample = pseudonymizeObservation(extension.config, {
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
      await flushObservations(sample, flushSignal());
    },
  },
});
