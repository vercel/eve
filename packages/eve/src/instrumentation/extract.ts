import { extractWithMetadata, resolveExtractionModel } from "#ai/extraction-adapter.js";
import type { ExtractionField, ExtractionOptions } from "#ai/extraction-types.js";
import { Experimental_ExtractionRefusalError as ExtractionRefusalError } from "#compiled/@ai-sdk/provider/index.js";
import { extractionResults } from "#instrumentation/extraction-results.js";
import { runTracedModelCall, startModelCallTrace } from "#instrumentation/model-call-trace.js";

export async function extractWithTracing<
  const Fields extends Readonly<Record<string, ExtractionField>>,
>(options: ExtractionOptions<Fields>) {
  const traced = await startModelCallTrace("extraction", () =>
    resolveExtractionModel(options.model),
  );
  if (traced?.operation === undefined) return extractWithMetadata(options);
  return runTracedModelCall(
    "extraction",
    traced.operation,
    () => extractWithMetadata({ ...options, model: traced.model }),
    {
      completed: (result) => extractionResults(options.fields, { answers: result.answers }),
      refused: (error) =>
        ExtractionRefusalError.isInstance(error)
          ? extractionResults(options.fields, { refused: error.fieldIds })
          : undefined,
    },
  );
}
