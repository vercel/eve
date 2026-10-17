import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

export default defineAgent({
  ...e2eAgentConfig({
    mock: (request) => {
      const result = request.toolResults.find((result) => result.name === "eve__execute");
      if (result !== undefined) return JSON.stringify(result.output);
      return {
        toolCalls: [
          {
            name: "eve__execute",
            input: {
              source: request.lastUserMessage?.includes("CRASH")
                ? "const before = await tools.count({}); let unknown; try { await tools.crash({}); } catch (error) { unknown = error.message; } return { before, unknown, counts: await tools.counters({}) };"
                : "const before = await tools.count({}); const approved = await tools.gated({}); const after = await tools.count({}); return { before, approved, after, counts: await tools.counters({}) };",
            },
          },
        ],
      };
    },
  }),
  codeMode: true,
  defaultTools: false,
});
