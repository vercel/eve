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

export function extractRunUsage(raw) {
  const usage = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 };
  let found = false;
  for (const line of raw.split("\n")) {
    try {
      const event = JSON.parse(line);
      if (event.type !== "assistant") continue;
      const value = object(object(event.message).usage);
      if (Object.keys(value).length === 0) continue;
      usage.input += number(value.inputTokens);
      usage.output += number(value.outputTokens);
      usage.reasoning += number(value.reasoningTokens);
      usage.cacheRead += number(value.cachedInputTokens);
      usage.cacheWrite += number(value.cacheWriteTokens);
      found = true;
    } catch {
      // Ignore malformed transcript lines.
    }
  }
  return found ? usage : null;
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
