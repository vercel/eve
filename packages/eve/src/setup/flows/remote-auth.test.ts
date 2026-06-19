import pc from "picocolors";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { resolveTestVercelTarget } from "#internal/testing/verified-vercel-target.js";
import { StepBackError } from "#setup/step.js";

import type { PrompterValue, SingleSelectOptions } from "../prompter.js";
import { runRemoteAuthFlow, type RemoteAuthFlowDeps } from "./remote-auth.js";

const WORKSPACE_ROOT = "/app/weather-agent";
const HOST = "vpoke.playground-vercel.tools";
const SERVER_URL = `https://${HOST}/`;
const CURRENT_PROJECT = {
  projectId: "prj_current",
  orgId: "team_acme",
  projectName: "weather-agent",
};
const SELECTED_PROJECT = {
  id: "prj_remote",
  name: "remote-agent",
  accountId: "team_acme",
};
const VERIFIED_TARGET = await resolveTestVercelTarget({
  host: HOST,
  projectId: "prj_remote",
  projectName: "remote-agent",
});
const TRUSTED_SOURCE_GRANT = {
  scope: "acme",
  sourceProjectId: "prj_remote",
  sourceEnvironment: "development",
  targetProjectId: "prj_target",
  targetProjectName: "inbound",
  targetEnvironment: "production",
} as const;

type LoginResult = Awaited<ReturnType<RemoteAuthFlowDeps["runLoginFlow"]>>;
type DeploymentResult = Awaited<ReturnType<RemoteAuthFlowDeps["resolveVercelDeployment"]>>;
type PreparationResult = Awaited<
  ReturnType<RemoteAuthFlowDeps["prepareVercelTrustedSourceAccess"]>
>;
type ApplicationResult = Awaited<ReturnType<RemoteAuthFlowDeps["applyVercelTrustedSourceAccess"]>>;
type SelectedProject = Awaited<ReturnType<RemoteAuthFlowDeps["resolveProjectByNameOrId"]>>;

interface HarnessOptions {
  readonly projectAction?: "current" | "change" | "cancel";
  readonly confirmation?: "continue" | "cancel";
  readonly identity?: "current" | "none";
  readonly login?: LoginResult;
  readonly deployment?: DeploymentResult;
  readonly preparation?: PreparationResult;
  readonly application?: ApplicationResult;
  readonly envPull?: boolean;
  readonly linkError?: Error;
  readonly token?:
    | { readonly kind: "present"; readonly value: string }
    | { readonly kind: "missing" };
  readonly selectedProject?: SelectedProject;
  readonly projectBackOnce?: boolean;
  readonly teamBack?: boolean;
  readonly configureTrustedSources?: boolean;
}

function createHarness(options: HarnessOptions = {}) {
  const operations: string[] = [];
  const prompts: SingleSelectOptions<PrompterValue>[] = [];
  let projectAttempts = 0;
  let token =
    options.token?.kind === "missing" ? undefined : (options.token?.value ?? "fresh-token");
  const { prompter } = createFakePrompter({
    single: (prompt) => {
      prompts.push(prompt);
      return prompt.message === `Authenticate ${HOST}`
        ? (options.projectAction ?? "current")
        : (options.confirmation ?? "continue");
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
        : { projectName: "weather-agent", teamName: "Acme" };
    }),
    readProjectLink: vi.fn(async () => {
      operations.push("read-link");
      return CURRENT_PROJECT;
    }),
    pickTeam: vi.fn(async () => {
      operations.push("team");
      if (options.teamBack === true) throw new StepBackError();
      return "acme";
    }),
    pickProject: vi.fn(async () => {
      operations.push("project");
      projectAttempts += 1;
      if (options.projectBackOnce === true && projectAttempts === 1) throw new StepBackError();
      return { exists: true, project: "remote-agent" };
    }),
    resolveProjectByNameOrId: vi.fn(async () => {
      operations.push("resolve-project");
      return options.selectedProject === undefined ? SELECTED_PROJECT : options.selectedProject;
    }),
    linkResolvedVercelProject: vi.fn(async ({ project }) => {
      operations.push("link");
      if (options.linkError !== undefined) throw options.linkError;
      return { project };
    }),
    resolveVercelDeployment: vi.fn<RemoteAuthFlowDeps["resolveVercelDeployment"]>(async () => {
      operations.push("deployment");
      return options.deployment ?? { kind: "resolved", target: VERIFIED_TARGET };
    }),
    runVercelEnvPull: vi.fn(async () => {
      operations.push("pull");
      return options.envPull ?? true;
    }),
    readPulledOidcToken: vi.fn(async () => {
      operations.push("read-token");
      return token;
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
  it("shows the current project and warns that changing it updates local files", async () => {
    vi.spyOn(pc, "bold").mockImplementation((value) => `<bold>${value}</bold>`);
    const harness = createHarness({ configureTrustedSources: true });

    await expect(harness.run()).resolves.toMatchObject({ kind: "prepared" });

    expect(harness.prompts[0]?.options).toEqual([
      {
        value: "current",
        label: "Use current project",
        hint: "<bold>weather-agent</bold> in Acme",
      },
      {
        value: "change",
        label: "Select another Vercel project",
        notice: { tone: "warning", lines: ["Updates .env.local and .vercel/project.json"] },
      },
      { value: "cancel", label: "Cancel" },
    ]);
    expect(harness.deps.resolveVercelDeployment).toHaveBeenCalledWith({
      workspaceRoot: WORKSPACE_ROOT,
      host: HOST,
      signal: undefined,
      ownerId: "team_acme",
    });
    expect(harness.deps.prepareVercelTrustedSourceAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceProject: { projectId: "prj_current", scope: "team_acme" },
        target: VERIFIED_TARGET,
      }),
    );
    expect(harness.deps.linkResolvedVercelProject).not.toHaveBeenCalled();
  });

  it("resolves a selected project once and links that exact identity after target verification", async () => {
    vi.spyOn(pc, "bold").mockImplementation((value) => `<bold>${value}</bold>`);
    const harness = createHarness({ projectAction: "change" });

    await expect(harness.run()).resolves.toMatchObject({ kind: "prepared" });

    expect(harness.deps.resolveProjectByNameOrId).toHaveBeenCalledTimes(1);
    expect(harness.deps.linkResolvedVercelProject).toHaveBeenCalledWith({
      prompter: harness.prompter,
      projectRoot: WORKSPACE_ROOT,
      project: SELECTED_PROJECT,
      signal: undefined,
    });
    expect(harness.operations).toEqual([
      "login",
      "identity",
      "team",
      "project",
      "resolve-project",
      "deployment",
      "link",
      "pull",
      "read-token",
    ]);
    expect(harness.prompts[1]).toMatchObject({
      message: "This directory is currently linked to weather-agent in <bold>Acme</bold>.",
      messageTone: "warning",
    });
  });

  it("returns from the project picker to the team picker", async () => {
    const harness = createHarness({ identity: "none", projectBackOnce: true });

    await expect(harness.run()).resolves.toMatchObject({ kind: "prepared" });

    expect(harness.deps.pickTeam).toHaveBeenCalledTimes(2);
    expect(harness.deps.pickProject).toHaveBeenCalledTimes(2);
  });

  it("gets Trusted Sources consent before linking, then applies it before env pull", async () => {
    const harness = createHarness({
      projectAction: "change",
      configureTrustedSources: true,
      preparation: { kind: "approved", grant: TRUSTED_SOURCE_GRANT },
      application: {
        kind: "updated",
        targetProjectId: "prj_target",
        targetProjectName: "inbound",
      },
    });

    await expect(harness.run()).resolves.toMatchObject({ kind: "prepared" });

    expect(
      harness.operations.filter(
        (operation) =>
          operation.endsWith("ts") ||
          operation === "deployment" ||
          operation === "link" ||
          operation === "pull",
      ),
    ).toEqual(["deployment", "prepare-ts", "link", "apply-ts", "pull"]);
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
    { name: "first team picker", options: { identity: "none", teamBack: true } },
  ] satisfies readonly { name: string; options: HarnessOptions }[])(
    "cancels at $name before changing project state",
    async ({ options }) => {
      const harness = createHarness(options);

      await expect(harness.run()).resolves.toEqual({ kind: "cancelled", completedMutations: [] });
      expect(harness.operations).not.toContain("link");
      expect(harness.operations).not.toContain("apply-ts");
      expect(harness.operations).not.toContain("pull");
    },
  );

  it.each([
    {
      name: "Vercel CLI",
      options: { login: { kind: "cli-missing" } },
      cause: "cli-missing",
    },
    {
      name: "deployment",
      options: { deployment: { kind: "not-found" } },
      cause: "deployment-unverified",
    },
    {
      name: "selected project",
      options: { projectAction: "change", selectedProject: null },
      cause: "project-link-failed",
    },
    {
      name: "project link",
      options: { projectAction: "change", linkError: new Error("link rejected") },
      cause: "project-link-failed",
    },
    { name: "environment pull", options: { envPull: false }, cause: "env-pull-failed" },
    {
      name: "OIDC token",
      options: { token: { kind: "missing" } },
      cause: "oidc-token-missing",
    },
    {
      name: "Trusted Sources",
      options: {
        configureTrustedSources: true,
        preparation: { kind: "failed", message: "Vercel rejected the policy update." },
      },
      cause: "trusted-sources-update-failed",
    },
    {
      name: "Trusted Sources apply",
      options: {
        configureTrustedSources: true,
        preparation: { kind: "approved", grant: TRUSTED_SOURCE_GRANT },
        application: { kind: "failed", message: "Vercel rejected the policy update." },
      },
      cause: "trusted-sources-update-failed",
    },
  ] satisfies readonly { name: string; options: HarnessOptions; cause: string }[])(
    "keeps the $name failure distinct",
    async ({ options, cause }) => {
      const harness = createHarness(options);

      await expect(harness.run()).resolves.toMatchObject({ kind: "failed", failure: { cause } });
      if (cause === "deployment-unverified") {
        expect(harness.operations).not.toContain("link");
        expect(harness.operations).not.toContain("pull");
      }
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
    expect(harness.operations).not.toContain("pull");
  });

  it("reports a linked project when env pull fails afterward", async () => {
    const harness = createHarness({ projectAction: "change", envPull: false });

    await expect(harness.run()).resolves.toMatchObject({
      kind: "failed",
      failure: { cause: "env-pull-failed" },
      completedMutations: [{ kind: "project-linked", project: "remote-agent", team: "acme" }],
    });
  });

  it("skips Trusted Sources for an Eve-only challenge and returns a live token resolver", async () => {
    const harness = createHarness();

    const result = await harness.run();
    expect(result).toMatchObject({ kind: "prepared" });
    expect(harness.deps.prepareVercelTrustedSourceAccess).not.toHaveBeenCalled();
    expect(harness.deps.applyVercelTrustedSourceAccess).not.toHaveBeenCalled();
    if (result.kind !== "prepared") throw new Error("Expected a prepared result");

    harness.setToken("rotated-token");
    await expect(result.resolveToken()).resolves.toBe("rotated-token");
    expect(harness.deps.readPulledOidcToken).toHaveBeenCalledTimes(2);
  });
});
