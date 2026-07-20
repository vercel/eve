import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createDevDiagnosticSink } from "./diagnostic-sink.js";

describe("createDevDiagnosticSink", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      roots.map((root) =>
        rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
      ),
    );
    roots.length = 0;
  });

  it("creates a private per-process log and preserves append order", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-diagnostics-"));
    roots.push(root);
    const sink = await createDevDiagnosticSink(root, {
      now: () => new Date("2026-07-15T12:00:00.000Z"),
      pid: 123,
    });

    sink.append({ source: "stderr", detail: "first\nwith a stack line" });
    sink.append({ source: "workflow", summary: "failed", detail: "second" });
    await sink.close();

    expect(sink.displayPath).toBe(".eve/logs/dev-2026-07-15T12-00-00.000Z-123.log");
    const content = await readFile(sink.path, "utf8");
    expect(content.indexOf("first")).toBeLessThan(content.indexOf("second"));

    // JSON Lines: one JSON object per line, `at` and `source` first.
    const lines = content.trimEnd().split("\n");
    expect(lines.map((line) => JSON.parse(line) as unknown)).toEqual([
      {
        at: "2026-07-15T12:00:00.000Z",
        source: "stderr",
        detail: "first\nwith a stack line",
      },
      {
        at: "2026-07-15T12:00:00.000Z",
        source: "workflow",
        summary: "failed",
        detail: "second",
      },
    ]);
    expect(lines[0]!.startsWith('{"at":"2026-07-15T12:00:00.000Z","source":"stderr"')).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "restricts the log directory and file to the owner",
    async () => {
      // POSIX permission bits only: Windows reports 0o666 regardless of the
      // modes passed to mkdir/open, and relies on ACLs instead.
      const root = await mkdtemp(join(tmpdir(), "eve-diagnostics-"));
      roots.push(root);
      const sink = await createDevDiagnosticSink(root, {
        now: () => new Date("2026-07-15T12:00:00.000Z"),
        pid: 123,
      });
      await sink.close();

      expect((await stat(join(root, ".eve", "logs"))).mode & 0o777).toBe(0o700);
      expect((await stat(sink.path)).mode & 0o777).toBe(0o600);
    },
  );

  it("uses exclusive creation for deterministic name collisions", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-diagnostics-"));
    roots.push(root);
    await mkdir(join(root, ".eve"), { recursive: true });
    const options = {
      now: () => new Date("2026-07-15T12:00:00.000Z"),
      pid: 123,
    };
    const first = await createDevDiagnosticSink(root, options);

    await expect(createDevDiagnosticSink(root, options)).rejects.toMatchObject({ code: "EEXIST" });
    await first.close();
  });
});
