import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const run = promisify(execFile);

describe("package module path", () => {
  // `node -e` defines a global `__filename` of "[eval]", which ESM modules can see.
  it("loads eve/next under node -e", async () => {
    const entry = new URL("../../../dist/src/public/next/index.js", import.meta.url).href;
    const { stdout } = await run(process.execPath, [
      "-e",
      `import(${JSON.stringify(entry)}).then((next) => console.log(typeof next.withEve))`,
    ]);

    expect(stdout.trim()).toBe("function");
  });
});
