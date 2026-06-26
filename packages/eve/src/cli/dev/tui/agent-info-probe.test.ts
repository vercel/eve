import { describe, expect, it, vi } from "vitest";

import {
  AgentInfoResponseError,
  ClientError,
  type AgentInfoResult,
  type Client,
} from "#client/index.js";

import { probeAgentInfo } from "./agent-info-probe.js";

const AGENT_INFO = {
  agent: {
    agentRoot: "/tmp/weather-agent/agent",
    appRoot: "/tmp/weather-agent",
    model: { id: "gpt-5" },
    name: "Weather Agent",
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
  workflow: { enabled: false, toolName: "Workflow" },
  workspace: { resourceRoot: null, rootEntries: [] },
} satisfies AgentInfoResult;

async function advanceRetry(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(100);
}

describe("probeAgentInfo", () => {
  it("retries a transient server failure and returns inspection once the server is ready", async () => {
    vi.useFakeTimers();
    try {
      const info = vi
        .fn<() => Promise<AgentInfoResult>>()
        .mockRejectedValueOnce(new ClientError(500, "Runner did not become ready in time"))
        .mockResolvedValueOnce(AGENT_INFO);
      const client = { info } satisfies Pick<Client, "info">;

      const probe = probeAgentInfo({ client });
      await advanceRetry();

      await expect(probe).resolves.toEqual({ kind: "ready", info: AGENT_INFO });
      expect(info).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries a network failure", async () => {
    vi.useFakeTimers();
    try {
      const info = vi
        .fn<() => Promise<AgentInfoResult>>()
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce(AGENT_INFO);
      const client = { info } satisfies Pick<Client, "info">;

      const probe = probeAgentInfo({ client });
      await advanceRetry();

      await expect(probe).resolves.toEqual({ kind: "ready", info: AGENT_INFO });
      expect(info).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops after one retry", async () => {
    vi.useFakeTimers();
    try {
      const firstFailure = new ClientError(500, "Runner did not become ready in time");
      const secondFailure = new ClientError(500, "Still unavailable");
      const info = vi
        .fn<() => Promise<AgentInfoResult>>()
        .mockRejectedValueOnce(firstFailure)
        .mockRejectedValueOnce(secondFailure);
      const client = { info } satisfies Pick<Client, "info">;

      const probe = probeAgentInfo({ client });
      await advanceRetry();

      await expect(probe).resolves.toEqual({ kind: "unavailable", error: secondFailure });
      expect(info).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["authorization failures", new ClientError(401, "Unauthorized")],
    ["unrecognized inspection payloads", new AgentInfoResponseError(["version: Required"])],
    ["unexpected client failures", new Error("unexpected")],
  ])("does not retry %s", async (_name, error) => {
    const info = vi.fn<() => Promise<AgentInfoResult>>().mockRejectedValueOnce(error);
    const client = { info } satisfies Pick<Client, "info">;

    await expect(probeAgentInfo({ client })).resolves.toEqual({ kind: "unavailable", error });
    expect(info).toHaveBeenCalledOnce();
  });
});
