import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AgentInfoResponseError,
  Client,
  ClientError,
  type AgentInfoResult,
} from "#client/index.js";
import { resolveTestVercelTarget } from "#internal/testing/verified-vercel-target.js";
import {
  createDevelopmentCredentialGate,
  type DevelopmentCredentialGate,
} from "#services/dev-client/credential-gate.js";
import type { VercelDeploymentResolution } from "#setup/vercel-deployment.js";

import type { RemoteAuthPreparation } from "./remote-auth-result.js";
import {
  createRemoteConnectionController,
  type RemoteConnectionControllerOptions,
} from "./remote-connection.js";
import { remoteHost, type RemoteDevelopmentTarget } from "./target.js";

const TARGET = {
  kind: "remote",
  serverUrl: "https://vpoke.playground-vercel.tools",
  workspaceRoot: "/tmp/weather-agent",
} satisfies RemoteDevelopmentTarget;

const VERIFIED_TARGET = await resolveTestVercelTarget({
  host: remoteHost(TARGET),
  projectId: "prj_inbound",
  projectName: "inbound",
  environment: "production",
});
const RESOLVED_DEPLOYMENT = {
  kind: "resolved",
  target: VERIFIED_TARGET,
} satisfies VercelDeploymentResolution;

const NEWER_VERIFIED_TARGET = await resolveTestVercelTarget({
  host: remoteHost(TARGET),
  projectId: "prj_inbound_next",
  projectName: "inbound-next",
});

const INFO: AgentInfoResult = {
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
  workflow: { enabled: false, toolName: "Workflow" },
  workspace: { resourceRoot: null, rootEntries: [] },
};

const VERCEL_SSO_CHALLENGE = `
<title>Authentication Required</title>
<a href="https://vercel.com/sso-api?url=https%3A%2F%2Fvpoke.playground-vercel.tools">
  Vercel Authentication
</a>`;
const TRUSTED_SOURCES_MISMATCH = [
  "The caller environment is not permitted.",
  "TRUSTED_SOURCES_ENVIRONMENT_MISMATCH",
].join("\n\n");

function eveUnauthorized(error = "Authorization is required for this route."): ClientError {
  return new ClientError(401, JSON.stringify({ code: "unauthorized", error, ok: false }));
}

type HarnessOptions = Pick<
  RemoteConnectionControllerOptions,
  "resolveDeployment" | "resolveOidcToken"
> & {
  readonly info?: (credentials: DevelopmentCredentialGate) => Promise<AgentInfoResult>;
};

function createHarness(options: HarnessOptions = {}) {
  const { info = async () => INFO, ...controllerOptions } = options;
  const credentials = createDevelopmentCredentialGate(TARGET.serverUrl);
  const client = new Client({ host: TARGET.serverUrl });
  const infoSpy = vi.spyOn(client, "info").mockImplementation(() => info(credentials));
  const controller = createRemoteConnectionController({
    ...controllerOptions,
    client,
    credentials,
    target: TARGET,
    onChange: () => {},
  });
  return { client, controller, credentials, info: infoSpy };
}

function deferred<T>() {
  let settle: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return {
    promise,
    resolve(value: T): void {
      if (settle === undefined) throw new Error("Deferred promise was not initialized.");
      settle(value);
    },
  };
}

async function checkFailure(error: unknown) {
  const { controller } = createHarness({
    info: async () => {
      throw error;
    },
  });
  return await controller.check();
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("createRemoteConnectionController", () => {
  it.each([
    {
      name: "the exact Eve OIDC challenge",
      error: eveUnauthorized(),
      expected: { state: "auth-required", challenge: { kind: "eve-oidc" } },
    },
    {
      name: "an Eve-shaped 401 with different copy",
      error: eveUnauthorized("Authenticate with this unrelated service."),
      expected: { state: "unavailable" },
    },
    {
      name: "the Vercel Deployment Protection challenge",
      error: new ClientError(401, VERCEL_SSO_CHALLENGE),
      expected: {
        state: "auth-required",
        challenge: { kind: "vercel-deployment-protection" },
      },
    },
    {
      name: "a 403 Trusted Sources environment mismatch",
      error: new ClientError(403, TRUSTED_SOURCES_MISMATCH),
      expected: {
        state: "auth-required",
        challenge: { kind: "vercel-deployment-protection" },
      },
    },
    {
      name: "the same Trusted Sources code on a non-403 response",
      error: new ClientError(500, TRUSTED_SOURCES_MISMATCH),
      expected: {
        state: "unavailable",
        failure: { code: "TRUSTED_SOURCES_ENVIRONMENT_MISMATCH" },
      },
    },
    {
      name: "an ordinary HTTP failure",
      error: new ClientError(503, "Unavailable"),
      expected: { state: "unavailable", failure: { message: "Unavailable" } },
    },
    {
      name: "a network failure",
      error: new Error("offline"),
      expected: { state: "unavailable", failure: { message: "offline" } },
    },
  ])("classifies $name", async ({ error, expected }) => {
    await expect(checkFailure(error)).resolves.toMatchObject(expected);
  });

  it("stays ready after an unusable info payload when health confirms Eve", async () => {
    const harness = createHarness({
      info: async () => {
        throw new AgentInfoResponseError(["agent: Required"]);
      },
    });
    const health = vi.spyOn(harness.client, "health").mockResolvedValue({
      ok: true,
      status: "ready",
      workflowId: "wf_test",
    });

    await expect(harness.controller.check()).resolves.toEqual({ state: "ready" });
    expect(health).toHaveBeenCalledOnce();
  });

  it("is unavailable after an unusable info payload when health cannot confirm Eve", async () => {
    const harness = createHarness({
      info: async () => {
        throw new AgentInfoResponseError(["agent: Required"]);
      },
    });
    vi.spyOn(harness.client, "health").mockRejectedValue(new ClientError(404, "Not Found"));

    await expect(harness.controller.check()).resolves.toMatchObject({ state: "unavailable" });
  });

  it("stays ready when the info route is missing but health confirms a live deployment", async () => {
    const harness = createHarness({
      info: async () => {
        throw new ClientError(404, "Not Found");
      },
    });
    vi.spyOn(harness.client, "health").mockResolvedValue({
      ok: true,
      status: "ready",
      workflowId: "wf_test",
    });

    await expect(harness.controller.check()).resolves.toEqual({ state: "ready" });
  });

  it("is unavailable when the info route is missing and health does not confirm a deployment", async () => {
    const harness = createHarness({
      info: async () => {
        throw new ClientError(404, "Not Found");
      },
    });
    vi.spyOn(harness.client, "health").mockRejectedValue(new ClientError(404, "Not Found"));

    await expect(harness.controller.check()).resolves.toMatchObject({ state: "unavailable" });
  });

  it("resolves ambient credentials only after deployment authority is established", async () => {
    const pending = deferred<VercelDeploymentResolution>();
    const resolveDeployment = vi.fn(() => pending.promise);
    const resolveOidcToken = vi.fn(async () => ({
      kind: "resolved" as const,
      token: " ambient-token ",
    }));
    const harness = createHarness({
      resolveDeployment,
      resolveOidcToken,
      info: async (credentials) => {
        await expect(credentials.resolveToken()).resolves.toBe("ambient-token");
        return INFO;
      },
    });

    const check = harness.controller.check();
    await vi.waitFor(() => expect(resolveDeployment).toHaveBeenCalledOnce());
    expect(harness.info).not.toHaveBeenCalled();
    expect(resolveOidcToken).not.toHaveBeenCalled();

    pending.resolve(RESOLVED_DEPLOYMENT);
    await expect(check).resolves.toEqual({ state: "ready", info: INFO });
    expect(harness.controller.current().deployment).toEqual(VERIFIED_TARGET.deployment);
    expect(resolveOidcToken).toHaveBeenCalledWith(VERIFIED_TARGET.deployment);
  });

  it.each(["not-found", "forbidden"] as const)(
    "probes anonymously when Vercel resolves the host as %s",
    async (kind) => {
      const tokens: string[] = [];
      const resolveDeployment = vi.fn<(signal: AbortSignal) => Promise<VercelDeploymentResolution>>(
        async () => ({ kind }),
      );
      const harness = createHarness({
        resolveDeployment,
        info: async (credentials) => {
          tokens.push(await credentials.resolveToken());
          return INFO;
        },
      });

      await expect(harness.controller.check()).resolves.toEqual({ state: "ready", info: INFO });
      expect(harness.info).toHaveBeenCalledOnce();
      expect(tokens).toEqual([""]);
    },
  );

  it("uses the authenticated token resolver for every request", async () => {
    let request = 0;
    const info = vi.fn(async (credentials: DevelopmentCredentialGate) => {
      request += 1;
      if (request === 1) throw eveUnauthorized();
      await expect(credentials.resolveToken()).resolves.toBe("first-token");
      return INFO;
    });
    const resolveToken = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce(" first-token ")
      .mockResolvedValueOnce("second-token");
    const harness = createHarness({ info });

    await harness.controller.check();
    await expect(
      harness.controller.authenticate(async () => ({
        kind: "prepared",
        target: VERIFIED_TARGET,
        resolveToken,
        completedMutations: [],
      })),
    ).resolves.toEqual({ kind: "authenticated" });

    expect(resolveToken).toHaveBeenCalledOnce();
    await expect(harness.credentials.resolveToken()).resolves.toBe("second-token");
    expect(harness.controller.current().connection).toEqual({ state: "ready", info: INFO });
  });

  it("keeps a ready connection when manual authentication preparation fails", async () => {
    const harness = createHarness();

    await expect(harness.controller.check()).resolves.toEqual({ state: "ready", info: INFO });
    await expect(
      harness.controller.authenticate(async () => ({
        kind: "failed",
        message: "Vercel login failed.",
        completedMutations: [],
      })),
    ).resolves.toEqual({ kind: "failed", message: "Vercel login failed." });
    expect(harness.controller.current().connection).toEqual({ state: "ready", info: INFO });
  });

  it("reports a rejected token and its completed mutations without retrying", async () => {
    const info = vi.fn<() => Promise<AgentInfoResult>>().mockRejectedValue(eveUnauthorized());
    const attempt = vi.fn<() => Promise<RemoteAuthPreparation>>(async () => ({
      kind: "prepared",
      target: VERIFIED_TARGET,
      resolveToken: async () => "rejected-token",
      completedMutations: [{ kind: "trusted-sources-updated", targetProjectName: "remote-agent" }],
    }));
    const harness = createHarness({ info });

    await harness.controller.check();
    await expect(harness.controller.authenticate(attempt)).resolves.toEqual({
      kind: "failed",
      message:
        "The selected Vercel project did not authorize vpoke.playground-vercel.tools. " +
        "Completed before the failure: updated Trusted Sources for remote-agent.",
    });
    expect(attempt).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledTimes(2);
    await expect(harness.credentials.resolveToken()).resolves.toBe("");
  });

  it("restores prior connection authority when verification is cancelled", async () => {
    let request = 0;
    const verification = deferred<AgentInfoResult>();
    const verificationStarted = deferred<void>();
    const harness = createHarness({
      info: async (credentials) => {
        request += 1;
        if (request === 1) throw eveUnauthorized();
        await credentials.resolveToken();
        verificationStarted.resolve(undefined);
        return await verification.promise;
      },
    });
    harness.credentials.authorize({
      target: VERIFIED_TARGET,
      resolveToken: async () => "previous-token",
    });
    await harness.controller.check();
    const previous = harness.controller.current().connection;

    const abort = new AbortController();
    const authentication = harness.controller.authenticate(
      async () => ({
        kind: "prepared",
        target: NEWER_VERIFIED_TARGET,
        resolveToken: async () => "candidate-token",
        completedMutations: [],
      }),
      abort.signal,
    );
    await verificationStarted.promise;
    abort.abort();
    verification.resolve(INFO);
    await expect(authentication).resolves.toEqual({ kind: "cancelled", completedMutations: [] });
    expect(harness.controller.current().connection).toEqual(previous);
    expect(harness.controller.current().deployment).toBeUndefined();
    await expect(harness.credentials.resolveToken()).resolves.toBe("previous-token");
  });

  it("clears an authenticated credential before starting a new check", async () => {
    const tokens: string[] = [];
    let request = 0;
    const harness = createHarness({
      info: async (credentials) => {
        request += 1;
        tokens.push(await credentials.resolveToken());
        if (request === 1) throw eveUnauthorized();
        return INFO;
      },
    });

    await expect(harness.controller.check()).resolves.toMatchObject({ state: "auth-required" });
    await expect(
      harness.controller.authenticate(async () => ({
        kind: "prepared",
        target: VERIFIED_TARGET,
        resolveToken: async () => "authenticated-token",
        completedMutations: [],
      })),
    ).resolves.toEqual({ kind: "authenticated" });
    await expect(harness.controller.check()).resolves.toEqual({ state: "ready", info: INFO });

    expect(tokens[0]).toBe("");
    expect(tokens[1]).toBe("authenticated-token");
    expect(tokens[2]).toBe("");
  });

  it("clears ambient credentials before a later unresolved deployment check", async () => {
    const tokens: string[] = [];
    const resolveDeployment = vi
      .fn<(signal: AbortSignal) => Promise<VercelDeploymentResolution>>()
      .mockResolvedValueOnce(RESOLVED_DEPLOYMENT)
      .mockResolvedValueOnce({ kind: "not-found" });
    const harness = createHarness({
      resolveDeployment,
      resolveOidcToken: async () => ({ kind: "resolved", token: "ambient-token" }),
      info: async (credentials) => {
        tokens.push(await credentials.resolveToken());
        return INFO;
      },
    });

    await expect(harness.controller.check()).resolves.toEqual({ state: "ready", info: INFO });
    await expect(harness.controller.check()).resolves.toEqual({ state: "ready", info: INFO });

    expect(tokens).toEqual(["ambient-token", ""]);
    expect(harness.controller.current().deployment).toBeUndefined();
    await expect(harness.credentials.resolveToken()).resolves.toBe("");
  });

  it("does not publish a stale deployment lookup", async () => {
    const pending: Array<{
      readonly signal: AbortSignal;
      readonly resolve: (resolution: VercelDeploymentResolution) => void;
    }> = [];
    const harness = createHarness({
      resolveDeployment: (signal) => new Promise((resolve) => pending.push({ signal, resolve })),
      resolveOidcToken: async () => ({ kind: "resolved", token: "ambient-token" }),
    });

    const first = harness.controller.check();
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const second = harness.controller.check();
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    const [older, newer] = pending;
    if (older === undefined || newer === undefined) throw new Error("Missing deployment lookup.");
    expect(older.signal.aborted).toBe(true);

    newer.resolve({ kind: "resolved", target: NEWER_VERIFIED_TARGET });
    await second;
    older.resolve(RESOLVED_DEPLOYMENT);
    await first;
    expect(harness.controller.current().deployment).toEqual(NEWER_VERIFIED_TARGET.deployment);
    await expect(harness.credentials.resolveToken()).resolves.toBe("ambient-token");

    harness.controller.dispose();
    await expect(harness.credentials.resolveToken()).resolves.toBe("");
  });
});
