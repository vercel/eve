import { e2eModel } from "@eve-e2e/config";
import { gateway, wrapLanguageModel, type LanguageModel } from "ai";

const model = e2eModel();

export const compactionModel: LanguageModel =
  typeof model === "string"
    ? wrapLanguageModel({
        model: gateway(model),
        middleware: {
          specificationVersion: "v4",
          async wrapGenerate({ doGenerate }) {
            const result = await doGenerate();
            if (result.finishReason.unified === "content-filter") {
              const anthropic = record(result.providerMetadata?.anthropic);
              const body = record(result.response?.body);
              const gatewayMetadata = record(result.providerMetadata?.gateway);
              console.warn("Compaction provider refusal", {
                modelId: model,
                stopDetails: stopDetails(anthropic?.stopDetails ?? body?.stop_details),
                requestId: diagnosticString(
                  result.response?.headers?.["request-id"] ??
                    result.response?.headers?.["x-request-id"],
                ),
                generationId: diagnosticString(gatewayMetadata?.generationId),
              });
            }
            return result;
          },
        },
      })
    : model;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function diagnosticString(value: unknown): string | undefined {
  return typeof value === "string" ? value.slice(0, 1_000) : undefined;
}

function stopDetails(value: unknown): Record<string, string> | undefined {
  const details = record(value);
  if (details === undefined) return undefined;
  const result: Record<string, string> = {};
  for (const field of [
    "type",
    "category",
    "explanation",
    "recommendedModel",
    "recommended_model",
  ]) {
    const entry = diagnosticString(details[field]);
    if (entry !== undefined) result[field] = entry;
  }
  return result;
}
