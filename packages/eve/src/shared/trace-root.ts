import type { ContextReader } from "#context/key.js";
import { ParentSessionKey, TraceRootKey } from "#context/keys.js";

/**
 * Session id that a run's spans carry as `vercel.session_id`.
 *
 * Falls back to the lineage root, then to the run's own session for a
 * top-level run.
 */
export function resolveTraceRootSessionId(ctx: ContextReader, sessionId: string): string {
  const traceRoot = ctx.get(TraceRootKey);
  if (traceRoot?.kind === "own") return sessionId;
  if (traceRoot?.kind === "inherited") return traceRoot.sessionId;
  return ctx.get(ParentSessionKey)?.rootSessionId ?? sessionId;
}
