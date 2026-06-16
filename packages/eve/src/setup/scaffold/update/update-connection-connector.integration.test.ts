import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { updateConnectionConnectorUid } from "./update-connection-connector.js";

async function writeTemp(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "eve-conn-"));
  const path = join(dir, "linear.ts");
  await writeFile(path, contents, "utf8");
  return path;
}

describe("updateConnectionConnectorUid", () => {
  test("rewrites the connector UID literal in a connect() call", async () => {
    const path = await writeTemp(
      [
        'import { connect } from "@vercel/connect/eve";',
        "export default defineMcpClientConnection({",
        '  auth: connect("linear"),',
        "});",
        "",
      ].join("\n"),
    );

    const result = await updateConnectionConnectorUid(path, "oauth/linear-123");

    expect(result.patched).toBe(true);
    const updated = await readFile(path, "utf8");
    expect(updated).toContain('connect("oauth/linear-123")');
    // The import line is left untouched.
    expect(updated).toContain('import { connect } from "@vercel/connect/eve";');
  });

  test("returns patched: false when there is no connect() call", async () => {
    const path = await writeTemp("export default defineMcpClientConnection({});\n");
    expect((await updateConnectionConnectorUid(path, "oauth/x")).patched).toBe(false);
  });

  test("returns patched: false when the file is missing", async () => {
    const result = await updateConnectionConnectorUid("/no/such/file.ts", "oauth/x");
    expect(result.patched).toBe(false);
  });
});
