import { recordUsage } from "#harness/usage-sink.js";
import { extractGatewayCostUsd } from "#harness/model-call/usage.js";
import { assertExtractionModel } from "#ai/extraction-adapter.js";
import type { ExtractionField, ExtractionOptions, ExtractionResult } from "#ai/extraction-types.js";
import { extractWithTracing } from "#instrumentation/extract.js";

/** Extract typed field values from shared state using eve's model authentication. */
export async function extract<const Fields extends Readonly<Record<string, ExtractionField>>>(
  options: ExtractionOptions<Fields>,
): Promise<ExtractionResult<Fields>> {
  assertExtractionModel(options.model);
  const result = await extractWithTracing(options);
  await recordUsage(
    {
      costUsd: extractGatewayCostUsd(result.providerMetadata),
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    },
    { kind: "extraction" },
  );
  return {
    answers: result.answers as ExtractionResult<Fields>["answers"],
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      totalTokens: result.usage.totalTokens,
    },
  };
}
