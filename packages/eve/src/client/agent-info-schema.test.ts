import { describe, expect, it } from "vitest";

import { AgentInfoResultSchema } from "#client/agent-info-schema.js";

const INFO_PAYLOAD = {
  agent: {
    agentRoot: "/app/agent",
    appRoot: "/app",
    model: {
      id: "openai/gpt-5.5",
      routing: { kind: "gateway", target: "openai" },
      endpoint: { kind: "gateway", connected: true, credential: "api-key" },
    },
    name: "app",
  },
  capabilities: { devRoutes: true },
  channels: { authored: [], available: [], disabledFramework: [], framework: [] },
  connections: [],
  diagnostics: { discoveryErrors: 0, discoveryWarnings: 0 },
  hooks: [],
  instructions: { dynamic: [], static: null },
  kind: "eve-agent-info",
  mode: "development",
  sandbox: null,
  schedules: [],
  skills: { dynamic: [], static: [] },
  subagents: { local: [], total: 0 },
  tools: {
    authored: [],
    available: [],
    disabledFramework: [],
    dynamic: [],
    framework: [],
    reserved: [],
  },
  version: 1,
  workflow: { enabled: false, toolName: "workflow" },
  workspace: { resourceRoot: {}, rootEntries: [] },
};

describe("AgentInfoResultSchema", () => {
  it("strips unknown keys a newer server adds to routing and endpoint", () => {
    // Forward compatibility: an older client must keep parsing /eve/v1/info
    // when a newer server grows these shapes (as the codex fields did).
    const payload = structuredClone(INFO_PAYLOAD);
    Object.assign(payload.agent.model.routing, { futureRoutingFact: "x" });
    Object.assign(payload.agent.model.endpoint, { futureCredentialDetail: "y" });

    const result = AgentInfoResultSchema.safeParse(payload);

    expect(result.success).toBe(true);
    expect(result.data?.agent.model.routing).toEqual({ kind: "gateway", target: "openai" });
    expect(result.data?.agent.model.endpoint).toEqual({
      kind: "gateway",
      connected: true,
      credential: "api-key",
    });
  });
});
