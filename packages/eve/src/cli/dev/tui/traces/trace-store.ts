/**
 * Live reader over the local trace spool for the `/traces` viewer.
 *
 * The spool's segments are immutable — one file per span, written atomically,
 * never rewritten — so reads cache parsed spans by span id and only parse
 * files that appeared since the last poll. Listing stats directories instead
 * of parsing spans, keeping a 1s poll cheap even with a large spool.
 */

import type { LocalTrace, LocalTraceSpan } from "#harness/local-trace-reader.js";
import {
  assembleLocalTrace,
  listLocalTraceIds,
  listLocalTraceSegments,
  readLocalTraceActivityMs,
  readLocalTraceSegment,
} from "#harness/local-trace-reader.js";

export interface TraceStoreEntry {
  readonly traceId: string;
  /** Mtime of the trace's segments directory — the instant it last received a span. */
  readonly lastActivityMs: number;
}

export interface TraceStore {
  /** Lists stored traces, most recent activity first. */
  list(): Promise<readonly TraceStoreEntry[]>;
  /**
   * Reads one trace, parsing only segments not seen by earlier reads.
   * Returns `undefined` when the trace is missing or has no valid spans
   * (e.g. retention pruned it between list and read).
   */
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
