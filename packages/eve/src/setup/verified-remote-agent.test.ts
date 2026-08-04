import { describe, expect, it, vi } from "vitest";

import { ClientError } from "#client/client-error.js";
import type { AgentInfoResult, ClientOptions } from "#client/types.js";
import { resolveTestVercelTarget } from "#internal/testing/verified-vercel-target.js";
import { createHeadlessPrompter } from "#setup/headless.js";

import { inspectVerifiedRemoteAgent } from "./verified-remote-agent.js";

const info: AgentInfoResult = {
  agent: {
    agentRoot: "/tmp/weather-agent/agent",
    appRoot: "/tmp/weather-agent",
    model: { id: "openai/gpt-5.5" },
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
};

const target = await resolveTestVercelTarget({
  host: "agent.example.com",
  projectId: "prj_example",
});
const clientOptions: ClientOptions = {
  host: "https://agent.example.com",
  redirect: "manual",
};

describe("inspectVerifiedRemoteAgent", () => {
  it("inspects with verified ambient credentials and returns the deployment scope", async () => {
    const runRemoteAuthFlow = vi.fn();

    await expect(
      inspectVerifiedRemoteAgent({
        serverUrl: "https://agent.example.com",
        workspaceRoot: "/workspace",
        deps: {
          createClient: () => ({ info: async () => info }),
          resolveVerifiedRemoteDevelopmentClient: async () => ({
            deploymentResolution: { kind: "resolved", target },
            lastOidcTokenFailure: () => undefined,
            options: clientOptions,
          }),
          runRemoteAuthFlow,
        },
      }),
    ).resolves.toEqual({ info, vercelScope: "team_test" });
    expect(runRemoteAuthFlow).not.toHaveBeenCalled();
  });

  it("runs interactive authentication after an authorized origin returns 401", async () => {
    const createClient = vi
      .fn<(options: ClientOptions) => { info(): Promise<AgentInfoResult> }>()
      .mockReturnValueOnce({
        info: async () => {
          throw new ClientError(401, "Unauthorized");
        },
      })
      .mockReturnValueOnce({ info: async () => info });
    const resolveToken = vi.fn(async () => "oidc-token");
    const runRemoteAuthFlow = vi.fn(async () => ({
      kind: "prepared" as const,
      completedMutations: [],
      resolveToken,
      target,
    }));

    await expect(
      inspectVerifiedRemoteAgent({
        prompter: createHeadlessPrompter(vi.fn()),
        serverUrl: "https://agent.example.com",
        workspaceRoot: "/workspace",
        deps: {
          createClient,
          resolveVerifiedRemoteDevelopmentClient: async () => ({
            deploymentResolution: { kind: "resolved", target },
            lastOidcTokenFailure: () => undefined,
            options: clientOptions,
          }),
          runRemoteAuthFlow,
        },
      }),
    ).resolves.toEqual({ info, vercelScope: "team_test" });

    expect(runRemoteAuthFlow).toHaveBeenCalledWith(
      expect.objectContaining({
        configureTrustedSources: true,
        serverUrl: "https://agent.example.com",
        workspaceRoot: "/workspace",
      }),
    );
    expect(createClient).toHaveBeenLastCalledWith(
      expect.objectContaining({
        auth: { vercelOidc: { token: resolveToken } },
        redirect: "manual",
      }),
    );
  });

  it("does not start Vercel authentication for an unverified origin returning 401", async () => {
    const runRemoteAuthFlow = vi.fn();

    await expect(
      inspectVerifiedRemoteAgent({
        prompter: createHeadlessPrompter(vi.fn()),
        serverUrl: "https://unverified.example.com",
        workspaceRoot: "/workspace",
        deps: {
          createClient: () => ({
            info: async () => {
              throw new ClientError(401, "Unauthorized");
            },
          }),
          resolveVerifiedRemoteDevelopmentClient: async () => ({
            deploymentResolution: { kind: "not-found" },
            lastOidcTokenFailure: () => undefined,
            options: { host: "https://unverified.example.com", redirect: "manual" },
          }),
          runRemoteAuthFlow,
        },
      }),
    ).rejects.toThrow("Unauthorized");
    expect(runRemoteAuthFlow).not.toHaveBeenCalled();
  });
});
