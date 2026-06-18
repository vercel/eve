import { afterEach, describe, expect, it, vi } from "vitest";
import pc from "picocolors";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { resolveTestVercelTarget } from "#internal/testing/verified-vercel-target.js";
import { StepBackError } from "#setup/step.js";

import { runRemoteAuthFlow, type RemoteAuthFlowDeps } from "./remote-auth.js";

const WORKSPACE_ROOT = "/app/weather-agent";
const HOST = "vpoke.playground-vercel.tools";
const SERVER_URL = `https://${HOST}/`;
const VERIFIED_TARGET = await resolveTestVercelTarget({
  host: HOST,
  projectId: "prj_remote",
  projectName: "remote-agent",
});

afterEach(() => vi.restoreAllMocks());

function deps(overrides: Partial<RemoteAuthFlowDeps> = {}): RemoteAuthFlowDeps {
  return {
    runLoginFlow: vi.fn<RemoteAuthFlowDeps["runLoginFlow"]>(async () => ({ kind: "already" })),
    detectProjectIdentity: vi.fn(async () => ({
      projectName: "weather-agent",
      teamName: "Acme",
    })),
    pickTeam: vi.fn(async () => "acme"),
    pickProject: vi.fn(async () => ({ exists: true, project: "remote-agent" })),
    resolveProjectByNameOrId: vi.fn(async () => ({
      id: "prj_remote",
      name: "remote-agent",
      accountId: "team_acme",
    })),
    linkProject: vi.fn(async () => true),
    resolveVercelDeployment: vi.fn<RemoteAuthFlowDeps["resolveVercelDeployment"]>(async () => ({
      kind: "resolved",
      target: VERIFIED_TARGET,
    })),
    runVercelEnvPull: vi.fn(async () => true),
    readPulledOidcToken: vi.fn(async () => "fresh-token"),
    prepareVercelTrustedSourceAccess: vi.fn<RemoteAuthFlowDeps["prepareVercelTrustedSourceAccess"]>(
      async () => ({ kind: "unchanged" }),
    ),
    applyVercelTrustedSourceAccess: vi.fn<RemoteAuthFlowDeps["applyVercelTrustedSourceAccess"]>(
      async () => ({ kind: "unchanged" }),
    ),
    ...overrides,
  };
}

describe("runRemoteAuthFlow", () => {
  it("shows the project-change warning on its option and returns the pulled token", async () => {
    const bold = vi.spyOn(pc, "bold").mockImplementation((value) => `<bold>${value}</bold>`);
    let notices: unknown;
    let projectOptions: unknown;
    const { prompter } = createFakePrompter({
      single: (options) => {
        notices = options.notices;
        projectOptions = options.options;
        return "current";
      },
    });
    const calls: string[] = [];
    const flowDeps = deps({
      prepareVercelTrustedSourceAccess: vi.fn(async () => {
        calls.push("prepare");
        return { kind: "unchanged" as const };
      }),
      runVercelEnvPull: vi.fn(async () => {
        calls.push("pull");
        return true;
      }),
      readPulledOidcToken: vi.fn(async () => {
        calls.push("read");
        return "fresh-token";
      }),
    });

    await expect(
      runRemoteAuthFlow({
        workspaceRoot: WORKSPACE_ROOT,
        serverUrl: SERVER_URL,
        configureTrustedSources: true,
        prompter,
        deps: flowDeps,
      }),
    ).resolves.toMatchObject({
      kind: "credential",
      target: VERIFIED_TARGET,
      token: "fresh-token",
    });

    expect(bold).toHaveBeenCalledWith("weather-agent");
    expect(notices).toBeUndefined();
    expect(projectOptions).toEqual([
      {
        value: "current",
        label: "Use current project",
        hint: "<bold>weather-agent</bold> in Acme",
      },
      {
        value: "change",
        label: "Select another Vercel project",
        notice: {
          tone: "warning",
          lines: ["Updates .env.local and .vercel/project.json"],
        },
      },
      { value: "cancel", label: "Cancel" },
    ]);
    expect(flowDeps.linkProject).not.toHaveBeenCalled();
    expect(flowDeps.runVercelEnvPull).toHaveBeenCalledWith(
      WORKSPACE_ROOT,
      expect.any(Function),
      undefined,
    );
    expect(flowDeps.prepareVercelTrustedSourceAccess).toHaveBeenCalledWith({
      workspaceRoot: WORKSPACE_ROOT,
      host: HOST,
      target: VERIFIED_TARGET,
      prompter,
      signal: undefined,
    });
    expect(calls).toEqual(["prepare", "pull", "read"]);
  });

  it("does not mutate project state when Vercel cannot verify the target", async () => {
    const { prompter } = createFakePrompter({ single: () => "current" });
    const flowDeps = deps({
      resolveVercelDeployment: vi.fn<RemoteAuthFlowDeps["resolveVercelDeployment"]>(async () => ({
        kind: "not-found",
      })),
    });

    await expect(
      runRemoteAuthFlow({
        workspaceRoot: WORKSPACE_ROOT,
        serverUrl: SERVER_URL,
        configureTrustedSources: true,
        prompter,
        deps: flowDeps,
      }),
    ).resolves.toEqual({
      kind: "failed",
      failure: {
        cause: "deployment-unverified",
        message: `Vercel did not resolve ${HOST} as a deployment in the selected account.`,
      },
      completedMutations: [],
    });
    expect(flowDeps.linkProject).not.toHaveBeenCalled();
    expect(flowDeps.prepareVercelTrustedSourceAccess).not.toHaveBeenCalled();
    expect(flowDeps.runVercelEnvPull).not.toHaveBeenCalled();
  });

  it("shows teams and projects before confirming a project change", async () => {
    const bold = vi.spyOn(pc, "bold").mockImplementation((value) => `<bold>${value}</bold>`);
    const prompts: unknown[] = [];
    let linkAction: unknown;
    const { prompter } = createFakePrompter({
      single: (options) => {
        prompts.push(options);
        if (options.message === `Authenticate ${HOST}`) return "change";
        if (options.message.startsWith("This directory is currently linked to")) {
          linkAction = options.options.find((option) => option.value === "continue");
          return "continue";
        }
        throw new Error(`Unexpected prompt: ${options.message}`);
      },
    });
    const calls: string[] = [];
    const flowDeps = deps({
      linkProject: vi.fn(async () => {
        calls.push("link");
        return true;
      }),
      prepareVercelTrustedSourceAccess: vi.fn(async () => {
        calls.push("prepare");
        return { kind: "unchanged" as const };
      }),
    });

    await expect(
      runRemoteAuthFlow({
        workspaceRoot: WORKSPACE_ROOT,
        serverUrl: SERVER_URL,
        configureTrustedSources: true,
        prompter,
        deps: flowDeps,
      }),
    ).resolves.toMatchObject({ kind: "credential", token: "fresh-token" });

    expect(flowDeps.pickTeam).toHaveBeenCalledWith(prompter, WORKSPACE_ROOT, undefined, {
      message: `Which team does ${pc.blue(SERVER_URL)} belong to?`,
      promptWhenSingle: true,
      signal: undefined,
    });
    expect(flowDeps.pickProject).toHaveBeenCalledWith(prompter, WORKSPACE_ROOT, "acme", {
      allowCreateWhenEmpty: false,
      message: `Which project is ${pc.blue(SERVER_URL)} part of?`,
      signal: undefined,
    });
    expect(flowDeps.linkProject).toHaveBeenCalledWith(
      prompter,
      WORKSPACE_ROOT,
      { kind: "existing", project: "remote-agent", team: "acme" },
      expect.any(Function),
      { signal: undefined },
    );
    expect(prompts).toEqual([
      expect.objectContaining({ message: `Authenticate ${HOST}` }),
      expect.objectContaining({
        message: "This directory is currently linked to weather-agent in <bold>Acme</bold>.",
        messageTone: "warning",
      }),
    ]);
    expect(linkAction).toEqual({
      value: "continue",
      label: "Link to project '<bold>remote-agent</bold>'",
      hint: "Links this directory and pulls an OIDC token for remote authentication.",
    });
    expect(bold).toHaveBeenCalledWith("Acme");
    expect(calls.slice(0, 2)).toEqual(["prepare", "link"]);
  });

  it("does not change the project when Trusted Sources consent is cancelled", async () => {
    const { prompter } = createFakePrompter({
      single: (options) => {
        if (options.message === `Authenticate ${HOST}`) return "change";
        if (options.message === "This directory is currently linked to weather-agent in Acme.") {
          return "continue";
        }
        throw new Error(`Unexpected prompt: ${options.message}`);
      },
    });
    const flowDeps = deps({
      prepareVercelTrustedSourceAccess: vi.fn(async () => ({ kind: "cancelled" as const })),
    });

    await expect(
      runRemoteAuthFlow({
        workspaceRoot: WORKSPACE_ROOT,
        serverUrl: SERVER_URL,
        configureTrustedSources: true,
        prompter,
        deps: flowDeps,
      }),
    ).resolves.toEqual({ kind: "cancelled", completedMutations: [] });

    expect(flowDeps.linkProject).not.toHaveBeenCalled();
    expect(flowDeps.runVercelEnvPull).not.toHaveBeenCalled();
  });

  it("applies an approved Trusted Sources grant after linking and before env pull", async () => {
    const calls: string[] = [];
    const grant = {
      scope: "acme",
      sourceProjectId: "prj_remote",
      sourceEnvironment: "development",
      targetProjectId: "prj_target",
      targetProjectName: "inbound",
      targetEnvironment: "production",
    } as const;
    const { prompter } = createFakePrompter({
      single: (options) => (options.message === `Authenticate ${HOST}` ? "change" : "continue"),
    });
    const flowDeps = deps({
      prepareVercelTrustedSourceAccess: vi.fn(async () => {
        calls.push("prepare");
        return { kind: "approved" as const, grant };
      }),
      linkProject: vi.fn(async () => {
        calls.push("link");
        return true;
      }),
      applyVercelTrustedSourceAccess: vi.fn(async () => {
        calls.push("apply");
        return {
          kind: "updated" as const,
          targetProjectId: "prj_target",
          targetProjectName: "inbound",
        };
      }),
      runVercelEnvPull: vi.fn(async () => {
        calls.push("pull");
        return true;
      }),
    });

    await expect(
      runRemoteAuthFlow({
        workspaceRoot: WORKSPACE_ROOT,
        serverUrl: SERVER_URL,
        configureTrustedSources: true,
        prompter,
        deps: flowDeps,
      }),
    ).resolves.toMatchObject({ kind: "credential", token: "fresh-token" });

    expect(calls).toEqual(["prepare", "link", "apply", "pull"]);
    expect(flowDeps.prepareVercelTrustedSourceAccess).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceProject: { projectId: "prj_remote", scope: "team_acme" },
      }),
    );
  });

  it("steps back from the project picker to the team picker when the user presses Esc", async () => {
    // Esc on the project picker surfaces as StepBackError; selectProject should
    // re-ask the team picker rather than abort the whole flow.
    const { prompter } = createFakePrompter({ single: () => "continue" });
    let projectAttempts = 0;
    const flowDeps = deps({
      detectProjectIdentity: vi.fn(async () => undefined),
      pickProject: vi.fn(async () => {
        projectAttempts += 1;
        if (projectAttempts === 1) throw new StepBackError();
        return { exists: true, project: "remote-agent" };
      }),
    });

    await expect(
      runRemoteAuthFlow({
        workspaceRoot: WORKSPACE_ROOT,
        serverUrl: SERVER_URL,
        prompter,
        deps: flowDeps,
      }),
    ).resolves.toMatchObject({ kind: "credential", token: "fresh-token" });

    expect(flowDeps.pickTeam).toHaveBeenCalledTimes(2);
    expect(flowDeps.pickProject).toHaveBeenCalledTimes(2);
  });

  it("preserves cancellation when a pre-apply project lookup is aborted", async () => {
    const abort = new AbortController();
    const { prompter } = createFakePrompter({ single: () => "change" });
    const flowDeps = deps({
      pickTeam: vi.fn(async () => {
        abort.abort();
        throw new Error("Vercel project lookup was aborted.");
      }),
    });

    await expect(
      runRemoteAuthFlow({
        workspaceRoot: WORKSPACE_ROOT,
        serverUrl: SERVER_URL,
        prompter,
        signal: abort.signal,
        deps: flowDeps,
      }),
    ).resolves.toEqual({ kind: "cancelled", completedMutations: [] });
    expect(flowDeps.linkProject).not.toHaveBeenCalled();
    expect(flowDeps.runVercelEnvPull).not.toHaveBeenCalled();
  });

  it("cancels the flow when Esc backs out of the first (team) picker", async () => {
    const { prompter } = createFakePrompter({ single: () => "continue" });
    const flowDeps = deps({
      detectProjectIdentity: vi.fn(async () => undefined),
      pickTeam: vi.fn(async () => {
        throw new StepBackError();
      }),
    });

    await expect(
      runRemoteAuthFlow({
        workspaceRoot: WORKSPACE_ROOT,
        serverUrl: SERVER_URL,
        prompter,
        deps: flowDeps,
      }),
    ).resolves.toEqual({ kind: "cancelled", completedMutations: [] });
    expect(flowDeps.pickProject).not.toHaveBeenCalled();
  });

  it("names the selected project and explains an initial link with a normal hint", async () => {
    const blueServerUrl = `\x1b[34m${SERVER_URL}\x1b[39m`;
    const blue = vi.spyOn(pc, "blue").mockImplementation((value) => `\x1b[34m${value}\x1b[39m`);
    let confirmationMessage: string | undefined;
    let confirmationNotices: unknown;
    let linkAction: unknown;
    const { prompter } = createFakePrompter({
      single: (options) => {
        confirmationMessage = options.message;
        confirmationNotices = options.notices;
        linkAction = options.options.find((option) => option.value === "continue");
        return "continue";
      },
    });
    const flowDeps = deps({ detectProjectIdentity: vi.fn(async () => undefined) });

    await expect(
      runRemoteAuthFlow({
        workspaceRoot: WORKSPACE_ROOT,
        serverUrl: SERVER_URL,
        prompter,
        deps: flowDeps,
      }),
    ).resolves.toMatchObject({ kind: "credential", token: "fresh-token" });

    expect(confirmationMessage).toBe("This directory is not currently linked.");
    expect(confirmationNotices).toBeUndefined();
    expect(linkAction).toEqual({
      value: "continue",
      label: `Link to project '${pc.bold("remote-agent")}'`,
      hint: "Links this directory and pulls an OIDC token for remote authentication.",
    });
    expect(blue).toHaveBeenCalledWith(SERVER_URL);
    expect(flowDeps.pickTeam).toHaveBeenCalledWith(prompter, WORKSPACE_ROOT, undefined, {
      message: `Which team does ${blueServerUrl} belong to?`,
      promptWhenSingle: true,
      signal: undefined,
    });
    expect(flowDeps.pickProject).toHaveBeenCalledWith(prompter, WORKSPACE_ROOT, "acme", {
      allowCreateWhenEmpty: false,
      message: `Which project is ${blueServerUrl} part of?`,
      signal: undefined,
    });
  });

  it("does not inspect or change Trusted Sources for a non-Vercel challenge", async () => {
    const { prompter } = createFakePrompter({ single: () => "current" });
    const flowDeps = deps();

    await expect(
      runRemoteAuthFlow({
        workspaceRoot: WORKSPACE_ROOT,
        serverUrl: SERVER_URL,
        prompter,
        deps: flowDeps,
      }),
    ).resolves.toMatchObject({ kind: "credential", token: "fresh-token" });

    expect(flowDeps.prepareVercelTrustedSourceAccess).not.toHaveBeenCalled();
  });

  it("runs Vercel login inline when the CLI account is logged out", async () => {
    const runLoginFlow = vi.fn<RemoteAuthFlowDeps["runLoginFlow"]>(async () => ({
      kind: "logged-in",
    }));
    const { prompter } = createFakePrompter({ single: () => "current" });

    await runRemoteAuthFlow({
      workspaceRoot: WORKSPACE_ROOT,
      serverUrl: SERVER_URL,
      prompter,
      deps: deps({ runLoginFlow }),
    });

    expect(runLoginFlow).toHaveBeenCalledWith({
      appRoot: WORKSPACE_ROOT,
      prompter,
      signal: undefined,
    });
  });

  it("reports a completed login when a later decision is cancelled", async () => {
    const { prompter } = createFakePrompter({ single: () => "cancel" });

    await expect(
      runRemoteAuthFlow({
        workspaceRoot: WORKSPACE_ROOT,
        serverUrl: SERVER_URL,
        prompter,
        deps: deps({
          runLoginFlow: vi.fn<RemoteAuthFlowDeps["runLoginFlow"]>(async () => ({
            kind: "logged-in",
          })),
        }),
      }),
    ).resolves.toEqual({
      kind: "cancelled",
      completedMutations: [{ kind: "vercel-login" }],
    });
  });

  it("reports a completed login when project resolution later fails", async () => {
    const { prompter } = createFakePrompter({ single: () => "change" });

    await expect(
      runRemoteAuthFlow({
        workspaceRoot: WORKSPACE_ROOT,
        serverUrl: SERVER_URL,
        prompter,
        deps: deps({
          runLoginFlow: vi.fn<RemoteAuthFlowDeps["runLoginFlow"]>(async () => ({
            kind: "logged-in",
          })),
          resolveProjectByNameOrId: vi.fn(async () => null),
        }),
      }),
    ).resolves.toMatchObject({
      kind: "failed",
      completedMutations: [{ kind: "vercel-login" }],
    });
  });

  it("does not pull credentials when the user cancels", async () => {
    const { prompter } = createFakePrompter({ single: () => "cancel" });
    const flowDeps = deps();

    await expect(
      runRemoteAuthFlow({
        workspaceRoot: WORKSPACE_ROOT,
        serverUrl: SERVER_URL,
        configureTrustedSources: true,
        prompter,
        deps: flowDeps,
      }),
    ).resolves.toEqual({ kind: "cancelled", completedMutations: [] });
    expect(flowDeps.runVercelEnvPull).not.toHaveBeenCalled();
  });

  it("keeps missing CLI, env-pull failure, and missing OIDC token distinct", async () => {
    const { prompter } = createFakePrompter({ single: () => "current" });

    await expect(
      runRemoteAuthFlow({
        workspaceRoot: WORKSPACE_ROOT,
        serverUrl: SERVER_URL,
        configureTrustedSources: true,
        prompter,
        deps: deps({
          runLoginFlow: vi.fn<RemoteAuthFlowDeps["runLoginFlow"]>(async () => ({
            kind: "cli-missing",
          })),
        }),
      }),
    ).resolves.toMatchObject({
      kind: "failed",
      failure: { cause: "cli-missing" },
    });

    await expect(
      runRemoteAuthFlow({
        workspaceRoot: WORKSPACE_ROOT,
        serverUrl: SERVER_URL,
        prompter,
        deps: deps({ runVercelEnvPull: vi.fn(async () => false) }),
      }),
    ).resolves.toMatchObject({
      kind: "failed",
      failure: { cause: "env-pull-failed" },
    });

    await expect(
      runRemoteAuthFlow({
        workspaceRoot: WORKSPACE_ROOT,
        serverUrl: SERVER_URL,
        prompter,
        deps: deps({ readPulledOidcToken: vi.fn(async () => undefined) }),
      }),
    ).resolves.toMatchObject({
      kind: "failed",
      failure: { cause: "oidc-token-missing" },
    });
  });

  it("reports mutations that completed before a later failure", async () => {
    const { prompter } = createFakePrompter({
      single: (options) => {
        if (options.message === `Authenticate ${HOST}`) return "change";
        return "continue";
      },
    });

    await expect(
      runRemoteAuthFlow({
        workspaceRoot: WORKSPACE_ROOT,
        serverUrl: SERVER_URL,
        prompter,
        deps: deps({ runVercelEnvPull: vi.fn(async () => false) }),
      }),
    ).resolves.toMatchObject({
      kind: "failed",
      failure: { cause: "env-pull-failed" },
      completedMutations: [{ kind: "project-linked", project: "remote-agent", team: "acme" }],
    });
  });

  it("cancels or fails when the required Trusted Sources update does not complete", async () => {
    const { prompter } = createFakePrompter({ single: () => "current" });

    await expect(
      runRemoteAuthFlow({
        workspaceRoot: WORKSPACE_ROOT,
        serverUrl: SERVER_URL,
        configureTrustedSources: true,
        prompter,
        deps: deps({
          prepareVercelTrustedSourceAccess: vi.fn<
            RemoteAuthFlowDeps["prepareVercelTrustedSourceAccess"]
          >(async () => ({ kind: "cancelled" })),
        }),
      }),
    ).resolves.toEqual({ kind: "cancelled", completedMutations: [] });

    await expect(
      runRemoteAuthFlow({
        workspaceRoot: WORKSPACE_ROOT,
        serverUrl: SERVER_URL,
        configureTrustedSources: true,
        prompter,
        deps: deps({
          prepareVercelTrustedSourceAccess: vi.fn<
            RemoteAuthFlowDeps["prepareVercelTrustedSourceAccess"]
          >(async () => ({
            kind: "failed",
            message: "Vercel rejected the policy update.",
          })),
        }),
      }),
    ).resolves.toEqual({
      kind: "failed",
      failure: {
        cause: "trusted-sources-update-failed",
        message: "Vercel rejected the policy update.",
      },
      completedMutations: [],
    });
  });
});
