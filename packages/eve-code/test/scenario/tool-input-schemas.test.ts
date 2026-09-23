import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { basename } from "node:path";
import test from "node:test";

import { z } from "zod";

const toolsDir = new URL("../../extension/tools/", import.meta.url);

// Claude rejects the whole model request when any advertised tool's input schema has a root
// union, even if that tool is never called. Every eve-code tool must serialize to an object root.
test("every extension tool advertises an object-root input schema without root unions", async () => {
  const files = (await readdir(toolsDir)).filter(
    (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
  );
  assert.ok(files.length >= 4, `found ${files.join(", ")}`);
  for (const file of files) {
    const tool = (await import(new URL(file, toolsDir).href)).default as { inputSchema: z.ZodType };
    const schema = z.toJSONSchema(tool.inputSchema, { io: "input" });
    assert.equal(schema.type, "object", basename(file));
    for (const keyword of ["oneOf", "anyOf", "allOf"])
      assert.equal(keyword in schema, false, `${basename(file)} has root ${keyword}`);
  }
});
