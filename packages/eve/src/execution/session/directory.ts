import { isDeepStrictEqual } from "node:util";
import { getWorld } from "#internal/workflow/runtime.js";
import type { SessionResources } from "#execution/session/resources.js";
import { sessionSnapshots } from "#execution/session/snapshots.js";
import { encodeStreamLocation } from "#execution/session/stream-location.js";
import {
  appendStreamRecords,
  readStreamRecord,
  streamTailIndex,
} from "#execution/session/stream-storage.js";

const DESCRIPTOR_CACHE_LIMIT = 256;
const caches = new WeakMap<object, Map<string, Promise<SessionResources>>>();

function descriptorStream(holderRunId: string): string {
  return encodeStreamLocation({ runId: holderRunId, namespace: "eve.session.resources" });
}

export async function publishSessionDescriptor(
  holderRunId: string,
  resources: SessionResources,
): Promise<void> {
  const stream = descriptorStream(holderRunId);
  if ((await streamTailIndex(stream)) !== -1) {
    if (!isDeepStrictEqual(await readStreamRecord<SessionResources>(stream), resources)) {
      throw new Error("An immutable session resource was published with different contents.");
    }
    return;
  }
  await appendStreamRecords(stream, [resources], true);
}

export async function initializeSessionResources(resources: SessionResources): Promise<void> {
  await sessionSnapshots.initialize(resources.snapshots);
  // The existing run owns its empty default stream. The first event materializes
  // its contents; readers can wait on that stable address before any write.
}

async function resolveHolder(holderRunId: string): Promise<SessionResources> {
  const scope = await getWorld();
  let cache = caches.get(scope);
  if (cache === undefined) {
    cache = new Map();
    caches.set(scope, cache);
  }
  const cached = cache.get(holderRunId);
  if (cached !== undefined) return cached;
  const pending = readStreamRecord<SessionResources>(descriptorStream(holderRunId)).then(
    (resources) => {
      Object.freeze(resources.events);
      Object.freeze(resources.snapshots);
      Object.freeze(resources.control);
      return Object.freeze(resources);
    },
  );
  cache.set(holderRunId, pending);
  if (cache.size > DESCRIPTOR_CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  try {
    return await pending;
  } catch (error) {
    if (cache.get(holderRunId) === pending) cache.delete(holderRunId);
    throw error;
  }
}

export const sessionDirectory = {
  resolveHolder,
  resolveSession(sessionId: string): Promise<SessionResources> {
    return resolveHolder(sessionId);
  },
};
