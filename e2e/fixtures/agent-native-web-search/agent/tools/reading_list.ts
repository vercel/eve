import { defineTool } from "eve/tools";

export default defineTool({
  description:
    "Read Bob's saved reading list: the topics he has notes on and their notebook pages.",
  inputSchema: { type: "object" as const, properties: {} },
  async execute() {
    return {
      saved: [
        { notebookPage: 14, topic: "Array.prototype.map" },
        { notebookPage: 22, topic: "Array.prototype.flat" },
      ],
    };
  },
});
