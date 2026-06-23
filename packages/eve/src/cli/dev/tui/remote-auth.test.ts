import pc from "picocolors";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { resolveTestVercelTarget } from "#internal/testing/verified-vercel-target.js";
import type { PrompterValue, SingleSelectOptions } from "#setup/prompter.js";

import { runRemoteAuthFlow, type RemoteAuthFlowDeps } from "./remote-auth.js";
import { formatRemoteAuthChallengeMessage } from "./remote-auth-result.js";

const WORKSPACE_ROOT = "/app/weather-agent";
const HOST = "vpoke.playground-vercel.tools";
const SERVER_URL = `https://${HOST}/`;
const CURRENT_PROJECT = {
  projectId: "prj_remote",
  orgId: "team_acme",
  projectName: "remote-agent",
};
const SELECTED_PROJECT = {
  projectId: "prj_selected",
  orgId: "team_acme",
  projectName: "remote-agent",
};
const VERIFIED_TARGET = await resolveTestVercelTarget({
  host: HOST,
  projectId: "prj_remote",
  ownerId: "team_acme",
  projectName: "remote-agent",
});
const SELECTED_VERIFIED_TARGET = await resolveTestVercelTarget({
  host: HOST,
  projectId: "prj_selected",
  ownerId: "team_acme",
  projectName: "remote-agent",
});
const TRUSTED_SOURCE_GRANT = {
  ownerId: "team_acme",
  projectId: "prj_selected",
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
  readonly projectAction?: "current" | "change" | "cancel";
  readonly identity?: "current" | "none";
  readonly login?: LoginResult;
  readonly deployment?: DeploymentResult;
  readonly preparation?: PreparationResult;
  readonly application?: ApplicationResult;
  readonly token?:
    | { readonly kind: "present"; readonly value: string }
    | { readonly kind: "missing" };
  readonly configureTrustedSources?: boolean;
}

function createHarness(options: HarnessOptions = {}) {
  const operations: string[] = [];
  const prompts: SingleSelectOptions<PrompterValue>[] = [];
  const tokenProject =
    options.identity === "none" || options.projectAction === "change"
      ? { ownerId: SELECTED_PROJECT.orgId, projectId: SELECTED_PROJECT.projectId }
      : { ownerId: CURRENT_PROJECT.orgId, projectId: CURRENT_PROJECT.projectId };
  let token =
    options.token?.kind === "missing"
      ? undefined
      : (options.token?.value ?? oidcToken(tokenProject.ownerId, tokenProject.projectId));
  const { prompter } = createFakePrompter({
    single: (prompt) => {
      prompts.push(prompt);
      return options.projectAction ?? "current";
    },
  });
  const deps: RemoteAuthFlowDeps = {
    runLoginFlow: vi.fn<RemoteAuthFlowDeps["runLoginFlow"]>(async () => {
      operations.push("login");
      return options.login ?? { kind: "already" };
    }),
    detectProjectIdentity: vi.fn(async () => {
      operations.push("identity");
      return options.identity === "none"
        ? undefined
        : { projectName: "remote-agent", teamName: "Acme" };
    }),
    readProjectLink: vi.fn(async () => {
      operations.push("read-link");
      return CURRENT_PROJECT;
    }),
    pickTeam: vi.fn(async () => {
      operations.push("team");
      return "acme";
    }),
    // The real picker echoes back the team it was scoped with — a slug from
    // `pickTeam`, not a `team_*` id. Mirror that so the suite exercises the
    // slug flowing through as the deployment scope.
    pickProject: vi.fn<RemoteAuthFlowDeps["pickProject"]>(async (_prompter, _root, team) => {
      operations.push("project");
      return {
        kind: "existing",
        project: {
          projectId: SELECTED_PROJECT.projectId,
          projectName: SELECTED_PROJECT.projectName,
        },
        team,
      };
    }),
    resolveVercelDeployment: vi.fn<RemoteAuthFlowDeps["resolveVercelDeployment"]>(async () => {
      operations.push("deployment");
      const target =
        options.projectAction === "change" || options.identity === "none"
          ? SELECTED_VERIFIED_TARGET
          : VERIFIED_TARGET;
      return options.deployment ?? { kind: "resolved", target };
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
    prompts,
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
  it("shows the current project before authenticating it", async () => {
    vi.spyOn(pc, "bold").mockImplementation((value) => `<bold>${value}</bold>`);
    const harness = createHarness({ configureTrustedSources: true });

    await expect(harness.run()).resolves.toMatchObject({ kind: "prepared" });

    expect(harness.prompts[0]?.options).toEqual([
      {
        value: "current",
        label: "Use current project",
        hint: "<bold>remote-agent</bold> in Acme",
      },
      {
        value: "change",
        label: "Select another Vercel project",
      },
      { value: "cancel", label: "Cancel" },
    ]);
    expect(harness.deps.resolveVercelDeployment).toHaveBeenCalledWith({
      workspaceRoot: WORKSPACE_ROOT,
      host: HOST,
      signal: undefined,
      source: { orgId: "team_acme", projectId: "prj_remote" },
    });
    expect(harness.deps.prepareVercelTrustedSourceAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        target: VERIFIED_TARGET,
      }),
    );
    expect(harness.deps.resolveOidcToken).toHaveBeenCalledWith({
      ownerId: "team_acme",
      projectId: "prj_remote",
      forceRefresh: true,
    });
  });

  it("verifies and authenticates a selected project without relinking the directory", async () => {
    vi.spyOn(pc, "bold").mockImplementation((value) => `<bold>${value}</bold>`);
    const harness = createHarness({ projectAction: "change" });

    await expect(harness.run()).resolves.toMatchObject({ kind: "prepared" });

    expect(harness.deps.resolveVercelDeployment).toHaveBeenCalledWith({
      workspaceRoot: WORKSPACE_ROOT,
      host: HOST,
      signal: undefined,
      // `pickTeam` yields a slug; it scopes the lookup verbatim, while the
      // resolved target's canonical owner id is what mints the OIDC token.
      source: { orgId: "acme", projectId: "prj_selected" },
    });
    expect(harness.operations).toEqual([
      "login",
      "identity",
      "team",
      "project",
      "deployment",
      "token",
    ]);
    expect(harness.deps.resolveOidcToken).toHaveBeenCalledWith({
      ownerId: "team_acme",
      projectId: "prj_selected",
      forceRefresh: true,
    });
    expect(harness.prompts).toHaveLength(1);
  });

  it("gets Trusted Sources consent, applies it, then requests the session token", async () => {
    const harness = createHarness({
      projectAction: "change",
      configureTrustedSources: true,
      preparation: { kind: "approved", grant: TRUSTED_SOURCE_GRANT },
      application: {
        kind: "updated",
        targetProjectName: "remote-agent",
      },
    });

    await expect(harness.run()).resolves.toMatchObject({ kind: "prepared" });

    expect(
      harness.operations.filter(
        (operation) =>
          operation.endsWith("ts") || operation === "deployment" || operation === "token",
      ),
    ).toEqual(["deployment", "prepare-ts", "apply-ts", "token"]);
  });

  it("records a completed login when the next decision is cancelled", async () => {
    const harness = createHarness({ login: { kind: "logged-in" }, projectAction: "cancel" });

    await expect(harness.run()).resolves.toEqual({
      kind: "cancelled",
      completedMutations: [{ kind: "vercel-login" }],
    });
  });

  it.each([
    { name: "project choice", options: { projectAction: "cancel" } },
    {
      name: "Trusted Sources consent",
      options: {
        configureTrustedSources: true,
        preparation: { kind: "cancelled" },
      },
    },
  ] satisfies readonly { name: string; options: HarnessOptions }[])(
    "cancels at $name before changing remote access",
    async ({ options }) => {
      const harness = createHarness(options);

      await expect(harness.run()).resolves.toEqual({ kind: "cancelled", completedMutations: [] });
      expect(harness.operations).not.toContain("apply-ts");
      expect(harness.operations).not.toContain("token");
    },
  );

  it.each([
    {
      name: "Vercel CLI",
      options: { login: { kind: "cli-missing" } },
      message: "not installed",
    },
    {
      name: "deployment",
      options: { deployment: { kind: "not-found" } },
      message: "did not resolve",
    },
    {
      name: "project identity",
      options: {
        projectAction: "change",
        deployment: {
          kind: "project-mismatch",
          expectedProjectId: "prj_selected",
          actualProjectId: "prj_other",
        },
      },
      message: "resolved project prj_other, not prj_selected",
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

  it("cancels an abort that arrives before the first mutation", async () => {
    const abort = new AbortController();
    const harness = createHarness();
    vi.mocked(harness.deps.resolveVercelDeployment).mockImplementationOnce(async () => {
      abort.abort();
      return { kind: "resolved", target: VERIFIED_TARGET };
    });

    await expect(harness.run(abort.signal)).resolves.toEqual({
      kind: "cancelled",
      completedMutations: [],
    });
    expect(harness.operations).not.toContain("token");
  });

  it("skips Trusted Sources for an Eve-only challenge and returns a live token resolver", async () => {
    const harness = createHarness();

    const result = await harness.run();
    expect(result).toMatchObject({ kind: "prepared" });
    expect(harness.deps.prepareVercelTrustedSourceAccess).not.toHaveBeenCalled();
    expect(harness.deps.applyVercelTrustedSourceAccess).not.toHaveBeenCalled();
    if (result.kind !== "prepared") throw new Error("Expected a prepared result");

    const rotatedToken = oidcToken(CURRENT_PROJECT.orgId, CURRENT_PROJECT.projectId, "2");
    harness.setToken(rotatedToken);
    await expect(result.resolveToken()).resolves.toBe(rotatedToken);
    expect(harness.deps.resolveOidcToken).toHaveBeenNthCalledWith(1, {
      ownerId: CURRENT_PROJECT.orgId,
      projectId: CURRENT_PROJECT.projectId,
      forceRefresh: true,
    });
    expect(harness.deps.resolveOidcToken).toHaveBeenNthCalledWith(2, VERIFIED_TARGET.deployment);
  });
});

describe("formatRemoteAuthChallengeMessage", () => {
  it("renders TUI recovery actions without the raw challenge HTML", () => {
    const message = formatRemoteAuthChallengeMessage("https://example.vercel.app");

    expect(message).toContain("https://example.vercel.app");
    expect(message).toContain("/vc:auth");
    expect(message).toContain("VERCEL_AUTOMATION_BYPASS_SECRET");
    expect(message).toContain("Disable Deployment Protection");
    expect(message).toContain("https://vercel.com/docs/deployment-protection");
    expect(message).not.toContain("<");
    expect(message).not.toContain("doctype");
  });
});
