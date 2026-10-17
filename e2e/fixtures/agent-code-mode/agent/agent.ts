import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

const python = process.env.EVE_CODE_MODE_LANGUAGE === "py";

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
              source: python
                ? request.lastUserMessage?.includes("CRASH")
                  ? 'before = await count({})\nunknown = None\ntry:\n    await crash({})\nexcept Exception as error:\n    unknown = str(error)\ncounts = await counters({})\n{"before": before, "unknown": unknown, "counts": counts}'
                  : 'before = await count({})\napproved = await gated({})\nafter = await count({})\ncounts = await counters({})\n{"before": before, "approved": approved, "after": after, "counts": counts}'
                : request.lastUserMessage?.includes("CRASH")
                  ? "const before = await tools.count({}); let unknown; try { await tools.crash({}); } catch (error) { unknown = error.message; } return { before, unknown, counts: await tools.counters({}) };"
                  : "const before = await tools.count({}); const approved = await tools.gated({}); const after = await tools.count({}); return { before, approved, after, counts: await tools.counters({}) };",
            },
          },
        ],
      };
    },
  }),
  codeMode: python ? { language: "py" } : true,
  defaultTools: false,
});
