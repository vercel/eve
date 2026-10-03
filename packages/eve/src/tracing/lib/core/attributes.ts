import type { AttributeValue, Attributes, FrameworkIdentity, RunIdentity, Usage } from "./types.js";
const TRACE_SCHEMA_VERSION = 4;

export function identityAttributes(
  identity: Pick<RunIdentity, "runId" | "conversationId">,
): Attributes {
  return {
    "agent.run.id": identity.runId,
    "agent.trace.schema.version": TRACE_SCHEMA_VERSION,
    "gen_ai.conversation.id": identity.conversationId,
  };
}

export function namingAttributes(name: string, operation = name): Attributes {
  return { "operation.name": operation, "resource.name": name };
}

export function frameworkAttributes(framework?: FrameworkIdentity): Attributes {
  return {
    "agent.framework.name": framework?.name || undefined,
    "agent.framework.version": framework?.version || undefined,
  };
}

export function usageAttributes(usage: Usage, genAi = false): Attributes {
  const attributes: Record<string, number | undefined> = {
    "agent.usage.cost_usd": usage.costUsd,
    "agent.usage.input_tokens": usage.inputTokens,
    "agent.usage.output_tokens": usage.outputTokens,
    "agent.usage.cache_read_tokens": usage.inputTokenDetails?.cacheReadTokens,
    "agent.usage.cache_write_tokens": usage.inputTokenDetails?.cacheWriteTokens,
  };
  if (genAi)
    Object.assign(attributes, {
      "gen_ai.usage.input_tokens": usage.inputTokens,
      "gen_ai.usage.output_tokens": usage.outputTokens,
      "gen_ai.usage.cache_read.input_tokens": usage.inputTokenDetails?.cacheReadTokens,
      "gen_ai.usage.cache_write.input_tokens": usage.inputTokenDetails?.cacheWriteTokens,
    });
  return attributes;
}

export function runtimeContextAttributes(
  input: Readonly<Record<string, unknown>> | undefined,
): Attributes {
  const attributes: Record<string, Exclude<Attributes[string], undefined>> = {};
  const seen = new WeakSet<object>();
  let remaining = 256;
  function visit(key: string, value: unknown, depth: number): void {
    if (remaining <= 0 || depth > 8 || value == null) return;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      attributes[key] = value;
      remaining -= 1;
    } else if (Array.isArray(value)) {
      if (
        value.length <= 256 &&
        value.every(
          (item) =>
            typeof item === "string" || typeof item === "number" || typeof item === "boolean",
        ) &&
        new Set(value.map((item) => typeof item)).size === 1
      ) {
        attributes[key] = value as AttributeValue;
        remaining -= 1;
      }
    } else if (typeof value === "object" && !seen.has(value)) {
      seen.add(value);
      for (const keyPart of Object.keys(value)) {
        if (remaining <= 0) break;
        visit(`${key}.${keyPart}`, Reflect.get(value, keyPart), depth + 1);
      }
      seen.delete(value);
    }
  }
  if (input !== undefined) visit("ai.settings.context", input, 0);
  return attributes;
}
