import type { ContextReader } from "#context/key.js";
import { ParentSessionKey, TraceRootKey } from "#context/keys.js";

export function resolveTraceRootSessionId(ctx: ContextReader, sessionId: string): string {
  const traceRoot = ctx.get(TraceRootKey);
  if (traceRoot?.kind === "own") return sessionId;
  if (traceRoot?.kind === "inherited") return traceRoot.sessionId;
  return ctx.get(ParentSessionKey)?.rootSessionId ?? sessionId;
}
