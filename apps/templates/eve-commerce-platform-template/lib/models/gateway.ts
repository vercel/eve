import { gateway } from "ai";
import { modelCatalogSchema } from "./catalog";

export async function readModelCatalog() {
  const { models } = await gateway.getAvailableModels();
  return modelCatalogSchema.parse(
    models
      .filter((model) => model.modelType === "language")
      .map((model) => ({
        id: model.id,
        name: model.name,
        ownedBy: model.specification.provider,
        pricing: model.pricing
          ? {
              input: perMillion(model.pricing.input),
              output: perMillion(model.pricing.output),
            }
          : undefined,
      })),
  );
}

function perMillion(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed * 1_000_000 : undefined;
}
