// Datadog maps operation and resource separately from the OTel span name.
export function agentSpanNamingAttributes(
  name: string,
  operation: string = name,
): Record<string, string> {
  return { "operation.name": operation, "resource.name": name };
}
