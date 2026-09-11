import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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

  it("creates a private exclusive per-process log and preserves structured append order", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-diagnostics-"));
    roots.push(root);
    const options = {
      now: () => new Date("2026-07-15T12:00:00.000Z"),
      pid: 123,
    };
    const sink = await createDevDiagnosticSink(root, options);

    try {
      // Windows reports POSIX modes differently and relies on ACLs instead.
      if (process.platform !== "win32") {
        expect((await stat(join(root, ".eve", "logs"))).mode & 0o777).toBe(0o700);
        expect((await stat(sink.path)).mode & 0o777).toBe(0o600);
      }
      sink.append({ source: "stderr", detail: "first\nwith a stack line" });
      sink.append({ source: "workflow", summary: "failed", detail: "second" });
      await expect(createDevDiagnosticSink(root, options)).rejects.toMatchObject({
        code: "EEXIST",
      });
    } finally {
      await sink.close();
    }

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
});
