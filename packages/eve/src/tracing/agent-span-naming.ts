import { namingAttributes } from "#tracing/core/attributes.js";

// Datadog maps operation and resource separately from the OTel span name.
export function agentSpanNamingAttributes(
  name: string,
  operation: string = name,
): Record<string, string> {
  return namingAttributes(name, operation) as Record<string, string>;
}
