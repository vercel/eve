import type { ScenarioAppDescriptor } from "#internal/testing/scenario-app.js";

export const COMPOSED_TOOL_SCHEMAS_DESCRIPTOR: ScenarioAppDescriptor = {
  name: "composed-tool-schemas",
  installDependencies: true,
  dependencies: { zod: "4.5.4" },
  files: {
    "agent/instructions.md": "Echo the input with the dispatch tool.\n",
    "agent/lib/operation.ts": `import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Echo one value",
  inputSchema: z.object({ value: z.string().trim().min(1) }),
  outputSchema: z.object({ value: z.string().min(1) }),
  execute: async (input) => input,
});
`,
    "agent/tools/dispatch.ts": `import { defineTool } from "eve/tools";
import { z } from "zod";
import operation from "../lib/operation.ts";

export default defineTool({
  description: "Dispatch to the echo operation",
  inputSchema: z.discriminatedUnion("action", [
    z.object({
      action: z.literal("echo"),
      input: operation.inputSchema as z.ZodType<{ value: string }>,
    }),
  ]),
  outputSchema: z.object({
    result: operation.outputSchema as z.ZodType<{ value: string }>,
  }),
  execute: async (input) => ({ result: input.input }),
});
`,
    "agent/channels/schema-composition.ts": `import { defineChannel, GET } from "eve/channels";
import { z } from "zod";
import dispatch from "../tools/dispatch.ts";

export default defineChannel({
  routes: [GET("/schema-composition", async () => {
    const input = dispatch.inputSchema as z.ZodType;
    const output = dispatch.outputSchema as z.ZodType;
    const parsed = input.parse({ action: "echo", input: { value: " hello " } });
    return Response.json({
      parsed,
      invalidAccepted: input.safeParse({ action: "echo", input: { value: " " } }).success,
      output: output.parse({ result: { value: "hello" } }),
    });
  })],
});
`,
  },
};
