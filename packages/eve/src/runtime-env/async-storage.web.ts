import type { AsyncScopeStorageClass } from "#context/scope-storage.js";

export const asyncLocalStorage: AsyncScopeStorageClass | undefined = (
  globalThis as { AsyncLocalStorage?: AsyncScopeStorageClass }
).AsyncLocalStorage;
