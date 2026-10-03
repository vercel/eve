interface SpanRecord {
  readonly name: string;
  readonly attributes: Readonly<Record<string, unknown>>;
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
  const conversationId = span.attributes["gen_ai.conversation.id"];
  const turnId = span.attributes["agent.turn.id"];
  return typeof turnId === "string"
    ? `${typeof conversationId === "string" ? conversationId : ""}\0${turnId}`
    : undefined;
}
