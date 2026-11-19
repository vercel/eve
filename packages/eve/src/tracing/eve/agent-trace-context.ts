import { createContextKey, type Context } from "#compiled/@opentelemetry/api/index.js";
import { activeTraceOperation } from "#compiled/@vercel/agent-runs/otel.js";

const AGENT_TRACE_KEY = createContextKey("eve.agent.trace");

export function isAgentTraceContext(context: unknown): boolean {
  if (typeof context !== "object" || context === null) return false;
  if (activeTraceOperation(context as Context) !== undefined) return true;
  const getValue = Reflect.get(context, "getValue");
  return (
    typeof getValue === "function" && Reflect.apply(getValue, context, [AGENT_TRACE_KEY]) === true
  );
}

export function markAgentTraceContext(context: Context): Context {
  return context.setValue(AGENT_TRACE_KEY, true);
}
