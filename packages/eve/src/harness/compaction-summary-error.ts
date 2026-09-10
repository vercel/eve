import { isObject } from "#shared/guards.js";

interface CompactionSummaryFailure {
  readonly empty: boolean;
  readonly finishReason: string | undefined;
  readonly rawFinishReason: string | undefined;
  readonly providerMetadata: Readonly<Record<string, unknown>> | undefined;
  readonly summaryAttempt: number;
  readonly olderMessageCount: number;
  readonly recentMessageCount: number;
}

/** Preserve structural refusal diagnostics without retaining conversation or provider prose. */
export function createCompactionSummaryError(input: CompactionSummaryFailure): Error {
  const finishReason = diagnosticCode(input.finishReason) ?? "unknown";
  const anthropic = input.providerMetadata?.anthropic;
  const stop = isObject(anthropic) ? anthropic.stopDetails : undefined;
  const gateway = input.providerMetadata?.gateway;
  const details = {
    name: "CompactionSummaryDiagnostics",
    message: `Summary attempt ${input.summaryAttempt} stopped with ${input.olderMessageCount} older messages and ${input.recentMessageCount} recent messages.`,
    finishReason,
    rawFinishReason: diagnosticCode(input.rawFinishReason),
    providerStopType: isObject(stop) ? diagnosticCode(stop.type) : undefined,
    providerStopCategory: isObject(stop) ? diagnosticCode(stop.category) : undefined,
    generationId: isObject(gateway) ? diagnosticCode(gateway.generationId) : undefined,
    summaryAttempt: input.summaryAttempt,
    olderMessageCount: input.olderMessageCount,
    recentMessageCount: input.recentMessageCount,
  };

  return new Error(
    input.empty
      ? `The compaction model returned an empty summary. Finish reason: ${finishReason}.`
      : `The compaction model returned a filtered summary. Finish reason: ${finishReason}.`,
    { cause: details },
  );
}

function diagnosticCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value)
    ? value
    : undefined;
}
