import { defineTool, type ToolDefinition } from "#public/tools/index.js";

interface NormalizeInput {
  readonly value: string;
}

interface NormalizeOutput {
  readonly normalized: string;
}

const normalize: ToolDefinition<NormalizeInput, NormalizeOutput> = defineTool<
  NormalizeInput,
  NormalizeOutput
>({
  description: "Normalize authored text.",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
  },
  async execute(input) {
    return { normalized: input.value.trim() };
  },
});

export default normalize;
