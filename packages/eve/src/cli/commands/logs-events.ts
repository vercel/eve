import { createLogger } from "#internal/logging.js";
import { resolveLocalWorkflowWorldDataDirectory } from "#internal/workflow/local-world-data-directory.js";
import { isStoredLine } from "#protocol/session-events/envelope.js";

const RUNS_PAGE_LIMIT = 100;
const STREAM_IDLE_TIMEOUT_MS = 1_000;

const log = createLogger("cli.logs");

export interface DevSessionEventLine {
  readonly at: string;
  readonly source: "event";
  readonly runId: string;
  readonly type: string;
  readonly data?: unknown;
}

export interface DevSessionEventWindow {
  readonly from: Date;
  readonly to: Date;
}

export async function readDevSessionEvents(
  appRoot: string,
  window: DevSessionEventWindow,
): Promise<DevSessionEventLine[]> {
  const { createWorld } = await import("#compiled/@workflow/world-local/index.js");
  const runtime = await import("#internal/workflow/runtime.js");
  const world = createWorld({
    dataDir: resolveLocalWorkflowWorldDataDirectory(appRoot),
    queueAuthKey: "read",
  });
  runtime.setWorld(world);

  const lines: DevSessionEventLine[] = [];
  try {
    for (const run of await listRunsOverlappingWindow(world, window)) {
      const text = await drainRunStream(runtime, world, run.runId);
      const runLines = parseSessionEventLines(text, run, window);
      if (runLines === undefined) {
        log.warn(
          `Skipped run ${run.runId} in the local workflow store: it was recorded by eve < 27, ` +
            "whose session events this version cannot read. Inspect this run with the eve " +
            "version that recorded it.",
          { runId: run.runId },
        );
        continue;
      }
      lines.push(...runLines);
    }
  } finally {
    await world.close?.();
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
): DevSessionEventLine[] | undefined {
  const lines: DevSessionEventLine[] = [];
  let lastAt = run.createdAt.toISOString();
  for (const raw of text.split("\n")) {
    const parsed = parseJsonLine(raw);
    if (isPreV27Line(parsed)) return undefined;
    if (!isStoredLine(parsed)) continue;
    if ("facts" in parsed) lastAt = parsed.at;
    const records: readonly unknown[] = "facts" in parsed ? parsed.facts : [parsed.progress];
    for (const value of records) {
      const record = readRecord(value);
      if (record === undefined) continue;
      if (lastAt < window.from.toISOString() || lastAt > window.to.toISOString()) continue;
      const line: { -readonly [Key in keyof DevSessionEventLine]: DevSessionEventLine[Key] } = {
        at: lastAt,
        source: "event",
        runId: run.runId,
        type: record.type,
      };
      if (record.data !== undefined) line.data = record.data;
      lines.push(line);
    }
  }
  return lines;
}

function parseJsonLine(raw: string): unknown {
  if (raw.trim().length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isPreV27Line(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const { meta, type } = value as { meta?: unknown; type?: unknown };
  return typeof type === "string" && meta !== null && typeof meta === "object";
}

function readRecord(value: unknown): { type: string; data?: unknown } | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const { type, data } = value as { type?: unknown; data?: unknown };
  return typeof type === "string" ? { data, type } : undefined;
}
