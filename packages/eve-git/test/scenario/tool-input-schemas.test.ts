import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { basename } from "node:path";
import test from "node:test";

import { z } from "zod";

import extension from "../../extension/extension.ts";

const toolsDir = new URL("../../extension/tools/", import.meta.url);

// Claude rejects the whole model request when any advertised tool's input schema has a root
// union, even if that tool is never called. Every eve-git tool must serialize to an object root.
// Dynamic tools are resolved with every optional capability configured so none is skipped.
test("every extension tool advertises an object-root input schema without root unions", async () => {
  const files = (await readdir(toolsDir)).filter(
    (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
  );
  assert.ok(files.length >= 1, `found ${files.join(", ")}`);
  extension({
    github: { connector: "github/acme-bot", authorize: () => true, broker: async () => {} },
  });
  for (const file of files) {
    const tool = await resolveTool((await import(new URL(file, toolsDir).href)).default);
    const schema = z.toJSONSchema(tool.inputSchema, { io: "input" });
    assert.equal(schema.type, "object", basename(file));
    for (const keyword of ["oneOf", "anyOf", "allOf"])
      assert.equal(keyword in schema, false, `${basename(file)} has root ${keyword}`);
  }
});

// A defineDynamic() value is opaque; eve keeps its function under this cross-instance brand.
const DYNAMIC_SENTINEL = Symbol.for("eve.dynamic");

type ToolModule =
  | { readonly inputSchema: z.ZodType }
  | { readonly [DYNAMIC_SENTINEL]: (ctx: never) => unknown };

async function resolveTool(definition: ToolModule): Promise<{ inputSchema: z.ZodType }> {
  if ("inputSchema" in definition) return definition;
  const tool = (await definition[DYNAMIC_SENTINEL]({} as never)) as {
    inputSchema: z.ZodType;
  } | null;
  assert.ok(tool, "dynamic tool resolved to null with every capability configured");
  return tool;
}
