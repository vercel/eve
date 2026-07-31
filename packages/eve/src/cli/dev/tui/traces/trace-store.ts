/**
 * Live reader over the local trace spool for the `/traces` viewer.
 *
 * The spool's segments are immutable — one file per span, written atomically,
 * never rewritten — so reads cache parsed spans by span id and only parse
 * files that appeared since the last poll. Listing stats directories instead
 * of parsing spans, keeping a 1s poll cheap even with a large spool.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { LocalTrace, LocalTraceSpan } from "#harness/local-trace-reader.js";
import { assembleLocalTrace, parseLocalTraceSegment } from "#harness/local-trace-reader.js";
import {
  resolveLocalTraceSchemaDirectory,
  resolveLocalTraceSegmentsDirectory,
} from "#harness/local-trace-span-processor.js";

const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/u;
const SPAN_FILE_PATTERN = /^[0-9a-f]{16}\.otlp\.json$/u;
const MAX_SEGMENT_BYTES = 8 * 1024 * 1024;

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
  const schemaRoot = resolveLocalTraceSchemaDirectory(options.appRoot);
  const caches = new Map<
    string,
    { seen: Set<string>; spans: Map<string, LocalTraceSpan>; assembled?: LocalTrace }
  >();

  return {
    async list() {
      let entries;
      try {
        entries = await readdir(schemaRoot, { withFileTypes: true });
      } catch (error) {
        if (isMissing(error)) return [];
        throw error;
      }
      const traces: TraceStoreEntry[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || !TRACE_ID_PATTERN.test(entry.name)) continue;
        try {
          const segments = await stat(
            resolveLocalTraceSegmentsDirectory(options.appRoot, entry.name),
          );
          traces.push({ traceId: entry.name, lastActivityMs: segments.mtimeMs });
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
      }
      return traces.sort((left, right) =>
        right.lastActivityMs === left.lastActivityMs
          ? left.traceId.localeCompare(right.traceId)
          : right.lastActivityMs - left.lastActivityMs,
      );
    },

    async read(traceId) {
      const segmentsRoot = resolveLocalTraceSegmentsDirectory(options.appRoot, traceId);
      let entries;
      try {
        entries = await readdir(segmentsRoot, { withFileTypes: true });
      } catch (error) {
        if (isMissing(error)) {
          caches.delete(traceId);
          return undefined;
        }
        throw error;
      }

      let cache = caches.get(traceId);
      if (cache === undefined) {
        cache = { seen: new Set(), spans: new Map() };
        caches.set(traceId, cache);
      }
      let changed = false;
      for (const entry of entries) {
        if (!entry.isFile() || !SPAN_FILE_PATTERN.test(entry.name)) continue;
        if (cache.seen.has(entry.name)) continue;
        cache.seen.add(entry.name);
        let content: string;
        try {
          const path = join(segmentsRoot, entry.name);
          if ((await stat(path)).size > MAX_SEGMENT_BYTES) continue;
          content = await readFile(path, "utf8");
        } catch {
          continue;
        }
        for (const span of parseLocalTraceSegment(content, traceId)) {
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

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
