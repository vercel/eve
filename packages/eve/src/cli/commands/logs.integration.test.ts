import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  listDevDiagnosticLogs,
  resolveDevDiagnosticLog,
  runLogsListCommand,
  runLogsShowCommand,
} from "./logs.js";

const FIRST = "dev-2026-07-14T09-30-00.000Z-100.log";
const SECOND = "dev-2026-07-15T12-00-00.000Z-123.log";

function collectingLogger() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    logger: {
      log: (message: string) => out.push(message),
      error: (message: string) => err.push(message),
    },
  };
}

describe("eve logs", () => {
  const roots: string[] = [];

  async function appRootWithLogs(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "eve-logs-cmd-"));
    roots.push(root);
    const directory = join(root, ".eve", "logs");
    await mkdir(directory, { recursive: true });
    await Promise.all(
      Object.entries(files).map(([name, content]) => writeFile(join(directory, name), content)),
    );
    return root;
  }

  afterEach(async () => {
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });

  it("lists logs most recent first with parsed start times", async () => {
    const root = await appRootWithLogs({
      [FIRST]: "older\n",
      [SECOND]: "newer\n",
      "not-a-log.txt": "ignored",
    });

    const logs = await listDevDiagnosticLogs(root);

    expect(logs.map((log) => log.id)).toEqual([
      "dev-2026-07-15T12-00-00.000Z-123",
      "dev-2026-07-14T09-30-00.000Z-100",
    ]);
    expect(logs[0]!.startedAt?.toISOString()).toBe("2026-07-15T12:00:00.000Z");
    expect(logs[0]!.sizeBytes).toBe(6);
  });

  it("returns an empty list when the log directory does not exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-logs-cmd-"));
    roots.push(root);
    expect(await listDevDiagnosticLogs(root)).toEqual([]);
  });

  it("resolves ids, file names, transcript paths, and unambiguous prefixes", async () => {
    const root = await appRootWithLogs({ [FIRST]: "a", [SECOND]: "b" });
    const logs = await listDevDiagnosticLogs(root);

    for (const reference of [
      "dev-2026-07-15T12-00-00.000Z-123",
      SECOND,
      `.eve/logs/${SECOND}`,
      "2026-07-15",
      "dev-2026-07-15",
    ]) {
      expect(resolveDevDiagnosticLog(logs, reference).id).toBe("dev-2026-07-15T12-00-00.000Z-123");
    }

    expect(() => resolveDevDiagnosticLog(logs, "2026-07")).toThrow(/matches 2 diagnostic logs/);
    expect(() => resolveDevDiagnosticLog(logs, "2030")).toThrow(/No diagnostic log matches/);
  });

  it("shows the most recent log by default and named logs by reference", async () => {
    const root = await appRootWithLogs({ [FIRST]: "older content\n", [SECOND]: "newer content\n" });

    const mru = collectingLogger();
    await runLogsShowCommand(mru.logger, root);
    expect(mru.out).toEqual(["newer content"]);
    // Output carries records only: nothing on stderr, so `2>&1 | jq` parses.
    expect(mru.err).toEqual([]);

    const named = collectingLogger();
    await runLogsShowCommand(named.logger, root, "2026-07-14");
    expect(named.out).toEqual(["older content"]);
  });

  it("prepends the environment dump with --dump and falls back when it is absent", async () => {
    const dump = '{\n  "updatedAt": "2026-07-15T12:00:05.000Z",\n  "environment": null\n}\n';
    const root = await appRootWithLogs({
      [FIRST]: "older content\n",
      [SECOND]: '{"at":"2026-07-15T12:00:01.000Z","source":"stderr","detail":"newer content"}\n',
      [SECOND.replace(/\.log$/, ".dump")]: dump,
    });

    const withDump = collectingLogger();
    await runLogsShowCommand(withDump.logger, root, undefined, { dump: true });
    expect(withDump.out).toEqual([
      `${dump.trimEnd()}\n{"at":"2026-07-15T12:00:01.000Z","source":"stderr","detail":"newer content"}`,
    ]);
    expect(withDump.err).toEqual([]);

    const missingDump = collectingLogger();
    await runLogsShowCommand(missingDump.logger, root, "2026-07-14", { dump: true });
    expect(missingDump.out).toEqual(["older content"]);
    expect(missingDump.err).toEqual([]);
  });

  it("interleaves session events by timestamp with --events and stays silent when none match", async () => {
    const logLine = (at: string, detail: string) =>
      `${JSON.stringify({ at, source: "stderr", detail })}\n`;
    const root = await appRootWithLogs({
      [FIRST]: logLine("2026-07-14T09:31:00.000Z", "older"),
      [SECOND]:
        logLine("2026-07-15T12:00:10.000Z", "early") + logLine("2026-07-15T12:00:30.000Z", "late"),
    });

    const readEvents = vi.fn().mockResolvedValue([
      {
        at: "2026-07-15T12:00:20.000Z",
        source: "event",
        runId: "wrun_1",
        type: "turn.started",
      },
    ]);
    const withEvents = collectingLogger();
    await runLogsShowCommand(withEvents.logger, root, undefined, {
      events: true,
      readEvents,
      now: () => new Date("2026-07-15T13:00:00.000Z"),
    });

    // Window: this log's encoded start through `now` (it is the newest log).
    expect(readEvents).toHaveBeenCalledWith(root, {
      from: new Date("2026-07-15T12:00:00.000Z"),
      to: new Date("2026-07-15T13:00:00.000Z"),
    });
    const lines = withEvents.out.join("\n").split("\n");
    expect(lines.map((line) => (JSON.parse(line) as { at: string }).at)).toEqual([
      "2026-07-15T12:00:10.000Z",
      "2026-07-15T12:00:20.000Z",
      "2026-07-15T12:00:30.000Z",
    ]);
    expect(withEvents.err).toEqual([]);

    // Older log: window ends at the next log's start; zero events stay silent.
    const older = collectingLogger();
    const readNone = vi.fn().mockResolvedValue([]);
    await runLogsShowCommand(older.logger, root, "2026-07-14", {
      events: true,
      readEvents: readNone,
    });
    expect(readNone).toHaveBeenCalledWith(root, {
      from: new Date("2026-07-14T09:30:00.000Z"),
      to: new Date("2026-07-15T12:00:00.000Z"),
    });
    expect(older.err).toEqual([]);
  });

  it("reports missing logs without failing, but fails for an explicit reference", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-logs-cmd-"));
    roots.push(root);

    const bare = collectingLogger();
    await runLogsShowCommand(bare.logger, root);
    expect(bare.out).toEqual(["No dev diagnostic logs found under .eve/logs."]);

    await expect(runLogsShowCommand(collectingLogger().logger, root, "2026")).rejects.toThrow(
      /No dev diagnostic logs found/,
    );
  });

  it("emits machine-readable rows for ls --json", async () => {
    const root = await appRootWithLogs({ [SECOND]: "content" });

    const { logger, out } = collectingLogger();
    await runLogsListCommand(logger, root, { json: true });

    expect(JSON.parse(out.join("\n"))).toEqual([
      {
        id: "dev-2026-07-15T12-00-00.000Z-123",
        path: join(root, ".eve", "logs", SECOND),
        startedAt: "2026-07-15T12:00:00.000Z",
        sizeBytes: 7,
      },
    ]);
  });
});
