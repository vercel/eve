import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { basename } from "node:path";
import test from "node:test";

import { z } from "zod";

import extension from "../../extension/extension.ts";

const toolsDir = new URL("../../extension/tools/", import.meta.url);

// Claude rejects the whole model request when any advertised tool's input schema has a root
// union, even if that tool is never called. Every eve-code tool must serialize to an object root.
// Dynamic tools are resolved with every optional capability configured so none is skipped.
test("every extension tool advertises an object-root input schema without root unions", async () => {
  const files = (await readdir(toolsDir)).filter(
    (file) => file.endsWith(".ts") && !file.endsWith(".test.ts"),
  );
  assert.ok(files.length >= 3, `found ${files.join(", ")}`);
  extension({ github: { connector: "github/acme-bot", org: "acme", broker: async () => {} } });
  for (const file of files) {
    const tool = await resolveTool((await import(new URL(file, toolsDir).href)).default);
    const schema = z.toJSONSchema(tool.inputSchema, { io: "input" });
    assert.equal(schema.type, "object", basename(file));
    for (const keyword of ["oneOf", "anyOf", "allOf"])
      assert.equal(keyword in schema, false, `${basename(file)} has root ${keyword}`);
  }
});

type ToolModule =
  | { readonly inputSchema: z.ZodType }
  | { readonly events: { readonly "session.started"?: (...args: never[]) => unknown } };

async function resolveTool(definition: ToolModule): Promise<{ inputSchema: z.ZodType }> {
  if ("inputSchema" in definition) return definition;
  const handler = definition.events["session.started"] as (() => unknown) | undefined;
  assert.ok(handler, "dynamic tool must resolve at session.started");
  const tool = (await handler()) as { inputSchema: z.ZodType } | null;
  assert.ok(tool, "dynamic tool resolved to null with every capability configured");
  return tool;
}
