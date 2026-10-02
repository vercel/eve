import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parseConsoleRecord } from "./console-records.js";

const execute = promisify(execFile);

describe("dev console severity preload", () => {
  it("captures complete warnings from the child and inherited worker preloads", async () => {
    const preload = new URL("../../../dist/src/cli/dev/console-records-preload.js", import.meta.url)
      .href;
    const { stderr } = await execute(process.execPath, [
      "--import",
      preload,
      "--input-type=module",
      "-e",
      `
      import { Worker } from 'node:worker_threads';
      console.warn('parent warning\\n  step abc');
      console.error('parent error');
      process.stderr.write('raw stderr\\n');
      const worker = new Worker(new URL('data:text/javascript,console.warn("worker warning");console.error("worker error")'), { type: 'module' });
      await new Promise((resolve, reject) => { worker.once('exit', resolve); worker.once('error', reject); });
    `,
    ]);
    const lines = stderr.trim().split("\n");
    const records = lines.map(parseConsoleRecord).filter((record) => record !== undefined);
    expect(records).toEqual(
      expect.arrayContaining([
        { level: "warn", text: "parent warning\n  step abc" },
        { level: "error", text: "parent error" },
        { level: "warn", text: "worker warning" },
        { level: "error", text: "worker error" },
      ]),
    );
    expect(lines).toContain("raw stderr");
  });
});
