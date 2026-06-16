import { stripVTControlCharacters } from "node:util";

import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import type { ApplyAiGatewayCredentialDeps } from "#setup/boxes/apply-ai-gateway-credential.js";
import type { LinkProjectDeps } from "#setup/boxes/link-project.js";
import type { ResolveProvisioningDeps } from "#setup/boxes/resolve-provisioning.js";
import { WizardCancelledError } from "#setup/step.js";

import { runLinkFlow, type LinkFlowDeps } from "./link.js";

const APP_ROOT = "/app/my-agent";

function createBoxDeps() {
  return {
    resolveProvisioning: {
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
      pickProject: vi.fn<ResolveProvisioningDeps["pickProject"]>(async () => ({
        exists: true,
        project: "weather-app",
      })),
      pickNewProjectName: vi.fn<ResolveProvisioningDeps["pickNewProjectName"]>(
        async () => "my-agent",
      ),
      assertNewProjectNameAvailable: vi.fn<
        ResolveProvisioningDeps["assertNewProjectNameAvailable"]
      >(async () => {}),
    },
    linkProject: {
      linkProject: vi.fn<LinkProjectDeps["linkProject"]>(async () => true),
      detectProjectResolution: vi.fn<LinkProjectDeps["detectProjectResolution"]>(async () => ({
        kind: "linked",
        projectId: "prj_1",
      })),
      resolveProjectByNameOrId: vi.fn<LinkProjectDeps["resolveProjectByNameOrId"]>(async () => ({
        id: "prj_1",
        name: "weather-app",
      })),
      unresolvedProject: vi.fn<LinkProjectDeps["unresolvedProject"]>(() => ({
        kind: "unresolved",
      })),
    },
    applyAiGatewayCredential: {
      appendEnv: vi.fn<ApplyAiGatewayCredentialDeps["appendEnv"]>(async () => ({
        written: [],
        skipped: [],
      })),
      runVercelEnvPull: vi.fn<ApplyAiGatewayCredentialDeps["runVercelEnvPull"]>(async () => true),
      detectAiGatewayResolution: vi.fn<ApplyAiGatewayCredentialDeps["detectAiGatewayResolution"]>(
        async () => ({ kind: "api-key", envFile: ".env.local" }),
      ),
    },
  };
}

function flowDeps(args: {
  identity?: { projectName: string; teamName?: string };
  envFilesByKey?: Record<string, ".env.local" | ".env">;
}): Partial<LinkFlowDeps> {
  return {
    detectProjectIdentity: vi.fn(async () => args.identity),
    findEnvFileWithKey: vi.fn(async (_root: string, key: string) => args.envFilesByKey?.[key]),
    ...createBoxDeps(),
  };
}

describe("runLinkFlow", () => {
  it("shows the current link, then goes directly from team to the existing-project picker", async () => {
    const { prompter, selectMessages } = createFakePrompter({
      single: (opts) => {
        if (
          stripVTControlCharacters(opts.message) ===
          "This directory is already linked to\nweather-app in Acme"
        ) {
          return "relink";
        }
        throw new Error(`Unexpected select: ${opts.message}`);
      },
    });
    const deps = flowDeps({
      identity: { projectName: "weather-app", teamName: "Acme" },
      envFilesByKey: { VERCEL_OIDC_TOKEN: ".env.local" },
    });

    const result = await runLinkFlow({ appRoot: APP_ROOT, prompter, deps });

    expect(result).toEqual({ kind: "done", credential: "VERCEL_OIDC_TOKEN" });
    expect(selectMessages).toHaveLength(1);
    expect(stripVTControlCharacters(selectMessages[0] ?? "")).toBe(
      "This directory is already linked to\nweather-app in Acme",
    );
    expect(deps.resolveProvisioning?.pickTeam).toHaveBeenCalled();
    expect(deps.resolveProvisioning?.pickProject).toHaveBeenCalledWith(
      expect.anything(),
      APP_ROOT,
      "acme",
      { allowCreateWhenEmpty: false },
    );
    expect(deps.resolveProvisioning?.pickNewProjectName).not.toHaveBeenCalled();
    expect(deps.linkProject?.linkProject).toHaveBeenCalled();
    expect(deps.applyAiGatewayCredential?.runVercelEnvPull).toHaveBeenCalledWith(
      APP_ROOT,
      expect.any(Function),
      undefined,
    );
    // Success is silent — the caller owns the closing line; only the
    // missing-credential warning earns output.
    expect(prompter.log.warning).not.toHaveBeenCalled();
  });

  it("offers create when the caller passes create-or-link (the /model branch)", async () => {
    const { prompter } = createFakePrompter({
      single: (opts) => {
        if (stripVTControlCharacters(opts.message) === "Vercel project") return "new";
        throw new Error(`Unexpected select: ${opts.message}`);
      },
    });
    const deps = flowDeps({ envFilesByKey: { VERCEL_OIDC_TOKEN: ".env.local" } });

    const result = await runLinkFlow({
      appRoot: APP_ROOT,
      prompter,
      deps,
      projectSelection: "create-or-link",
    });

    expect(result).toEqual({ kind: "done", credential: "VERCEL_OIDC_TOKEN" });
    // The create path runs the new-project namer and never reaches the
    // existing-project picker — the opposite of the existing-only default.
    expect(deps.resolveProvisioning?.pickNewProjectName).toHaveBeenCalled();
    expect(deps.resolveProvisioning?.pickProject).not.toHaveBeenCalled();
  });

  it("runs the pickers on re-link even when the on-disk link is adoptable", async () => {
    const { prompter } = createFakePrompter({
      single: (opts) => {
        if (
          stripVTControlCharacters(opts.message) ===
          "This directory is already linked to\nweather-app in Acme"
        ) {
          return "relink";
        }
        throw new Error(`Unexpected select: ${opts.message}`);
      },
    });
    const boxDeps = createBoxDeps();
    // Prime every adoption precondition (link file present, resolvable,
    // logged in): if detection ran, it would re-adopt the current link and
    // the pickers below would never be reached.
    boxDeps.resolveProvisioning.pathExists.mockResolvedValue(true);
    boxDeps.resolveProvisioning.detectProjectResolution.mockResolvedValue({
      kind: "linked",
      projectId: "prj_current",
    });
    const deps: Partial<LinkFlowDeps> = {
      detectProjectIdentity: vi.fn(async () => ({
        projectName: "weather-app",
        teamName: "Acme",
      })),
      findEnvFileWithKey: vi.fn(async () => undefined),
      ...boxDeps,
    };

    const result = await runLinkFlow({ appRoot: APP_ROOT, prompter, deps });

    expect(result).toEqual({ kind: "done" });
    expect(boxDeps.resolveProvisioning.detectProjectResolution).not.toHaveBeenCalled();
    expect(boxDeps.resolveProvisioning.pickTeam).toHaveBeenCalled();
    expect(boxDeps.resolveProvisioning.pickProject).toHaveBeenCalled();
    expect(boxDeps.linkProject.linkProject).toHaveBeenCalled();
  });

  it("dismisses an existing link without entering the project pickers", async () => {
    const { prompter } = createFakePrompter({
      single: (opts) => {
        if (
          stripVTControlCharacters(opts.message) ===
          "This directory is already linked to\nweather-app in Acme"
        ) {
          return "dismiss";
        }
        throw new Error(`Unexpected select: ${opts.message}`);
      },
    });
    const deps = flowDeps({
      identity: { projectName: "weather-app", teamName: "Acme" },
    });

    await expect(runLinkFlow({ appRoot: APP_ROOT, prompter, deps })).resolves.toEqual({
      kind: "cancelled",
    });
    expect(deps.resolveProvisioning?.pickTeam).not.toHaveBeenCalled();
    expect(deps.resolveProvisioning?.pickProject).not.toHaveBeenCalled();
  });

  it("opens the existing-project picker from an unlinked directory and warns when no credential lands", async () => {
    const { prompter } = createFakePrompter({
      single: (opts) => {
        throw new Error(`Unexpected select: ${opts.message}`);
      },
    });
    const deps = flowDeps({});

    const result = await runLinkFlow({ appRoot: APP_ROOT, prompter, deps });

    expect(result).toEqual({ kind: "done" });
    expect(prompter.log.message).not.toHaveBeenCalledWith(
      expect.stringContaining("not linked to a Vercel project"),
    );
    expect(deps.resolveProvisioning?.pickProject).toHaveBeenCalled();
    expect(deps.resolveProvisioning?.pickNewProjectName).not.toHaveBeenCalled();
    expect(prompter.log.warning).toHaveBeenCalledWith(
      expect.stringContaining("no model credential landed"),
    );
  });

  it("keeps the current link when the re-link gate is cancelled", async () => {
    const { prompter } = createFakePrompter({
      single: () => {
        throw new WizardCancelledError();
      },
    });
    const deps = flowDeps({ identity: { projectName: "weather-app" } });

    const result = await runLinkFlow({ appRoot: APP_ROOT, prompter, deps });

    expect(result).toEqual({ kind: "cancelled" });
    expect(deps.resolveProvisioning?.pickTeam).not.toHaveBeenCalled();
    expect(deps.linkProject?.linkProject).not.toHaveBeenCalled();
    expect(deps.findEnvFileWithKey).not.toHaveBeenCalled();
  });

  it("folds a cancel inside the pickers without touching the link", async () => {
    const { prompter } = createFakePrompter();
    const deps = flowDeps({});
    if (deps.resolveProvisioning === undefined) throw new Error("Expected provisioning deps.");
    deps.resolveProvisioning.pickProject = vi.fn(async () => {
      throw new WizardCancelledError();
    });

    const result = await runLinkFlow({ appRoot: APP_ROOT, prompter, deps });

    expect(result).toEqual({ kind: "cancelled" });
    expect(deps.linkProject?.linkProject).not.toHaveBeenCalled();
  });

  it("names the credential source when unlinked but the model already works", async () => {
    const { prompter } = createFakePrompter({
      single: (opts) => {
        throw new Error(`Unexpected select: ${opts.message}`);
      },
    });
    const deps = flowDeps({ envFilesByKey: { AI_GATEWAY_API_KEY: ".env.local" } });

    await runLinkFlow({ appRoot: APP_ROOT, prompter, deps });

    expect(prompter.log.message).toHaveBeenCalledWith(
      "This directory is not linked to a Vercel project yet — the model currently runs on credentials from .env.local.",
    );
  });
});
