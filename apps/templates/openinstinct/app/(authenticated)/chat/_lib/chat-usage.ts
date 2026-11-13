import type { SessionStreamEvent } from "eve/client";
import type { ChatUsage } from "@shared/chat/schema";

/**
 * Sums the session's `usage.recorded` spend: one record per model run, plus
 * one per delegated call for what the called agent spent.
 */
export function summarizeChatUsage(
  events: readonly SessionStreamEvent[]
): ChatUsage {
  let costUsd = 0;
  let records = 0;
  let measuredCosts = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const event of events) {
    if (event.type !== "usage.recorded") continue;
    const { usage } = event.data;
    records += 1;

    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    if (usage.costUsd !== undefined) {
      costUsd += usage.costUsd;
      measuredCosts += 1;
    }
  }

  return {
    costUsd: records > 0 && measuredCosts === records ? costUsd : null,
    inputTokens,
    outputTokens,
  };
}

export function combineChatUsage(usages: readonly ChatUsage[]): ChatUsage {
  let costUsd = 0;
  let hasMeasuredCost = false;
  let hasUnmeasuredUsage = false;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const usage of usages) {
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;

    if (usage.costUsd === null) {
      hasUnmeasuredUsage ||= usage.inputTokens + usage.outputTokens > 0;
    } else {
      costUsd += usage.costUsd;
      hasMeasuredCost = true;
    }
  }

  return {
    costUsd: hasMeasuredCost && !hasUnmeasuredUsage ? costUsd : null,
    inputTokens,
    outputTokens,
  };
}

export function formatChatUsage(usage: ChatUsage) {
  const tokens = usage.inputTokens + usage.outputTokens;
  const tokenLabel = `${new Intl.NumberFormat("en", {
    notation: tokens >= 10_000 ? "compact" : "standard",
    maximumFractionDigits: 1,
  }).format(tokens)} tokens`;

  if (usage.costUsd === null) return tokenLabel;

  const costLabel = new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: usage.costUsd < 0.01 ? 4 : 2,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(usage.costUsd);

  return `${tokenLabel} · ${costLabel}`;
}

/** A paged window cannot replace a saved total, even when it contains more tokens. */
export function chatUsageSnapshot(
  measured: ChatUsage,
  initial: ChatUsage | undefined,
  historyComplete: boolean
) {
  if (historyComplete) return { usage: measured, label: "Usage" };
  return initial === undefined
    ? { usage: measured, label: "Loaded usage" }
    : { usage: initial, label: "Saved usage" };
}
