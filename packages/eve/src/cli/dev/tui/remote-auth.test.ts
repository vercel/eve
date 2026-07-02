import { afterEach, describe, expect, it, vi } from "vitest";
import pc from "picocolors";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { resolveTestVercelTarget } from "#internal/testing/verified-vercel-target.js";

import { runRemoteAuthFlow, type RemoteAuthFlowDeps } from "./remote-auth.js";
import { formatRemoteAuthChallengeMessage } from "./remote-auth-result.js";

const WORKSPACE_ROOT = "/app/weather-agent";
const HOST = "vpoke.playground-vercel.tools";
const SERVER_URL = `https://${HOST}/`;
const OWNER_ID = "team_acme";
const PROJECT_ID = "prj_remote";
const SELECTED_TEAM = "labs";
const SELECTED_PROJECT_ID = "prj_e0";

const TARGET = await resolveTestVercelTarget({
  host: HOST,
  projectId: PROJECT_ID,
  ownerId: OWNER_ID,
  projectName: "remote-agent",
});
const SELECTED_TARGET = await resolveTestVercelTarget({
  host: HOST,
  projectId: SELECTED_PROJECT_ID,
  ownerId: "team_labs",
  projectName: "e0",
});
const TRUSTED_SOURCE_GRANT = {
  ownerId: OWNER_ID,
  projectId: PROJECT_ID,
  projectName: "remote-agent",
  targetEnvironment: "production",
} as const;

function oidcToken(ownerId: string, projectId: string, version = "1"): string {
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ owner_id: ownerId, project_id: projectId, version })}.signature`;
}

type LoginResult = Awaited<ReturnType<RemoteAuthFlowDeps["runLoginFlow"]>>;
type DeploymentResult = Awaited<ReturnType<RemoteAuthFlowDeps["resolveVercelDeployment"]>>;
type PreparationResult = Awaited<
  ReturnType<RemoteAuthFlowDeps["prepareVercelTrustedSourceAccess"]>
>;
type ApplicationResult = Awaited<ReturnType<RemoteAuthFlowDeps["applyVercelTrustedSourceAccess"]>>;

interface HarnessOptions {
  readonly logins?: readonly LoginResult[];
  readonly deployments?: readonly DeploymentResult[];
  readonly preparation?: PreparationResult;
  readonly application?: ApplicationResult;
  readonly token?:
    | { readonly kind: "present"; readonly value: string }
    | { readonly kind: "missing" };
  readonly configureTrustedSources?: boolean;
}

function createHarness(options: HarnessOptions = {}) {
  const operations: string[] = [];
  const logins = options.logins ?? [{ kind: "already" }];
  const deployments = options.deployments ?? [{ kind: "resolved", target: TARGET }];
  let loginCall = 0;
  let deploymentCall = 0;
  let token =
    options.token?.kind === "missing"
      ? undefined
      : (options.token?.value ?? oidcToken(OWNER_ID, PROJECT_ID));

  const { prompter } = createFakePrompter({
    single: () => {
      throw new Error("unexpected select prompt");
    },
  });

  const deps: RemoteAuthFlowDeps = {
    runLoginFlow: vi.fn<RemoteAuthFlowDeps["runLoginFlow"]>(async () => {
      operations.push("login");
      return logins[Math.min(loginCall++, logins.length - 1)]!;
    }),
    pickTeam: vi.fn<RemoteAuthFlowDeps["pickTeam"]>(async () => {
      operations.push("team");
      return SELECTED_TEAM;
    }),
    resolveVercelDeployment: vi.fn<RemoteAuthFlowDeps["resolveVercelDeployment"]>(async () => {
      operations.push("deployment");
      return deployments[Math.min(deploymentCall++, deployments.length - 1)]!;
    }),
    resolveOidcToken: vi.fn<RemoteAuthFlowDeps["resolveOidcToken"]>(async () => {
      operations.push("token");
      return token === undefined
        ? { kind: "resolution-failed", message: "Vercel did not issue an OIDC token." }
        : { kind: "resolved", token };
    }),
    prepareVercelTrustedSourceAccess: vi.fn<RemoteAuthFlowDeps["prepareVercelTrustedSourceAccess"]>(
      async () => {
        operations.push("prepare-ts");
        return options.preparation ?? { kind: "unchanged" };
      },
    ),
    applyVercelTrustedSourceAccess: vi.fn<RemoteAuthFlowDeps["applyVercelTrustedSourceAccess"]>(
      async () => {
        operations.push("apply-ts");
        return options.application ?? { kind: "unchanged" };
      },
    ),
  };

  return {
    deps,
    operations,
    prompter,
    setToken(value: string | undefined) {
      token = value;
    },
    run: (signal?: AbortSignal) =>
      runRemoteAuthFlow({
        workspaceRoot: WORKSPACE_ROOT,
        serverUrl: SERVER_URL,
        configureTrustedSources: options.configureTrustedSources,
        prompter,
        signal,
        deps,
      }),
  };
}

afterEach(() => vi.restoreAllMocks());

describe("runRemoteAuthFlow", () => {
  it("resolves the deployment from the URL and prepares the session token", async () => {
    const harness = createHarness();

    await expect(harness.run()).resolves.toMatchObject({ kind: "prepared" });

    expect(harness.deps.resolveVercelDeployment).toHaveBeenCalledWith({
      workspaceRoot: WORKSPACE_ROOT,
      host: HOST,
      signal: undefined,
    });
    expect(harness.deps.resolveOidcToken).toHaveBeenCalledWith({
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      forceRefresh: true,
    });
    expect(harness.operations).toEqual(["login", "deployment", "token"]);
  });

  it("selects a team when the unscoped deployment lookup misses", async () => {
    const { prompter } = createFakePrompter({
      single: () => {
        throw new Error("unexpected select prompt");
      },
    });
    let deploymentCall = 0;
    const resolveVercelDeployment = vi.fn<RemoteAuthFlowDeps["resolveVercelDeployment"]>(async () =>
      deploymentCall++ === 0
        ? { kind: "not-found" }
        : { kind: "resolved", target: SELECTED_TARGET },
    );
    const resolveOidcToken = vi.fn<RemoteAuthFlowDeps["resolveOidcToken"]>(async () => ({
      kind: "resolved",
      token: oidcToken("team_labs", SELECTED_PROJECT_ID),
    }));
    const pickTeam = vi.fn<RemoteAuthFlowDeps["pickTeam"]>(async () => SELECTED_TEAM);

    await expect(
      runRemoteAuthFlow({
        workspaceRoot: WORKSPACE_ROOT,
        serverUrl: SERVER_URL,
        prompter,
        deps: {
          runLoginFlow: vi.fn<RemoteAuthFlowDeps["runLoginFlow"]>(async () => ({
            kind: "already",
          })),
          pickTeam,
          resolveVercelDeployment,
          resolveOidcToken,
        },
      }),
    ).resolves.toMatchObject({
      kind: "prepared",
      target: SELECTED_TARGET,
    });
    expect(resolveVercelDeployment).toHaveBeenNthCalledWith(1, {
      workspaceRoot: WORKSPACE_ROOT,
      host: HOST,
      signal: undefined,
    });
    expect(resolveVercelDeployment).toHaveBeenNthCalledWith(2, {
      workspaceRoot: WORKSPACE_ROOT,
      host: HOST,
      signal: undefined,
      scope: SELECTED_TEAM,
    });
    expect(pickTeam).toHaveBeenCalledWith(
      prompter,
      WORKSPACE_ROOT,
      undefined,
      expect.objectContaining({ signal: undefined, selectMessage: expect.any(Function) }),
    );
    const selectMessage = pickTeam.mock.calls[0]?.[3]?.selectMessage;
    expect(selectMessage?.("Current Team")).toBe(
      `${pc.blue(HOST)} is not accessible via current team (${pc.bold("Current Team")})\n` +
        "You can try selecting another team:",
    );
    expect(resolveOidcToken).toHaveBeenCalledWith({
      ownerId: "team_labs",
      projectId: SELECTED_PROJECT_ID,
      forceRefresh: true,
    });
  });

  it("re-authenticates and resolves again when access is initially forbidden", async () => {
    const harness = createHarness({
      logins: [{ kind: "already" }, { kind: "logged-in" }],
      deployments: [{ kind: "forbidden" }, { kind: "resolved", target: TARGET }],
    });

    await expect(harness.run()).resolves.toMatchObject({
      kind: "prepared",
      completedMutations: [{ kind: "vercel-login" }],
    });
    expect(harness.operations).toEqual(["login", "deployment", "login", "deployment", "token"]);
    expect(harness.deps.resolveVercelDeployment).toHaveBeenCalledTimes(2);
    expect(harness.deps.runLoginFlow).toHaveBeenNthCalledWith(2, {
      appRoot: WORKSPACE_ROOT,
      force: true,
      prompter: harness.prompter,
      signal: undefined,
    });
  });

  it("gets Trusted Sources consent, applies it, then requests the session token", async () => {
    const harness = createHarness({
      configureTrustedSources: true,
      preparation: { kind: "approved", grant: TRUSTED_SOURCE_GRANT },
      application: { kind: "updated", targetProjectName: "remote-agent" },
    });

    await expect(harness.run()).resolves.toMatchObject({ kind: "prepared" });

    expect(harness.operations).toEqual(["login", "deployment", "prepare-ts", "apply-ts", "token"]);
    expect(harness.deps.prepareVercelTrustedSourceAccess).toHaveBeenCalledWith(
      expect.objectContaining({ target: TARGET }),
    );
  });

  it("returns a live token resolver that refreshes the project-scoped token", async () => {
    const harness = createHarness();

    const result = await harness.run();
    expect(result).toMatchObject({ kind: "prepared" });
    if (result.kind !== "prepared") throw new Error("Expected a prepared result");

    const rotated = oidcToken(OWNER_ID, PROJECT_ID, "2");
    harness.setToken(rotated);
    await expect(result.resolveToken()).resolves.toBe(rotated);
    expect(harness.deps.resolveOidcToken).toHaveBeenNthCalledWith(1, {
      ownerId: OWNER_ID,
      projectId: PROJECT_ID,
      forceRefresh: true,
    });
    expect(harness.deps.resolveOidcToken).toHaveBeenNthCalledWith(2, TARGET.deployment);
  });

  it("cancels when login is cancelled", async () => {
    const harness = createHarness({ logins: [{ kind: "cancelled" }] });

    await expect(harness.run()).resolves.toEqual({ kind: "cancelled", completedMutations: [] });
    expect(harness.operations).not.toContain("deployment");
  });

  it("cancels Trusted Sources consent before changing remote access", async () => {
    const harness = createHarness({
      configureTrustedSources: true,
      preparation: { kind: "cancelled" },
    });

    await expect(harness.run()).resolves.toEqual({ kind: "cancelled", completedMutations: [] });
    expect(harness.operations).not.toContain("apply-ts");
    expect(harness.operations).not.toContain("token");
  });

  it("cancels an abort that arrives before the first mutation", async () => {
    const abort = new AbortController();
    const harness = createHarness();
    vi.mocked(harness.deps.resolveVercelDeployment).mockImplementationOnce(async () => {
      abort.abort();
      return { kind: "resolved", target: TARGET };
    });

    await expect(harness.run(abort.signal)).resolves.toEqual({
      kind: "cancelled",
      completedMutations: [],
    });
    expect(harness.operations).not.toContain("token");
  });

  it.each([
    {
      name: "Vercel CLI",
      options: { logins: [{ kind: "cli-missing" }] },
      message: "not installed",
    },
    {
      name: "deployment not found",
      options: { deployments: [{ kind: "not-found" }] },
      message: "selected Vercel team",
    },
    {
      name: "access still forbidden after re-auth",
      options: {
        logins: [{ kind: "already" }, { kind: "already" }],
        deployments: [{ kind: "forbidden" }, { kind: "forbidden" }],
      },
      message: "Re-authenticate",
    },
    {
      name: "deployment verification",
      options: {
        deployments: [
          {
            kind: "failed",
            failure: {
              cause: "vercel",
              failure: { code: 1, stdout: "", stderr: "", message: "boom" },
            },
          },
        ],
      },
      message: "Could not verify",
    },
    {
      name: "OIDC token",
      options: { token: { kind: "missing" } },
      message: "did not issue an OIDC token",
    },
    {
      name: "Trusted Sources",
      options: {
        configureTrustedSources: true,
        preparation: { kind: "failed", message: "Vercel rejected the policy update." },
      },
      message: "Vercel rejected the policy update",
    },
    {
      name: "Trusted Sources apply",
      options: {
        configureTrustedSources: true,
        preparation: { kind: "approved", grant: TRUSTED_SOURCE_GRANT },
        application: { kind: "failed", message: "Vercel rejected the policy update." },
      },
      message: "Vercel rejected the policy update",
    },
  ] satisfies readonly { name: string; options: HarnessOptions; message: string }[])(
    "reports the $name failure",
    async ({ options, message }) => {
      const harness = createHarness(options);

      await expect(harness.run()).resolves.toMatchObject({
        kind: "failed",
        message: expect.stringContaining(message),
      });
    },
  );
});

describe("formatRemoteAuthChallengeMessage", () => {
  it("renders TUI recovery actions without the raw challenge HTML", () => {
    const message = formatRemoteAuthChallengeMessage("https://example.vercel.app");

    expect(message).toContain("https://example.vercel.app");
    expect(message).toContain("/vc:login");
    expect(message).toContain("VERCEL_AUTOMATION_BYPASS_SECRET");
    expect(message).toContain("Disable Deployment Protection");
    expect(message).toContain("https://vercel.com/docs/deployment-protection");
    expect(message).not.toContain("<");
    expect(message).not.toContain("doctype");
  });
});
