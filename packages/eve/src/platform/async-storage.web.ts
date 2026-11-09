import type { AsyncScopeStorageClass } from "#context/scope-storage.js";

// Browsers and Web Workers have no AsyncLocalStorage, so eve's scopes settle in order on one
// current scope (`context/scope-storage.ts`). `async-storage.ts` is the Node twin.

/** The AsyncLocalStorage class this platform has: none. */
export const asyncLocalStorage: AsyncScopeStorageClass | undefined = undefined;
