import { defineTool } from "#public/tools/index.js";

export default defineTool({
  description: "Return the word count of a document.",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  execute: async (input) => ({ words: String(input.text).split(/\s+/u).length }),
});
