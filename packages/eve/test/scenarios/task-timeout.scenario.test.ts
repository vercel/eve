import { describe, expect, it } from "vitest";

import { Client } from "../../src/client/client.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { startEveDev } from "./dev-server-harness.js";

const scenarioApp = useScenarioApp();
const SCENARIO_TIMEOUT_MS = 360_000;

describe("per-call timeout", () => {
  it(
    "fails a subagent call with TIMED_OUT once its authored timeout passes on the owner's timer",
    async () => {
      const app = await scenarioApp({
        dependencies: { zod: "^4.3.6" },
        files: {
          "agent/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  model: mockModel(({ toolResults }) => {
    if (toolResults.length === 0) {
      return { toolCalls: [{ name: "researcher", input: { message: "Dig into Alice's report." } }] };
    }
    return "Parent got: " + JSON.stringify(toolResults[0].output);
  }),
  modelContextWindowTokens: 32_000,
});
`,
          "agent/instructions.md": "Delegate research to the researcher.\n",
          "agent/subagents/researcher/agent.ts": `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  description: "Researches reports.",
  model: mockModel(({ toolResults }) =>
    toolResults.length === 0 ? { toolCalls: [{ name: "gather", input: {} }] } : "Gathered.",
  ),
  modelContextWindowTokens: 32_000,
  timeout: 2_000,
});
`,
          "agent/subagents/researcher/instructions.md": "Gather sources, then report.\n",
          "agent/subagents/researcher/tools/gather.ts": `import { defineWorkflowTool } from "eve/tools";
import { sleep } from "workflow";
import { z } from "zod";

export default defineWorkflowTool({
  description: "Gather sources slowly.",
  inputSchema: z.object({}),
  async execute() {
    "use workflow";
    await sleep("60s");
    return "late";
  },
});
`,
        },
        installDependencies: true,
        name: "task-timeout-subagent",
      });
      const server = await startEveDev(app.appRoot, {
        env: { EVE_MOCK_AUTHORED_MODELS: "", NODE_ENV: "production" },
      });
      try {
        const client = new Client({ host: server.url });
        const startedAt = Date.now();
        const { response } = await client.sessions.create({ message: "Research Alice's report." });
        const result = await response.result();

        const settled = result.events.find((event) => event.type === "task.settled");
        expect(settled?.data).toMatchObject({
          error: { code: "TIMED_OUT" },
          status: "failed",
        });
        const researcherResults = result.events.flatMap((event) =>
          event.type === "action.result" &&
          event.data.result.kind === "tool-result" &&
          event.data.result.toolName === "researcher"
            ? [event.data.result]
            : [],
        );
        expect(researcherResults).toHaveLength(1);
        expect(researcherResults[0]).toMatchObject({
          isError: true,
          output: { code: "TIMED_OUT" },
        });
        const reply = result.events.findLast((event) => event.type === "message.completed");
        expect(reply?.data.message).toContain("TIMED_OUT");
        // The child's 60-second tool never finished; the 2-second limit ended the call.
        expect(Date.now() - startedAt).toBeLessThan(55_000);
      } finally {
        await server.stop();
      }
    },
    SCENARIO_TIMEOUT_MS,
  );
});
