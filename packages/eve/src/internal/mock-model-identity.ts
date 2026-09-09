// Authored bundles and the host may load separate copies of this module.
const MOCK_MODEL = Symbol.for("eve:mock-model");

export function markMockModel<T extends object>(model: T): T {
  Object.defineProperty(model, MOCK_MODEL, { value: true });
  return model;
}

export function isMockModel(model: unknown): boolean {
  return typeof model === "object" && model !== null && Reflect.get(model, MOCK_MODEL) === true;
}
