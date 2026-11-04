import { AsyncLocalStorage } from "node:async_hooks";

import type { AsyncScopeStorageClass } from "#context/scope-storage.js";

// Node's AsyncLocalStorage. `async-storage.web.ts` is the twin for runtimes without it; the
// package's `#platform/*` imports pick one by the `node` condition.

/** The AsyncLocalStorage class this platform has. */
export const asyncLocalStorage: AsyncScopeStorageClass | undefined = AsyncLocalStorage;
