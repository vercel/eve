import { expect, it } from "vitest";
import { Client } from "../../src/client/client.js";
import { TASK_WAIT_TOOL_NAME } from "../../src/protocol/task-tools.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { startEveDev } from "./dev-server-harness.js";

const scenarioApp = useScenarioApp();

it.each(["ordinary", "workflow"] as const)(
  "routes a nested child's %s tool to its full stub path through compiled HTTP",
  async (kind) => {
    const lookup = `import { ${kind === "workflow" ? "defineWorkflowTool" : "defineTool"} } from "eve/tools";
export default ${kind === "workflow" ? "defineWorkflowTool" : "defineTool"}({
  description: "Look up Alice's assigned tasks.",
  inputSchema: { type: "object", properties: {} },
  async execute() {
    ${kind === "workflow" ? '"use workflow";' : ""}
    throw new Error("The nested lookup must be stubbed.");
  },
});`;
    const app = await scenarioApp({
      name: `nested-${kind}-tool-stubs`,
      installDependencies: true,
      files: {
        "agent/instructions.md": "Help Alice look up assigned tasks.\n",
        "agent/subagents/researcher/instructions.md": "Delegate task lookup to your assistant.\n",
        "agent/subagents/researcher/subagents/assistant/instructions.md":
          "Look up Alice's tasks.\n",
        "agent/agent.ts": delegatingAgent("researcher"),
        "agent/tools/lookup.ts": lookup,
        "agent/subagents/remote.ts": `import { defineRemoteAgent } from "eve";
export default defineRemoteAgent({ url: "https://remote.invalid", description: "Remote tasks." });`,
        "agent/subagents/researcher/agent.ts": delegatingAgent("assistant"),
        "agent/subagents/researcher/tools/lookup.ts": lookup,
        "agent/subagents/researcher/subagents/assistant/agent.ts": delegatingAgent("lookup"),
        "agent/subagents/researcher/subagents/assistant/tools/lookup.ts": lookup,
        "agent/channels/eve.ts": `import { httpBasic } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
const authenticate = httpBasic({ username: "alice", password: "fixture" });
export default eveChannel({
  auth: async request => {
    const auth = await authenticate(request);
    return auth ? { ...auth, allowToolStubs: true } : null;
  },
});`,
      },
    });
    const server = await startEveDev(app.appRoot, {
      env: { EVE_MOCK_AUTHORED_MODELS: "", NODE_ENV: "production" },
    });
    try {
      const client = new Client({
        host: server.url,
        auth: { basic: { username: "alice", password: "fixture" } },
      });
      for (const tool of ["assistant/lookup", "researcher/lookpu", "remote/lookup"]) {
        await expect(
          client.sessions.create({
            stubs: [{ id: "invalid", tool, outcome: { response: "INVALID" } }],
          }),
        ).rejects.toThrow(tool);
      }
      const { session } = await client.sessions.create({
        stubs: [
          { id: "root", tool: "lookup", outcome: { response: "ROOT" } },
          { id: "remote", tool: "remote", outcome: { response: "REMOTE" } },
          { id: "child", tool: "researcher/lookup", outcome: { response: "CHILD" } },
          {
            id: "grandchild",
            tool: "researcher/assistant/lookup",
            outcome: { response: "GRANDCHILD" },
          },
        ],
      });
      const result = await (await session.send("Look up Alice's assigned tasks.")).result();
      expect(
        result.events.flatMap((event) => (event.type === "task.settled" ? [event.data] : [])),
      ).toContainEqual(
        expect.objectContaining({ name: "researcher", status: "completed", output: "GRANDCHILD" }),
      );
      expect(result.events.filter((event) => event.type === "turn.failed")).toEqual([]);
    } finally {
      await server.stop();
    }
  },
  360_000,
);

/** The mock models choose tools; eve creates the child sessions and runs their tools. */
function delegatingAgent(tool: "researcher" | "assistant" | "lookup"): string {
  return `import { defineAgent } from "eve";
import { mockModel } from "eve/evals";
export default defineAgent({
  description: "Help Alice look up assigned tasks.",
  modelContextWindowTokens: 32000,
  model: mockModel(request => {
    const completed = request.messages.find(message => message.role === "user" && message.text.startsWith("<task_result"));
    if (completed) return completed.text.slice(completed.text.indexOf(">") + 1, completed.text.lastIndexOf("</task_result>"));
    const result = request.toolResults.find(result => result.name === ${JSON.stringify(tool)});
    if (result && ${tool !== "lookup"}) return { toolCalls: [{ name: ${JSON.stringify(TASK_WAIT_TOOL_NAME)}, input: {} }] };
    if (result) return typeof result.output === "string" ? result.output : JSON.stringify(result.output);
    return { toolCalls: [{ name: ${JSON.stringify(tool)}, input: ${
      tool === "lookup" ? "{}" : '{ message: "Look up Alice\'s assigned tasks." }'
    } }] };
  }),
});`;
}
