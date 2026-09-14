// Estimated public list prices, in USD per 1M tokens. These are snapshots,
// rather than Gateway charges, so benchmark results remain reproducible.
export const modelPricing = {
  "claude-sonnet-4-6": {
    effectiveDate: "2026-08-17",
    source: "https://docs.anthropic.com/en/docs/about-claude/pricing",
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
  },
  "moonshotai/kimi-k3": {
    effectiveDate: "2026-08-17",
    source: "https://platform.moonshot.ai/docs/pricing/chat",
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 0,
  },
  "anthropic/claude-fable-5": {
    effectiveDate: "2026-08-17",
    source: "https://docs.anthropic.com/en/docs/about-claude/pricing",
    input: 10,
    output: 50,
    cacheRead: 1,
    cacheWrite: 12.5,
  },
  "anthropic/claude-fable-5.1": {
    effectiveDate: "2026-09-02",
    source: "https://ai-gateway.vercel.sh/v1/models",
    input: 10,
    output: 50,
    cacheRead: 0.25,
    cacheWrite: 12.5,
  },
  "xai/grok-4.6": {
    effectiveDate: "2026-08-17",
    source: "https://docs.x.ai/developers/models",
    input: 2,
    output: 6,
    cacheRead: 0.5,
    cacheWrite: 0,
  },
  "openai/gpt-5.6-sol": {
    effectiveDate: "2026-08-17",
    source: "https://openai.com/api/pricing/",
    input: 2.5,
    output: 15,
    cacheRead: 0.25,
    cacheWrite: 3.125,
  },
  "openai/gpt-5.6-terra": {
    effectiveDate: "2026-08-17",
    source: "https://openai.com/api/pricing/",
    input: 2,
    output: 12,
    cacheRead: 0.2,
    cacheWrite: 2.5,
  },
  "anthropic/claude-opus-5": {
    effectiveDate: "2026-08-28",
    source: "https://models.dev/anthropic/claude-opus-5",
    input: 5,
    output: 25,
    cacheRead: 0.5,
    cacheWrite: 6.25,
  },
  "anthropic/claude-sonnet-5": {
    effectiveDate: "2026-08-17",
    source: "https://docs.anthropic.com/en/docs/about-claude/pricing",
    input: 2,
    output: 10,
    cacheRead: 0.2,
    cacheWrite: 2.5,
  },
  "zai/glm-5.2": {
    effectiveDate: "2026-08-17",
    source: "https://docs.z.ai/guides/overview/pricing",
    input: 1.4,
    output: 4.4,
    cacheRead: 0.26,
    cacheWrite: 0,
  },
  "zai/glm-5.3": {
    effectiveDate: "2026-09-02",
    source: "https://ai-gateway.vercel.sh/v1/models",
    input: 1.4,
    output: 4.4,
    cacheRead: 0.14,
    cacheWrite: 0,
  },
  "google/gemini-3.1-pro-preview": {
    effectiveDate: "2026-08-17",
    source: "https://ai.google.dev/gemini-api/docs/pricing",
    input: 2,
    output: 12,
    cacheRead: 0.2,
    cacheWrite: 0,
  },
};

const number = (value) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const object = (value) => (value !== null && typeof value === "object" ? value : {});

export function extractRunUsage(raw, harness) {
  const usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  let found = false;
  for (const line of raw.split("\n")) {
    try {
      const event = JSON.parse(line);
      const value = usageForEvent(event, harness);
      if (value === undefined) continue;
      usage.input += value.input;
      usage.output += value.output;
      usage.reasoning += value.reasoning;
      usage.cacheRead += value.cacheRead;
      usage.cacheWrite += value.cacheWrite;
      found = true;
    } catch {
      // Ignore malformed transcript lines.
    }
  }
  return found && tokenConsumption(usage) > 0 ? usage : null;
}

function usageForEvent(event, harness) {
  const legacy = object(object(event.message).usage);
  if (event.type === "assistant" && "inputTokens" in legacy) {
    return {
      input: number(legacy.inputTokens),
      output: number(legacy.outputTokens),
      reasoning: number(legacy.reasoningTokens),
      cacheRead: number(legacy.cachedInputTokens),
      cacheWrite: number(legacy.cacheWriteTokens),
    };
  }

  if (harness === "OpenCode" && event.type === "step_finish") {
    const tokens = object(object(event.part).tokens);
    const cache = object(tokens.cache);
    return {
      input: number(tokens.input),
      output: number(tokens.output),
      reasoning: number(tokens.reasoning),
      cacheRead: number(cache.read),
      cacheWrite: number(cache.write),
    };
  }

  if (harness === "Claude Code" && event.type === "assistant") {
    const usage = object(object(event.message).usage);
    if (Object.keys(usage).length === 0) return undefined;
    return {
      input: number(usage.input_tokens),
      output: number(usage.output_tokens),
      reasoning: number(usage.reasoning_tokens),
      cacheRead: number(usage.cache_read_input_tokens),
      cacheWrite: number(usage.cache_creation_input_tokens),
    };
  }

  if (harness === "Codex" && event.type === "turn.completed") {
    const usage = object(event.usage);
    const cacheRead = number(usage.cached_input_tokens);
    return {
      // Codex reports total input tokens. Cache reads are a subset, unlike the
      // other runners which report non-cached input separately.
      input: Math.max(0, number(usage.input_tokens) - cacheRead),
      output: number(usage.output_tokens),
      reasoning: number(usage.reasoning_output_tokens ?? usage.reasoning_tokens),
      cacheRead,
      cacheWrite: number(usage.cache_write_input_tokens ?? usage.cache_creation_input_tokens),
    };
  }

  return undefined;
}

export function tokenConsumption(usage) {
  return usage.input + usage.output + usage.reasoning;
}

export function countToolInvocations(raw) {
  let count = 0;
  for (const line of raw.split("\n")) {
    try {
      const event = JSON.parse(line);
      if (event.type === "tool_use") {
        count++;
        continue;
      }
      if (event.type === "item.started" && object(event.item).type === "command_execution") {
        count++;
        continue;
      }
      if (event.type !== "assistant") continue;
      const content = object(event.message).content;
      if (Array.isArray(content))
        count += content.filter((part) => object(part).type === "tool_use").length;
    } catch {
      // Ignore malformed transcript lines.
    }
  }
  return count;
}

export function priceUsage(usage, pricing) {
  return (
    (usage.input * pricing.input +
      (usage.output + usage.reasoning) * pricing.output +
      usage.cacheRead * pricing.cacheRead +
      usage.cacheWrite * pricing.cacheWrite) /
    1_000_000
  );
}
