import catalog from "./catalog.ts";

export function listModels() {
  return {
    builtAt: catalog.builtAt,
    models: catalog.models.map(({ name, relation, description, meta }) => ({
      name,
      relation,
      description,
      grain: meta.grain,
    })),
  };
}

export function getModel(name: string) {
  const model = catalog.models.find((entry) => entry.name === name);
  if (!model) throw new Error("Unknown model. Call list_models for the available names.");
  return { builtAt: catalog.builtAt, ...model };
}

export const allowedRelations = new Set(catalog.models.map(({ relation }) => relation));
