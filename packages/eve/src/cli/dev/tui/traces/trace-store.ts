import type { LocalTrace, LocalTraceSpan } from "#tracing/local/trace-reader.js";
import {
  assembleLocalTrace,
  listLocalTraceIds,
  listLocalTraceSegments,
  readLocalTraceActivityMs,
  readLocalTraceSegment,
} from "#tracing/local/trace-reader.js";

export interface TraceStoreEntry {
  readonly traceId: string;
  readonly lastActivityMs: number;
}

export interface TraceStore {
  list(): Promise<readonly TraceStoreEntry[]>;
  read(traceId: string): Promise<LocalTrace | undefined>;
}

export function createTraceStore(options: { readonly appRoot: string }): TraceStore {
  const caches = new Map<
    string,
    { seen: Set<string>; spans: Map<string, LocalTraceSpan>; assembled?: LocalTrace }
  >();

  return {
    async list() {
      const traces: TraceStoreEntry[] = [];
      for (const traceId of await listLocalTraceIds(options.appRoot)) {
        const lastActivityMs = await readLocalTraceActivityMs(options.appRoot, traceId);
        if (lastActivityMs !== undefined) traces.push({ traceId, lastActivityMs });
      }
      return traces.sort((left, right) =>
        right.lastActivityMs === left.lastActivityMs
          ? left.traceId.localeCompare(right.traceId)
          : right.lastActivityMs - left.lastActivityMs,
      );
    },

    async read(traceId) {
      const fileNames = await listLocalTraceSegments(options.appRoot, traceId);
      if (fileNames === undefined) {
        caches.delete(traceId);
        return undefined;
      }

      let cache = caches.get(traceId);
      if (cache === undefined) {
        cache = { seen: new Set(), spans: new Map() };
        caches.set(traceId, cache);
      }
      let changed = false;
      for (const fileName of fileNames) {
        if (cache.seen.has(fileName)) continue;
        cache.seen.add(fileName);
        for (const span of await readLocalTraceSegment(options.appRoot, traceId, fileName)) {
          if (!cache.spans.has(span.spanId)) {
            cache.spans.set(span.spanId, span);
            changed = true;
          }
        }
      }
      if (cache.spans.size === 0) return undefined;
      if (changed || cache.assembled === undefined) {
        cache.assembled = assembleLocalTrace(traceId, [...cache.spans.values()]);
      }
      return cache.assembled;
    },
  };
}
