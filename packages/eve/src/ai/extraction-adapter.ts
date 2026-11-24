import * as aiSdk from "ai";
import type { ExtractionField, ExtractionModel, ExtractionOptions } from "#ai/extraction-types.js";
import { ensureAiSdkWarningLogger } from "#instrumentation/ai-sdk-warnings.js";
import { localGatewayExtractionModel } from "#internal/model-auth/transport.js";

type AiSdkExtract = typeof aiSdk.experimental_extract;
type AiSdkExtractOptions = Parameters<AiSdkExtract>[0];

export function resolveExtractionModel(model: ExtractionModel): ExtractionModel {
  if (typeof model !== "string") return model;
  const local = localGatewayExtractionModel(model);
  if (local !== undefined) return local;
  const provider =
    Reflect.get(globalThis, "AI_SDK_DEFAULT_PROVIDER") ?? Reflect.get(aiSdk, "gateway");
  const factory: unknown = provider == null ? undefined : Reflect.get(provider, "extractionModel");
  if (typeof factory !== "function") return model;
  try {
    return (factory.call(provider, model) as ExtractionModel | null | undefined) ?? model;
  } catch {
    return model;
  }
}

export function assertExtractionModel(model: ExtractionModel | undefined): void {
  if (model === undefined || model === null || model === "") {
    throw new TypeError(
      'extract requires a model, such as "scaledown/extract-1" or a provider extraction model. eve has no default extraction model.',
    );
  }
  if (typeof model !== "string" && typeof Reflect.get(model, "doExtract") !== "function") {
    throw new TypeError(
      "extract requires a provider extraction model implementation, not just its identity.",
    );
  }
}

function resolveAiSdkExtract(): AiSdkExtract {
  const extractWithAiSdk =
    Reflect.get(aiSdk, "extract") ?? Reflect.get(aiSdk, "experimental_extract");
  if (typeof extractWithAiSdk !== "function") {
    throw new Error(
      'extract requires an installed "ai" package that exports extract or experimental_extract. Install a version of "ai" supported by eve, such as ai@^7.0.176.',
    );
  }
  return extractWithAiSdk as AiSdkExtract;
}

export function extractWithMetadata<
  const Fields extends Readonly<Record<string, ExtractionField>>,
>({
  model,
  state,
  fields,
  referenceDate,
  maxRetries,
  signal,
  providerOptions,
}: ExtractionOptions<Fields>) {
  const extractWithAiSdk = resolveAiSdkExtract();
  ensureAiSdkWarningLogger();
  return extractWithAiSdk({
    model: (typeof model === "string"
      ? (localGatewayExtractionModel(model) ?? model)
      : model) as AiSdkExtractOptions["model"],
    state,
    fields,
    referenceDate,
    maxRetries,
    abortSignal: signal,
    providerOptions,
  });
}
