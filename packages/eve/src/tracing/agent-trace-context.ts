import { createContextKey, type Context } from "#compiled/@opentelemetry/api/index.js";

// OTel context keys use Symbol.for(description), so this marker survives duplicate
// module evaluations while remaining local to the process and async context.
const AGENT_TRACE_KEY = createContextKey("eve.agent.trace");

export function isAgentTraceContext(context: unknown): boolean {
  if (typeof context !== "object" || context === null) return false;
  const getValue = Reflect.get(context, "getValue");
  return (
    typeof getValue === "function" && Reflect.apply(getValue, context, [AGENT_TRACE_KEY]) === true
  );
}

export function markAgentTraceContext(context: Context): Context {
  return context.setValue(AGENT_TRACE_KEY, true);
}
