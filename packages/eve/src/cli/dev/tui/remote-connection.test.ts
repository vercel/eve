import { afterEach, describe, expect, it, vi } from "vitest";

import { Client, ClientError, type AgentInfoResult } from "#client/index.js";
import { resolveTestVercelTarget } from "#internal/testing/verified-vercel-target.js";
import { createDevelopmentCredentialGate } from "#services/dev-client/credential-gate.js";
import type { VercelDeploymentResolution } from "#setup/vercel-deployment.js";

import {
  createRemoteConnectionController,
  type RemoteConnectionSnapshot,
} from "./remote-connection.js";

const TARGET = {
  serverUrl: "https://vpoke.playground-vercel.tools",
  host: "vpoke.playground-vercel.tools",
  workspaceRoot: "/tmp/weather-agent",
} as const;

const VERIFIED_TARGET = await resolveTestVercelTarget({
  host: TARGET.host,
  projectId: "prj_inbound",
  projectName: "inbound",
  environment: "production",
});
const DEPLOYMENT = VERIFIED_TARGET.deployment;

const RESOLVED_DEPLOYMENT = { kind: "resolved", target: VERIFIED_TARGET } as const;

const NEWER_VERIFIED_TARGET = await resolveTestVercelTarget({
  host: TARGET.host,
  projectId: "prj_inbound_next",
  projectName: "inbound-next",
});
const NEWER_DEPLOYMENT = NEWER_VERIFIED_TARGET.deployment;

function credentials() {
  return createDevelopmentCredentialGate(TARGET.serverUrl);
}

const INFO: AgentInfoResult = {
  agent: {
    agentRoot: "/tmp/weather-agent/agent",
    appRoot: "/tmp/weather-agent",
    model: { id: "gpt-5" },
    name: "Weather Agent",
  },
  capabilities: { devRoutes: true },
  channels: {
    authored: [],
    available: [],
    disabledFramework: [],
    framework: [],
  },
  connections: [],
  diagnostics: {
    discoveryErrors: 0,
    discoveryWarnings: 0,
  },
  hooks: [],
  instructions: {
    dynamic: [],
    static: {
      logicalPath: "agent/instructions.md",
      markdown: "You are a weather assistant.",
      name: "instructions",
      sourceKind: "markdown",
    },
  },
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
  workflow: {
    enabled: false,
    toolName: "Workflow",
  },
  workspace: {
    resourceRoot: null,
    rootEntries: [],
  },
};

function clientWithInfo(info: () => Promise<AgentInfoResult>): Client {
  const client = new Client({ host: TARGET.serverUrl });
  vi.spyOn(client, "info").mockImplementation(info);
  return client;
}

function unauthorized(): ClientError {
  return new ClientError(
    401,
    JSON.stringify({
      code: "unauthorized",
      error: "Authorization is required for this route.",
      ok: false,
    }),
  );
}

const VERCEL_SSO_CHALLENGE = `
<title>Authentication Required</title>
<a href="https://vercel.com/sso-api?url=https%3A%2F%2Fvpoke.playground-vercel.tools">
  Vercel Authentication
</a>`;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createRemoteConnectionController", () => {
  it("moves from checking to ready when /info succeeds", async () => {
    const snapshots: RemoteConnectionSnapshot[] = [];
    const controller = createRemoteConnectionController({
      client: clientWithInfo(async () => INFO),
      target: TARGET,
      credentials: credentials(),
      resolveDeployment: async () => RESOLVED_DEPLOYMENT,
      onChange: (snapshot) => snapshots.push(snapshot),
    });

    await expect(controller.check()).resolves.toEqual({ state: "ready", info: INFO });
    expect(snapshots.map((snapshot) => snapshot.connection.state)).toEqual([
      "checking",
      "checking",
      "checking",
      "ready",
    ]);
    expect(snapshots.at(-1)).toMatchObject({
      deployment: {
        provider: "vercel",
        projectName: "inbound",
        environment: "production",
      },
    });
  });

  it("resolves ambient credentials only after Vercel verifies the exact origin", async () => {
    const gate = credentials();
    const resolveOidcToken = vi.fn(async () => "verified-token");
    const client = clientWithInfo(async () => {
      await expect(gate.resolveHeaders()).resolves.toMatchObject({
        authorization: "Bearer verified-token",
      });
      return INFO;
    });
    const controller = createRemoteConnectionController({
      client,
      target: TARGET,
      credentials: gate,
      resolveDeployment: async () => RESOLVED_DEPLOYMENT,
      resolveOidcToken,
      onChange: () => {},
    });

    await expect(controller.check()).resolves.toEqual({ state: "ready", info: INFO });
    expect(resolveOidcToken).toHaveBeenCalledOnce();
  });

  it("keeps ambient credentials unavailable when Vercel does not verify the origin", async () => {
    const gate = credentials();
    const resolveOidcToken = vi.fn(async () => "must-not-resolve");
    const client = clientWithInfo(async () => {
      await expect(gate.resolveHeaders()).resolves.toEqual({});
      return INFO;
    });
    const controller = createRemoteConnectionController({
      client,
      target: TARGET,
      credentials: gate,
      resolveDeployment: async () => ({ kind: "not-found" }),
      resolveOidcToken,
      onChange: () => {},
    });

    await expect(controller.check()).resolves.toEqual({ state: "ready", info: INFO });
    expect(resolveOidcToken).not.toHaveBeenCalled();
  });

  it("does not probe until deployment authority resolves", async () => {
    let finishDeployment: ((value: typeof DEPLOYMENT) => void) | undefined;
    const deployment = new Promise<typeof DEPLOYMENT>((resolve) => {
      finishDeployment = resolve;
    });
    const snapshots: RemoteConnectionSnapshot[] = [];
    const controller = createRemoteConnectionController({
      client: clientWithInfo(async () => INFO),
      target: TARGET,
      credentials: credentials(),
      resolveDeployment: async () => ({
        kind: "resolved",
        target: {
          ...VERIFIED_TARGET,
          deployment: await deployment,
        },
      }),
      onChange: (snapshot) => snapshots.push(snapshot),
    });

    const check = controller.check();
    const winner = await Promise.race([
      check,
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 25)),
    ]);
    expect(winner).toBe("timed-out");
    expect(controller.current().connection).toEqual({ state: "checking" });
    finishDeployment?.(DEPLOYMENT);
    await expect(check).resolves.toEqual({ state: "ready", info: INFO });
    await vi.waitFor(() => expect(controller.current().deployment).toEqual(DEPLOYMENT));
    expect(snapshots.at(-1)?.connection).toEqual({ state: "ready", info: INFO });
  });

  it("publishes only the newest deployment lookup", async () => {
    const pending: Array<{
      signal: AbortSignal;
      resolve: (resolution: VercelDeploymentResolution) => void;
    }> = [];
    const controller = createRemoteConnectionController({
      client: clientWithInfo(async () => INFO),
      target: TARGET,
      credentials: credentials(),
      resolveDeployment: (signal) => new Promise((resolve) => pending.push({ signal, resolve })),
      onChange: () => {},
    });

    const first = controller.check();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const second = controller.check();
    expect(pending).toHaveLength(2);
    expect(pending[0]?.signal.aborted).toBe(true);

    pending[1]?.resolve({ kind: "resolved", target: NEWER_VERIFIED_TARGET });
    await second;
    await vi.waitFor(() => expect(controller.current().deployment).toEqual(NEWER_DEPLOYMENT));
    pending[0]?.resolve(RESOLVED_DEPLOYMENT);
    await first;

    expect(controller.current().deployment).toEqual(NEWER_DEPLOYMENT);
  });

  it("aborts an in-flight info probe when disposed", async () => {
    let probeSignal: AbortSignal | undefined;
    const client = clientWithInfo(
      async (options?: { readonly signal?: AbortSignal }) =>
        await new Promise<AgentInfoResult>((_resolve) => {
          probeSignal = options?.signal;
        }),
    );
    const controller = createRemoteConnectionController({
      client,
      target: TARGET,
      credentials: credentials(),
      onChange: () => {},
    });

    void controller.check();
    await Promise.resolve();
    expect(probeSignal).toBeInstanceOf(AbortSignal);

    controller.dispose();
    expect(probeSignal?.aborted).toBe(true);
  });

  it("times out an in-flight info probe", async () => {
    const client = clientWithInfo(
      async (options?: { readonly signal?: AbortSignal }) =>
        await new Promise<AgentInfoResult>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        }),
    );
    const controller = createRemoteConnectionController({
      client,
      target: TARGET,
      credentials: credentials(),
      probeTimeoutMs: 1,
      onChange: () => {},
    });

    await expect(controller.check()).resolves.toEqual({
      state: "unavailable",
      failure: {
        cause: "network",
        message: "Remote connection check timed out after 1ms.",
      },
    });
  });

  it("classifies only the Eve 401 contract as an OIDC challenge", async () => {
    const controller = createRemoteConnectionController({
      client: clientWithInfo(async () => {
        throw unauthorized();
      }),
      target: TARGET,
      credentials: credentials(),
      onChange: () => {},
    });

    await expect(controller.check()).resolves.toEqual({
      state: "auth-required",
      challenge: { kind: "eve-oidc" },
    });
  });

  it("does not classify a lookalike Eve 401 body as an OIDC challenge", async () => {
    const controller = createRemoteConnectionController({
      client: clientWithInfo(async () => {
        throw new ClientError(
          401,
          JSON.stringify({
            code: "unauthorized",
            error: "Authenticate with this unrelated service.",
            ok: false,
          }),
        );
      }),
      target: TARGET,
      credentials: credentials(),
      onChange: () => {},
    });

    await expect(controller.check()).resolves.toMatchObject({
      state: "unavailable",
      failure: { cause: "http", status: 401 },
    });
  });

  it("classifies the existing Vercel Deployment Protection challenge", async () => {
    const controller = createRemoteConnectionController({
      client: clientWithInfo(async () => {
        throw new ClientError(401, VERCEL_SSO_CHALLENGE);
      }),
      target: TARGET,
      credentials: credentials(),
      onChange: () => {},
    });

    await expect(controller.check()).resolves.toEqual({
      state: "auth-required",
      challenge: { kind: "vercel-deployment-protection" },
    });
  });

  it("keeps ordinary HTTP failures out of the auth flow", async () => {
    const controller = createRemoteConnectionController({
      client: clientWithInfo(async () => {
        throw new ClientError(503, "Unavailable");
      }),
      target: TARGET,
      credentials: credentials(),
      onChange: () => {},
    });

    await expect(controller.check()).resolves.toEqual({
      state: "unavailable",
      failure: {
        cause: "http",
        status: 503,
        message: "Unavailable",
      },
    });
  });

  it("classifies a Trusted Sources environment mismatch as a Vercel auth requirement", async () => {
    const controller = createRemoteConnectionController({
      client: clientWithInfo(async () => {
        throw new ClientError(
          403,
          [
            "Your trusted sources OIDC token's environment is not permitted to access this deployment",
            "TRUSTED_SOURCES_ENVIRONMENT_MISMATCH",
            "iad1::zgc5p-1781730251155-85842c28901b",
          ].join("\n\n"),
        );
      }),
      target: TARGET,
      credentials: credentials(),
      onChange: () => {},
    });

    await expect(controller.check()).resolves.toEqual({
      state: "auth-required",
      challenge: { kind: "vercel-deployment-protection" },
    });
  });

  it("requires HTTP 403 for a Trusted Sources environment mismatch", async () => {
    const controller = createRemoteConnectionController({
      client: clientWithInfo(async () => {
        throw new ClientError(
          500,
          [
            "Your trusted sources OIDC token's environment is not permitted to access this deployment",
            "TRUSTED_SOURCES_ENVIRONMENT_MISMATCH",
          ].join("\n\n"),
        );
      }),
      target: TARGET,
      credentials: credentials(),
      onChange: () => {},
    });

    await expect(controller.check()).resolves.toMatchObject({
      state: "unavailable",
      failure: { cause: "http", status: 500 },
    });
  });

  it("authenticates once, replaces the token, and proves success with /info", async () => {
    let probes = 0;
    const client = clientWithInfo(async () => {
      probes += 1;
      if (probes === 1) throw unauthorized();
      return INFO;
    });
    const gate = credentials();
    const snapshots: RemoteConnectionSnapshot[] = [];
    const controller = createRemoteConnectionController({
      client,
      target: TARGET,
      credentials: gate,
      onChange: (snapshot) => snapshots.push(snapshot),
    });

    await controller.check();
    await expect(
      controller.authenticate("startup", async () => ({
        kind: "credential",
        target: VERIFIED_TARGET,
        token: "new-token",
        completedMutations: [],
      })),
    ).resolves.toEqual({ kind: "authenticated", info: INFO });

    await expect(gate.resolveHeaders()).resolves.toMatchObject({
      authorization: "Bearer new-token",
    });
    expect(snapshots.map((snapshot) => snapshot.connection.state)).toContain("authenticating");
    expect(controller.current().connection).toEqual({ state: "ready", info: INFO });
    expect(controller.current().deployment).toEqual(DEPLOYMENT);
  });

  it("reports completed mutations when the refreshed token is rejected", async () => {
    const client = clientWithInfo(async () => {
      throw unauthorized();
    });
    const controller = createRemoteConnectionController({
      client,
      target: TARGET,
      credentials: credentials(),
      onChange: () => {},
    });

    await controller.check();
    await expect(
      controller.authenticate("startup", async () => ({
        kind: "credential",
        target: VERIFIED_TARGET,
        token: "rejected-token",
        completedMutations: [{ kind: "environment-pulled", path: ".env.local" }],
      })),
    ).resolves.toEqual({
      kind: "failed",
      failure: {
        cause: "token-rejected",
        message:
          "The selected Vercel project did not authorize vpoke.playground-vercel.tools. " +
          "Completed before the failure: refreshed .env.local.",
      },
      completedMutations: [{ kind: "environment-pulled", path: ".env.local" }],
    });
  });

  it("cancels the post-auth info probe from the owning command signal", async () => {
    let verificationSignal: AbortSignal | undefined;
    let probes = 0;
    const client = clientWithInfo(async (options?: { readonly signal?: AbortSignal }) => {
      probes += 1;
      if (probes === 1) throw unauthorized();
      verificationSignal = options?.signal;
      return await new Promise<AgentInfoResult>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
          once: true,
        });
      });
    });
    const controller = createRemoteConnectionController({
      client,
      target: TARGET,
      credentials: credentials(),
      onChange: () => {},
    });
    const abort = new AbortController();

    await controller.check();
    const authentication = controller.authenticate(
      "command",
      async () => ({
        kind: "credential",
        target: VERIFIED_TARGET,
        token: "fresh-token",
        completedMutations: [],
      }),
      abort.signal,
    );
    await vi.waitFor(() => expect(verificationSignal).toBeInstanceOf(AbortSignal));
    abort.abort(new Error("interrupted"));

    await expect(authentication).resolves.toEqual({
      kind: "cancelled",
      completedMutations: [],
    });
    expect(verificationSignal?.aborted).toBe(true);
    expect(controller.current().connection).toEqual({
      state: "auth-required",
      challenge: { kind: "eve-oidc" },
    });
  });

  it("preserves a partial-mutation failure when cancellation arrives during apply", async () => {
    const client = clientWithInfo(async () => {
      throw unauthorized();
    });
    const controller = createRemoteConnectionController({
      client,
      target: TARGET,
      credentials: credentials(),
      onChange: () => {},
    });
    const abort = new AbortController();

    await controller.check();
    await expect(
      controller.authenticate(
        "command",
        async () => {
          abort.abort(new Error("interrupted"));
          return {
            kind: "failed",
            failure: {
              cause: "env-pull-failed",
              message: "Environment pull was interrupted after linking.",
            },
            completedMutations: [{ kind: "project-linked", project: "source", team: "acme" }],
          };
        },
        abort.signal,
      ),
    ).resolves.toEqual({
      kind: "failed",
      failure: {
        cause: "env-pull-failed",
        message: "Environment pull was interrupted after linking.",
      },
      completedMutations: [{ kind: "project-linked", project: "source", team: "acme" }],
    });
  });

  it("does not automatically retry after a failed authentication attempt", async () => {
    const client = clientWithInfo(async () => {
      throw unauthorized();
    });
    const controller = createRemoteConnectionController({
      client,
      target: TARGET,
      credentials: credentials(),
      onChange: () => {},
    });

    await controller.check();
    await expect(
      controller.authenticate("startup", async () => ({
        kind: "failed",
        failure: {
          cause: "project-link-failed",
          message: "Could not link the project.",
        },
        completedMutations: [],
      })),
    ).resolves.toEqual({
      kind: "failed",
      failure: {
        cause: "project-link-failed",
        message: "Could not link the project.",
      },
      completedMutations: [],
    });
    expect(client.info).toHaveBeenCalledOnce();
    expect(controller.current().connection.state).toBe("auth-failed");
  });

  it("returns to auth-required after cancellation without starting another attempt", async () => {
    const client = clientWithInfo(async () => {
      throw unauthorized();
    });
    const controller = createRemoteConnectionController({
      client,
      target: TARGET,
      credentials: credentials(),
      onChange: () => {},
    });

    await controller.check();
    await expect(
      controller.authenticate("startup", async () => ({
        kind: "cancelled",
        completedMutations: [],
      })),
    ).resolves.toEqual({ kind: "cancelled", completedMutations: [] });
    expect(client.info).toHaveBeenCalledOnce();
    expect(controller.current().connection).toEqual({
      state: "auth-required",
      challenge: { kind: "eve-oidc" },
    });
  });

  it("keeps a ready connection ready when a manual re-authentication is cancelled", async () => {
    const client = clientWithInfo(async () => INFO);
    const controller = createRemoteConnectionController({
      client,
      target: TARGET,
      credentials: credentials(),
      onChange: () => {},
    });

    await controller.check();
    await expect(
      controller.authenticate("command", async () => ({
        kind: "cancelled",
        completedMutations: [],
      })),
    ).resolves.toEqual({ kind: "cancelled", completedMutations: [] });
    expect(client.info).toHaveBeenCalledOnce();
    expect(controller.current().connection).toEqual({ state: "ready", info: INFO });
  });

  it("preserves a Trusted Sources requirement across a failed retry", async () => {
    const client = clientWithInfo(
      vi
        .fn<() => Promise<AgentInfoResult>>()
        .mockRejectedValueOnce(unauthorized())
        .mockRejectedValueOnce(
          new ClientError(
            403,
            [
              "The caller environment is not permitted.",
              "TRUSTED_SOURCES_ENVIRONMENT_MISMATCH",
            ].join("\n\n"),
          ),
        ),
    );
    const controller = createRemoteConnectionController({
      client,
      target: TARGET,
      credentials: credentials(),
      onChange: () => {},
    });

    await controller.check();
    await controller.authenticate("startup", async () => ({
      kind: "credential",
      target: VERIFIED_TARGET,
      token: "wrong-environment-token",
      completedMutations: [],
    }));
    await controller.authenticate("command", async () => ({
      kind: "failed",
      failure: {
        cause: "trusted-sources-update-failed",
        message: "Could not update Trusted Sources.",
      },
      completedMutations: [],
    }));

    expect(controller.current().connection).toMatchObject({
      state: "auth-failed",
      challenge: { kind: "vercel-deployment-protection" },
    });
  });
});
