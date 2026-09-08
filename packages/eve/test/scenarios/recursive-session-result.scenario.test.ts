import { describe, expect, it } from "vitest";

import { Client } from "../../src/client/client.js";
import { useScenarioApp } from "../../src/internal/testing/scenario-app.js";
import { startEveDev } from "./dev-server-harness.js";

const scenarioApp = useScenarioApp();

describe("eve client inside an authored tool", () => {
  it("returns a structured child result from a recursive HTTP session", async () => {
    const app = await scenarioApp({
      name: "recursive-session-result",
      installDependencies: true,
      files: {
        "agent/agent.ts":
          'export default { model: "openai/gpt-5.4-mini", experimental: { instrumentationProviders: true } };\n',
        "agent/instrumentation/otel.ts":
          'import { otel } from "eve/instrumentation/otel";\nexport default otel({ instrumentations: ["fetch"] });\n',
        "agent/instructions.md": "Call the requested tool, or answer directly.\n",
        "agent/tools/call_child.ts": `import { Client } from "eve/client";
import { defineTool } from "eve/tools";

export default defineTool({
  description: "Call another session through the eve client.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  async execute() {
    const host = process.env.WORKFLOW_LOCAL_BASE_URL;
    if (!host) throw new Error("The fixture's own server URL is unavailable.");
    const client = new Client({ host });
    const signal = AbortSignal.timeout(20_000);
    const { response } = await client.sessions.create({
      message: "Return a structured answer.",
      outputSchema: {
        type: "object",
        properties: { answer: { type: "string", const: "child-result" } },
        required: ["answer"],
        additionalProperties: false,
      },
      signal,
    });
    const result = await response.result();
    signal.throwIfAborted();
    return { data: result.data, status: result.status };
  },
});
`,
      },
    });
    const server = await startEveDev(app.appRoot);
    try {
      const client = new Client({ host: server.url });
      const { response } = await client.sessions.create({
        message: "Call call_child.",
        signal: AbortSignal.timeout(40_000),
      });
      const result = await response.result();
      expect(result.message).toContain("child-result");
      expect(result.status).toBe("waiting");
    } catch (error) {
      throw new Error(`${String(error)}\n${server.stdout()}\n${server.stderr()}`, { cause: error });
    } finally {
      await server.stop();
    }
  });
});
