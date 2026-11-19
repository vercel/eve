interface SpanRecord {
  readonly name: string;
  readonly attributes: Readonly<Record<string, unknown>>;
}

export const DIRECT_TOOL_CALL_ATTRIBUTE = "eve.tool.invocation";
export const DIRECT_TOOL_CALL_VALUE = "direct";

export function isDirectToolCallSpan(span: Pick<SpanRecord, "attributes">): boolean {
  return span.attributes[DIRECT_TOOL_CALL_ATTRIBUTE] === DIRECT_TOOL_CALL_VALUE;
}

export function isAgentActivationSpan(span: SpanRecord): boolean {
  return (
    span.name === "agent.turn" ||
    (span.attributes["gen_ai.operation.name"] === "invoke_agent" &&
      span.attributes["agent.invocation.role"] !== "caller" &&
      typeof span.attributes["agent.turn.id"] === "string")
  );
}

export function agentTurnIdentity(span: SpanRecord): string | undefined {
  const sessionId = span.attributes["agent.run.id"];
  const turnId = span.attributes["agent.turn.id"];
  return typeof turnId === "string"
    ? `${typeof sessionId === "string" ? sessionId : ""}\0${turnId}`
    : undefined;
}
