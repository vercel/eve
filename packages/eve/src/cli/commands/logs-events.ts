import { access } from "node:fs/promises";

import { resolveLocalWorkflowWorldDataDirectory } from "#internal/workflow/local-world-data-directory.js";

const RUNS_PAGE_LIMIT = 100;
/**
 * How long a stream read may sit idle before the reader cancels it. A
 * crashed `eve dev` never closes its run streams, so a live reader on
 * such a stream would otherwise wait forever for the next chunk.
 */
const STREAM_IDLE_TIMEOUT_MS = 1_000;

/**
 * One session event read back from the local workflow store, shaped like a
 * diagnostic-log line so `eve logs --events` output stays one uniform JSONL
 * stream: `at` and `source` first, then the event identity and payload.
 */
export interface DevSessionEventLine {
  readonly at: string;
  readonly source: "event";
  readonly runId: string;
  readonly type: string;
  readonly data?: unknown;
}

/** Time window (inclusive) of events to resolve, in wall-clock event time. */
export interface DevSessionEventWindow {
  readonly from: Date;
  readonly to: Date;
}

/**
 * Reads session events for one diagnostic-log window from the local
 * workflow store (`.eve/.workflow-data`), at query time — nothing is
 * duplicated at capture time.
 *
 * Runs are enumerated through the vendored Workflow World API and each
 * run's default stream is decoded through `Run.getReadable()` — the same
 * vendored read path the dev server uses to serve session streams over
 * HTTP — never by touching the store's private chunk encoding. The world
 * is opened for storage reads only: `start()` is never called, so queue
 * redelivery cannot be triggered by a CLI read, and unclosed streams
 * (crashed processes) are drained with an idle-timeout cancel instead of
 * waiting for chunks that will never arrive.
 *
 * Returns an empty list when the store does not exist. Selection is by
 * time window: events from any `eve dev` process in the window are
 * included, since the store does not attribute runs to processes.
 */
export async function readDevSessionEvents(
  appRoot: string,
  window: DevSessionEventWindow,
): Promise<DevSessionEventLine[]> {
  const dataDir = resolveLocalWorkflowWorldDataDirectory(appRoot);
  try {
    await access(dataDir);
  } catch {
    // No local store yet; do not let createWorld scaffold one as a side
    // effect of a read.
    return [];
  }

  const { createWorld } = await import("#compiled/@workflow/world-local/index.js");
  const runtime = await import("#internal/workflow/runtime.js");
  const world = createWorld({ dataDir });
  // `getRun` resolves its world through the runtime's process-global slot.
  // A one-shot CLI owns that slot; restore nothing afterwards.
  runtime.setWorld(world);

  const lines: DevSessionEventLine[] = [];
  for (const run of await listRunsOverlappingWindow(world, window)) {
    const text = await drainRunStream(runtime, world, run.runId);
    lines.push(...parseSessionEventLines(text, run, window));
  }
  return lines.sort((a, b) => a.at.localeCompare(b.at));
}

interface RunSummary {
  readonly runId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

type LocalWorld = ReturnType<
  (typeof import("#compiled/@workflow/world-local/index.js"))["createWorld"]
>;
type WorkflowRuntime = typeof import("#internal/workflow/runtime.js");

async function listRunsOverlappingWindow(
  world: LocalWorld,
  window: DevSessionEventWindow,
): Promise<RunSummary[]> {
  const overlapping: RunSummary[] = [];
  let cursor: string | undefined;
  do {
    const page = await world.runs.list({
      resolveData: "none",
      pagination:
        cursor === undefined ? { limit: RUNS_PAGE_LIMIT } : { cursor, limit: RUNS_PAGE_LIMIT },
    });
    for (const run of page.data) {
      if (run.createdAt <= window.to && run.updatedAt >= window.from) {
        overlapping.push({ runId: run.runId, createdAt: run.createdAt, updatedAt: run.updatedAt });
      }
    }
    cursor = page.hasMore && page.cursor !== null ? page.cursor : undefined;
  } while (cursor !== undefined);
  return overlapping;
}

/**
 * Reads a run's decoded session stream until it closes or sits idle for
 * {@link STREAM_IDLE_TIMEOUT_MS}. Runs without a session stream (non-turn
 * workflows — roughly half of a typical store) are skipped via a cheap
 * `listStreams` lookup instead of each paying the full idle-timeout
 * budget waiting on a stream that does not exist.
 */
async function drainRunStream(
  runtime: WorkflowRuntime,
  world: LocalWorld,
  runId: string,
): Promise<string> {
  let text = "";
  const decoder = new TextDecoder();
  try {
    const streams = await runtime.listStreams(world, runId);
    if (!streams.some((name) => name === "user" || name.endsWith("_user"))) return "";
    const reader = runtime
      .getRun(runId)
      .getReadable<string | Uint8Array>({ startIndex: 0 })
      .getReader();
    for (;;) {
      const winner = await Promise.race([
        reader.read(),
        new Promise<"idle">((resolve) => {
          setTimeout(() => resolve("idle"), STREAM_IDLE_TIMEOUT_MS);
        }),
      ]);
      if (winner === "idle") {
        await reader.cancel();
        break;
      }
      if (winner.done) break;
      text +=
        typeof winner.value === "string"
          ? winner.value
          : decoder.decode(winner.value, { stream: true });
    }
  } catch {
    return "";
  }
  return text;
}

function parseSessionEventLines(
  text: string,
  run: RunSummary,
  window: DevSessionEventWindow,
): DevSessionEventLine[] {
  const lines: DevSessionEventLine[] = [];
  for (const raw of text.split("\n")) {
    const event = parseSessionEvent(raw);
    if (event === undefined) continue;
    const at = event.at ?? run.createdAt.toISOString();
    if (at < window.from.toISOString() || at > window.to.toISOString()) continue;
    const line: { -readonly [Key in keyof DevSessionEventLine]: DevSessionEventLine[Key] } = {
      at,
      source: "event",
      runId: run.runId,
      type: event.type,
    };
    if (event.data !== undefined) line.data = event.data;
    lines.push(line);
  }
  return lines;
}

function parseSessionEvent(raw: string): { type: string; at?: string; data?: unknown } | undefined {
  if (raw.trim().length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return undefined;
    const { type, data, meta } = parsed as { type?: unknown; data?: unknown; meta?: unknown };
    if (typeof type !== "string") return undefined;
    const at =
      meta !== null && typeof meta === "object" && typeof (meta as { at?: unknown }).at === "string"
        ? (meta as { at: string }).at
        : undefined;
    const event: { type: string; at?: string; data?: unknown } = { type };
    if (at !== undefined) event.at = at;
    if (data !== undefined) event.data = data;
    return event;
  } catch {
    return undefined;
  }
}
