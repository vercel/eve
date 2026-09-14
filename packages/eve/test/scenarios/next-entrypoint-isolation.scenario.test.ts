import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const EVE_NEXT_ENTRYPOINT = fileURLToPath(
  new URL("../../dist/src/public/next/index.js", import.meta.url),
);

describe("eve/next entrypoint isolation", () => {
  it("does not install eve's Workflow world resolver in the host process", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      "--input-type=module",
      "--eval",
      [
        `await import(${JSON.stringify(EVE_NEXT_ENTRYPOINT)});`,
        `const getWorld = globalThis[Symbol.for("@workflow/world//getWorldFn")];`,
        `process.stdout.write(typeof getWorld);`,
      ].join("\n"),
    ]);

    expect(stdout).toBe("undefined");
  });

  it("preserves a Workflow world resolver installed by the host", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      "--input-type=module",
      "--eval",
      [
        `const key = Symbol.for("@workflow/world//getWorldFn");`,
        `const hostGetWorld = () => undefined;`,
        `globalThis[key] = hostGetWorld;`,
        `await import(${JSON.stringify(EVE_NEXT_ENTRYPOINT)});`,
        `process.stdout.write(String(globalThis[key] === hostGetWorld));`,
      ].join("\n"),
    ]);

    expect(stdout).toBe("true");
  });
});
