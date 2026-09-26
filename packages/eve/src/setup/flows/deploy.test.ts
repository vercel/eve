import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { packageInstallResult } from "#internal/testing/package-process.js";
import type { DeployProjectDeps } from "#setup/boxes/deploy-project.js";
import type { LinkProjectDeps } from "#setup/boxes/link-project.js";
import type { ResolveProvisioningDeps } from "#setup/boxes/resolve-provisioning.js";
import type { DeploymentInfo } from "#setup/project-resolution.js";

import { runDeployFlow, type DeployFlowDeps } from "./deploy.js";
import type { LoginFlowResult } from "./login.js";

const APP_ROOT = "/app/my-agent";

const UNLINKED: DeploymentInfo = { state: "unlinked" };
const LINKED: DeploymentInfo = { state: "linked", projectId: "prj_1", orgId: "org_1" };
const DEPLOYED: DeploymentInfo = {
  state: "deployed",
  projectId: "prj_1",
  productionUrl: "https://my-agent.vercel.app",
};

function createDeployProjectDeps(probe: DeploymentInfo = DEPLOYED) {
  return {
    runVercel: vi.fn<DeployProjectDeps["runVercel"]>(async () => true),
    detectPackageManager: vi.fn<DeployProjectDeps["detectPackageManager"]>(async () => ({
      kind: "pnpm",
      source: "default",
    })),
    runPackageManagerInstall: vi.fn<DeployProjectDeps["runPackageManagerInstall"]>(async () =>
      packageInstallResult(),
    ),
    detectDeployment: vi.fn<DeployProjectDeps["detectDeployment"]>(async () => probe),
    syncHostFrameworkPreset: vi.fn<DeployProjectDeps["syncHostFrameworkPreset"]>(async () => {}),
  };
}

function createProvisioningDeps() {
  return {
    requireAuth: vi.fn<ResolveProvisioningDeps["requireAuth"]>(async () => {}),
    isVercelAuthenticated: vi.fn<ResolveProvisioningDeps["isVercelAuthenticated"]>(
      async () => true,
    ),
    detectProjectResolution: vi.fn<ResolveProvisioningDeps["detectProjectResolution"]>(
      async () => ({ kind: "unresolved" }),
    ),
    pathExists: vi.fn<ResolveProvisioningDeps["pathExists"]>(async () => false),
    validateTeam: vi.fn<ResolveProvisioningDeps["validateTeam"]>(async () => {}),
    resolveTeam: vi.fn<ResolveProvisioningDeps["resolveTeam"]>(async () => "acme"),
    pickTeam: vi.fn<ResolveProvisioningDeps["pickTeam"]>(async () => "acme"),
    resolveProjectByNameOrId: vi.fn<ResolveProvisioningDeps["resolveProjectByNameOrId"]>(
      async () => ({
        projectId: "prj_existing",
        projectName: "existing-project",
      }),
    ),
    pickProject: vi.fn<ResolveProvisioningDeps["pickProject"]>(async () => ({
      kind: "existing",
      project: {
        projectId: "prj_1",
        projectName: "my-agent",
      },
      team: "acme",
    })),
    pickNewProjectName: vi.fn<ResolveProvisioningDeps["pickNewProjectName"]>(
      async () => "my-agent",
    ),
    assertNewProjectNameAvailable: vi.fn<ResolveProvisioningDeps["assertNewProjectNameAvailable"]>(
      async () => {},
    ),
  };
}

function createLinkProjectDeps() {
  return {
    linkProject: vi.fn<LinkProjectDeps["linkProject"]>(async () => ({
      projectId: "prj_1",
      projectName: "my-agent",
    })),
    detectProjectResolution: vi.fn<LinkProjectDeps["detectProjectResolution"]>(async () => ({
      kind: "linked",
      projectId: "prj_1",
    })),
    unresolvedProject: vi.fn<LinkProjectDeps["unresolvedProject"]>(() => ({ kind: "unresolved" })),
  };
}

function createLoginFlow(result: LoginFlowResult = { kind: "already" }) {
  return vi.fn<DeployFlowDeps["runLoginFlow"]>(async () => result);
}

describe("runDeployFlow", () => {
  it("blocks a local ChatGPT subscription model before Vercel effects", async () => {
    const fake = createFakePrompter({});
    const detectDeployment = vi.fn(async () => LINKED);

    await expect(
      runDeployFlow({
        appRoot: APP_ROOT,
        prompter: fake.prompter,
        interactive: true,
        deps: {
          detectDeployment,
          inspectApplication: vi.fn(async () => ({
            compiledState: {
              manifest: {
                config: { model: { routing: { kind: "external", provider: "codex" } } },
              },
            },
          })) as never,
        },
      }),
    ).resolves.toEqual({ kind: "local-model" });

    expect(detectDeployment).not.toHaveBeenCalled();
  });

  it("deploys an already-linked project without asking anything", async () => {
    const fake = createFakePrompter({});
    const deployDeps = createDeployProjectDeps();
    const login = createLoginFlow();
    const offer = vi.fn(async () => {});

    const result = await runDeployFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      interactive: true,
      deps: {
        detectDeployment: vi.fn(async () => LINKED),
        runLoginFlow: login,
        deployProject: deployDeps,
        offerTraceSampling: offer,
      },
    });

    expect(result).toEqual({ kind: "deployed", productionUrl: "https://my-agent.vercel.app" });
    expect(login).toHaveBeenCalledOnce();
    expect(fake.selectMessages).toEqual([]);
    expect(offer).toHaveBeenCalledWith(APP_ROOT, "prj_1", fake.prompter, undefined);
    expect(offer.mock.invocationCallOrder[0]).toBeGreaterThan(
      deployDeps.runVercel.mock.invocationCallOrder[0]!,
    );
    expect(deployDeps.runVercel).toHaveBeenCalledWith(
      ["deploy", "--prod", "--yes"],
      expect.objectContaining({ cwd: APP_ROOT }),
    );
  });

  it("refuses an unlinked non-interactive run before any effect", async () => {
    const fake = createFakePrompter({});
    const deployDeps = createDeployProjectDeps();
    const login = createLoginFlow();

    const result = await runDeployFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      interactive: false,
      deps: {
        detectDeployment: vi.fn(async () => UNLINKED),
        runLoginFlow: login,
        deployProject: deployDeps,
      },
    });

    expect(result).toEqual({ kind: "needs-link" });
    expect(login).not.toHaveBeenCalled();
    expect(deployDeps.runVercel).not.toHaveBeenCalled();
  });

  it("logs in, links, and deploys from an unlinked directory", async () => {
    const fake = createFakePrompter({
      single: (opts) => {
        if (opts.message === "Vercel project") return "new";
        throw new Error(`Unexpected select: ${opts.message}`);
      },
    });
    const deployDeps = createDeployProjectDeps();
    const linkDeps = createLinkProjectDeps();
    const provisioningDeps = createProvisioningDeps();
    const login = createLoginFlow({ kind: "logged-in" });

    const result = await runDeployFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      traceSampling: false,
      interactive: true,
      deps: {
        detectDeployment: vi.fn(async () => UNLINKED),
        runLoginFlow: login,
        resolveProvisioning: provisioningDeps,
        linkProject: linkDeps,
        deployProject: deployDeps,
      },
    });

    expect(result).toEqual({ kind: "deployed", productionUrl: "https://my-agent.vercel.app" });
    expect(login).toHaveBeenCalledWith({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      signal: undefined,
    });
    expect(provisioningDeps.pickTeam).toHaveBeenCalled();
    expect(login.mock.invocationCallOrder[0]).toBeLessThan(
      provisioningDeps.pickTeam.mock.invocationCallOrder[0]!,
    );
    expect(linkDeps.linkProject).toHaveBeenCalled();
    expect(linkDeps.linkProject).toHaveBeenCalledWith(
      fake.prompter,
      APP_ROOT,
      { kind: "new", project: "my-agent", team: "acme" },
      expect.anything(),
      { signal: undefined, traceSampling: false },
    );
    expect(deployDeps.runVercel).toHaveBeenCalledWith(
      ["deploy", "--prod", "--yes"],
      expect.objectContaining({ cwd: APP_ROOT }),
    );
  });

  it("cancels before project selection when Vercel login is cancelled", async () => {
    const fake = createFakePrompter({});
    const deployDeps = createDeployProjectDeps();
    const linkDeps = createLinkProjectDeps();
    const provisioningDeps = createProvisioningDeps();

    const result = await runDeployFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      interactive: true,
      deps: {
        detectDeployment: vi.fn(async () => UNLINKED),
        runLoginFlow: createLoginFlow({ kind: "cancelled" }),
        resolveProvisioning: provisioningDeps,
        linkProject: linkDeps,
        deployProject: deployDeps,
      },
    });

    expect(result).toEqual({ kind: "cancelled" });
    expect(provisioningDeps.pickTeam).not.toHaveBeenCalled();
    expect(linkDeps.linkProject).not.toHaveBeenCalled();
    expect(deployDeps.runVercel).not.toHaveBeenCalled();
  });

  it("deploys headlessly when linked, passing the non-interactive vercel flags", async () => {
    const fake = createFakePrompter({});
    const deployDeps = createDeployProjectDeps();
    const login = createLoginFlow();
    const offer = vi.fn(async () => {});

    const result = await runDeployFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      interactive: false,
      deps: {
        detectDeployment: vi.fn(async () => LINKED),
        runLoginFlow: login,
        deployProject: deployDeps,
        offerTraceSampling: offer,
      },
    });

    expect(result).toEqual({ kind: "deployed", productionUrl: "https://my-agent.vercel.app" });
    expect(login).not.toHaveBeenCalled();
    expect(offer).not.toHaveBeenCalled();
    expect(deployDeps.runVercel).toHaveBeenCalledWith(
      ["deploy", "--prod", "--yes", "--non-interactive"],
      expect.objectContaining({ cwd: APP_ROOT, nonInteractive: true }),
    );
  });

  it("skips the offer when sampling setup is disabled", async () => {
    const offer = vi.fn(async () => {});
    await runDeployFlow({
      appRoot: APP_ROOT,
      prompter: createFakePrompter().prompter,
      interactive: true,
      traceSampling: false,
      deps: {
        detectDeployment: async () => LINKED,
        runLoginFlow: createLoginFlow(),
        deployProject: createDeployProjectDeps(),
        offerTraceSampling: offer,
      },
    });
    expect(offer).not.toHaveBeenCalled();
  });

  it("offers after linking an existing project", async () => {
    const offer = vi.fn(async () => {});
    const fake = createFakePrompter({
      single: (opts) => {
        if (opts.message === "Vercel project") return "link";
        throw new Error(`Unexpected select: ${opts.message}`);
      },
    });

    const result = await runDeployFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      interactive: true,
      deps: {
        detectDeployment: async () => UNLINKED,
        runLoginFlow: createLoginFlow(),
        resolveProvisioning: createProvisioningDeps(),
        linkProject: createLinkProjectDeps(),
        deployProject: createDeployProjectDeps(),
        offerTraceSampling: offer,
      },
    });

    expect(result.kind).toBe("deployed");
    expect(offer).toHaveBeenCalledWith(APP_ROOT, "prj_1", fake.prompter, undefined);
  });

  it("does not offer tracing after creating a new project", async () => {
    const offer = vi.fn(async () => {});
    const fake = createFakePrompter({
      single: (opts) => {
        if (opts.message === "Vercel project") return "new";
        throw new Error(`Unexpected select: ${opts.message}`);
      },
    });

    await runDeployFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      interactive: true,
      traceSampling: true,
      deps: {
        detectDeployment: async () => UNLINKED,
        runLoginFlow: createLoginFlow(),
        resolveProvisioning: createProvisioningDeps(),
        linkProject: createLinkProjectDeps(),
        deployProject: createDeployProjectDeps(),
        offerTraceSampling: offer,
      },
    });

    expect(offer).not.toHaveBeenCalled();
  });

  it("reports a successful deploy even if the optional tracing check fails", async () => {
    const fake = createFakePrompter();
    const result = await runDeployFlow({
      appRoot: APP_ROOT,
      prompter: fake.prompter,
      interactive: true,
      deps: {
        detectDeployment: async () => LINKED,
        runLoginFlow: createLoginFlow(),
        deployProject: createDeployProjectDeps(),
        offerTraceSampling: vi.fn(async () => {
          throw new Error("Vercel API unavailable");
        }),
      },
    });

    expect(result).toEqual({ kind: "deployed", productionUrl: "https://my-agent.vercel.app" });
    expect(fake.prompter.log.warning).toHaveBeenCalledWith(
      expect.stringContaining("Deployment succeeded"),
    );
  });
});

it("installs the missing CLI and logs in before deploying an already-linked project", async () => {
  const login = createLoginFlow();
  login.mockResolvedValueOnce({ kind: "cli-missing" }).mockResolvedValueOnce({ kind: "logged-in" });
  const install = vi.fn(async () => ({ kind: "installed" as const }));
  const deploy = createDeployProjectDeps();
  await expect(
    runDeployFlow({
      appRoot: APP_ROOT,
      prompter: createFakePrompter().prompter,
      interactive: true,
      deps: {
        detectDeployment: async () => LINKED,
        runLoginFlow: login,
        runInstallVercelCliFlow: install,
        deployProject: deploy,
      },
    }),
  ).resolves.toEqual({ kind: "deployed", productionUrl: "https://my-agent.vercel.app" });
  expect(install).toHaveBeenCalledOnce();
  expect(login).toHaveBeenCalledTimes(2);
  expect(deploy.runVercel.mock.invocationCallOrder[0]).toBeGreaterThan(
    login.mock.invocationCallOrder[1]!,
  );
});

it.each(["failed", "unavailable"] as const)("does not deploy when login is %s", async (kind) => {
  const deploy = createDeployProjectDeps();
  await expect(
    runDeployFlow({
      appRoot: APP_ROOT,
      prompter: createFakePrompter().prompter,
      interactive: true,
      deps: {
        detectDeployment: async () => LINKED,
        runLoginFlow: createLoginFlow({ kind }),
        deployProject: deploy,
      },
    }),
  ).rejects.toThrow(/retry/i);
  expect(deploy.runVercel).not.toHaveBeenCalled();
});
