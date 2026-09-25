import {
  context as otelContext,
  createContextKey,
  type Attributes,
  type Context,
} from "#compiled/@opentelemetry/api/index.js";

export interface AgentToolContentPolicy {
  readonly recordInputs: boolean;
  readonly recordOutputs: boolean;
}

export interface AgentToolSpanContext extends AgentToolContentPolicy {
  readonly recordError?: (error: unknown, errorType?: string) => void;
  readonly setAttributes?: (attributes: Attributes) => void;
}

const AGENT_TOOL_SPAN_CONTEXT_KEY = createContextKey("eve.agent.tool-span-context");
const NO_CONTENT_POLICY: AgentToolContentPolicy = { recordInputs: false, recordOutputs: false };

export function withAgentToolSpanContext(context: Context, value: AgentToolSpanContext): Context {
  return context.setValue(AGENT_TOOL_SPAN_CONTEXT_KEY, value);
}

export function withAgentToolContentPolicy(
  context: Context,
  policy: AgentToolContentPolicy,
): Context {
  const current = agentToolSpanContext(context);
  return context.setValue(AGENT_TOOL_SPAN_CONTEXT_KEY, {
    ...current,
    ...policy,
  } satisfies AgentToolSpanContext);
}

export function agentToolSpanContext(
  context: Context = otelContext.active(),
): AgentToolSpanContext | undefined {
  return context.getValue(AGENT_TOOL_SPAN_CONTEXT_KEY) as AgentToolSpanContext | undefined;
}

export function agentToolContentPolicy(
  context: Context = otelContext.active(),
): AgentToolContentPolicy {
  const spanContext = agentToolSpanContext(context);
  return spanContext === undefined
    ? NO_CONTENT_POLICY
    : {
        recordInputs: spanContext.recordInputs,
        recordOutputs: spanContext.recordOutputs,
      };
}

export function annotateAgentToolSpan(
  attributes: Attributes,
  context: Context = otelContext.active(),
): boolean {
  const setAttributes = agentToolSpanContext(context)?.setAttributes;
  if (setAttributes === undefined) return false;
  setAttributes(attributes);
  return true;
}

export function recordAgentToolSpanError(
  error: unknown,
  errorType?: string,
  context: Context = otelContext.active(),
): boolean {
  const spanContext = agentToolSpanContext(context);
  if (spanContext?.recordError === undefined) return false;
  spanContext.recordError(spanContext.recordOutputs ? error : undefined, errorType);
  return true;
}
