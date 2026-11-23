import { AsyncLocalStorage } from "node:async_hooks";

import type { AsyncScopeStorageClass } from "#context/scope-storage.js";

export const asyncLocalStorage: AsyncScopeStorageClass | undefined = AsyncLocalStorage;
