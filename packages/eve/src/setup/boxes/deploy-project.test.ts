import { describe, expect, it, vi } from "vitest";

import { HumanActionRequiredError } from "#setup/human-action.js";
import type { DeploymentInfo } from "#setup/project-resolution.js";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";

import type { Prompter } from "../prompter.js";
import { createDefaultSetupState, type SetupState } from "../state.js";
import type { OutputSink } from "../step.js";
import { runHeadless, runInteractive } from "../runner.js";
import { deployProject, type DeployProjectDeps } from "./deploy-project.js";

const silentSink: OutputSink = { write: () => {} };

const DEPLOYED: DeploymentInfo = {
  state: "deployed",
  projectId: "prj_demo",
  productionUrl: "https://my-agent.vercel.app",
};

function createPrompter(): Prompter {
  return createFakePrompter().prompter;
}

function createDeps() {
  return {
    runVercel: vi.fn<DeployProjectDeps["runVercel"]>(async () => true),
    detectPackageManager: vi.fn<DeployProjectDeps["detectPackageManager"]>(async () => ({
      kind: "pnpm",
      source: "default",
    })),
    runPackageManagerInstall: vi.fn<DeployProjectDeps["runPackageManagerInstall"]>(
      async () => true,
    ),
    detectDeployment: vi.fn<DeployProjectDeps["detectDeployment"]>(async () => DEPLOYED),
  };
}

/**
 * The deploy box no longer derives `headless` from the gather face: the
 * composition site fixes it. So a headless-path test builds the box with
 * `headless: true` (what onboarding/setup pass on a headless run) and pairs it
 * with `runHeadless`; an interactive test leaves it at the default `false`.
 */
function headlessBox(args: {
  deps: ReturnType<typeof createDeps>;
  prompter?: Prompter;
  skip?: boolean;
}) {
  return deployProject({
    prompter: args.prompter ?? createPrompter(),
    deps: args.deps,
    skip: args.skip,
    headless: true,
  });
}

function pendingState(): SetupState {
  return {
    ...createDefaultSetupState(),
    vercelProject: { kind: "new", project: "my-agent", team: "team" },
    project: { kind: "linked", projectId: "prj_demo" },
    projectPath: { kind: "resolved", inPlace: false, path: "/tmp/project" },
    deploymentPending: true,
  };
}

describe("deployProject box", () => {
  it("installs with the detected project package manager", async () => {
    const deps = createDeps();
    deps.detectPackageManager.mockResolvedValue({
      kind: "yarn",
      source: "package-manager-field",
    });
    const box = headlessBox({ deps });

    await runHeadless([box], pendingState(), silentSink);

    expect(deps.runPackageManagerInstall).toHaveBeenCalledWith(
      "yarn",
      "/tmp/project",
      expect.anything(),
    );
  });

  it("deploys and reuses the up-front project link, never linking again", async () => {
    const deps = createDeps();
    const box = headlessBox({ deps });

    const next = await runHeadless([box], pendingState(), silentSink);

    // The #1020 deadlock fix: the already-linked project is reused instead of
    // triggering a second interactive `vercel link`.
    expect(deps.runVercel).not.toHaveBeenCalledWith(["link"], expect.anything());
    expect(next.project).toEqual({
      kind: "deployed",
      projectId: "prj_demo",
      productionUrl: "https://my-agent.vercel.app",
    });
    expect(next.deploymentPending).toBe(false);
    expect(next.deploymentDependenciesInstalled).toBe(true);
  });

  it("uses Vercel non-interactive confirmation flags when headless", async () => {
    const deps = createDeps();
    const box = headlessBox({ deps });

    await runHeadless([box], pendingState(), silentSink);

    expect(deps.runVercel).toHaveBeenNthCalledWith(
      1,
      ["deploy", "--prod", "--yes", "--non-interactive"],
      expect.objectContaining({ cwd: "/tmp/project", nonInteractive: true }),
    );
  });

  it("deploys with --yes but keeps stdin interactive on an interactive run", async () => {
    const deps = createDeps();
    const box = deployProject({ prompter: createPrompter(), deps });

    await runInteractive([box], pendingState(), silentSink);

    // `--yes` is required even interactively: setup already made the deploy
    // decision, so deploy should not re-open settings confirmation for a fresh
    // project.
    expect(deps.runVercel).toHaveBeenNthCalledWith(
      1,
      ["deploy", "--prod", "--yes"],
      expect.objectContaining({ cwd: "/tmp/project", nonInteractive: false }),
    );
  });

  it("links interactively with NO onOutput when no project resolution exists", async () => {
    const deps = createDeps();
    const box = deployProject({ prompter: createPrompter(), deps });
    const state = pendingState();
    state.project = { kind: "unresolved" };

    const result = await runInteractive([box], state, silentSink);

    // No onOutput key at all: interactive `vercel link` must own the terminal,
    // otherwise its prompt is line-buffered out of view and the CLI hangs on
    // hidden input (the #1020 deadlock).
    expect(deps.runVercel).toHaveBeenNthCalledWith(1, ["link"], { cwd: "/tmp/project" });
    expect(result.kind).toBe("done");
    if (result.kind === "done") {
      expect(result.state.project).toEqual({
        kind: "deployed",
        projectId: "prj_demo",
        productionUrl: "https://my-agent.vercel.app",
      });
    }
  });

  it("installs dependencies after linking and before deploying", async () => {
    const deps = createDeps();
    const box = deployProject({ prompter: createPrompter(), deps });
    const state = pendingState();
    state.project = { kind: "unresolved" };

    await runInteractive([box], state, silentSink);

    const linkOrder = deps.runVercel.mock.invocationCallOrder[0]!;
    const installOrder = deps.runPackageManagerInstall.mock.invocationCallOrder[0]!;
    const deployOrder = deps.runVercel.mock.invocationCallOrder[1]!;
    expect(deps.runVercel.mock.calls[0]?.[0]).toEqual(["link"]);
    expect(deps.runVercel.mock.calls[1]?.[0]).toEqual(["deploy", "--prod", "--yes"]);
    expect(linkOrder).toBeLessThan(installOrder);
    expect(installOrder).toBeLessThan(deployOrder);
  });

  it("throws the vercel-link human action headlessly when no project resolution exists", async () => {
    const deps = createDeps();
    const box = headlessBox({ deps });
    const state = pendingState();
    state.project = { kind: "unresolved" };

    const run = runHeadless([box], state, silentSink);

    await expect(run).rejects.toBeInstanceOf(HumanActionRequiredError);
    await expect(run).rejects.toMatchObject({
      action: {
        kind: "vercel-link",
        command: "vercel link",
        reason: "Deployment needs this directory linked to a Vercel project.",
      },
    });
    expect(deps.runVercel).not.toHaveBeenCalled();
  });

  it("commits the deploy transcript via log.error, then throws, when the deploy fails", async () => {
    const deps = createDeps();
    deps.runVercel.mockImplementation(async (args) => args[0] !== "deploy");
    const prompter = createPrompter();
    const box = headlessBox({ deps, prompter });

    await expect(runHeadless([box], pendingState(), silentSink)).rejects.toThrow(
      "Deployment failed after channel setup.",
    );

    // The rail only flushes the captured `vercel deploy --prod` output on a
    // warning/error, so the failure must report through `error`.
    expect(prompter.log.error).toHaveBeenCalledWith(
      expect.stringContaining("`vercel deploy --prod` failed."),
    );
    // Failure stops the flow before the env pull.
    expect(deps.runVercel).toHaveBeenCalledTimes(1);
  });

  it("keeps a successful deploy successful when the production URL probe is inconclusive", async () => {
    const deps = createDeps();
    deps.detectDeployment.mockResolvedValue({ state: "linked", projectId: "prj_demo" });
    const prompter = createPrompter();
    const box = headlessBox({ deps, prompter });

    const next = await runHeadless([box], pendingState(), silentSink);

    expect(prompter.log.warning).toHaveBeenCalledWith(
      "Deployment succeeded, but eve could not verify its production URL.",
    );
    expect(prompter.log.error).not.toHaveBeenCalled();
    expect(next.project).toEqual({ kind: "linked", projectId: "prj_demo" });
    expect(next.deploymentPending).toBe(false);
  });

  it("surfaces failed dependency installation before any deploy", async () => {
    const deps = createDeps();
    deps.runPackageManagerInstall.mockResolvedValue(false);
    const box = headlessBox({ deps });

    await expect(runHeadless([box], pendingState(), silentSink)).rejects.toThrow(
      "Dependency installation failed. Deployment did not start.",
    );
    expect(deps.runVercel).not.toHaveBeenCalled();
  });

  it("skips the reinstall when dependencies were already installed this run", async () => {
    const deps = createDeps();
    const box = headlessBox({ deps });
    const state = pendingState();
    state.deploymentDependenciesInstalled = true;

    await runHeadless([box], state, silentSink);

    expect(deps.runPackageManagerInstall).not.toHaveBeenCalled();
  });

  it("keeps the production URL visible after contained command output settles", async () => {
    const deps = createDeps();
    const prompter = createPrompter();
    const box = headlessBox({ deps, prompter });

    await runHeadless([box], pendingState(), silentSink);

    expect(prompter.log.info).toHaveBeenCalledWith("Production URL: https://my-agent.vercel.app");
  });

  it("warns when the env pull fails but the deployment succeeded", async () => {
    const deps = createDeps();
    deps.runVercel.mockImplementation(async (args) => args[0] !== "env");
    const prompter = createPrompter();
    const box = headlessBox({ deps, prompter });

    const next = await runHeadless([box], pendingState(), silentSink);

    expect(prompter.log.warning).toHaveBeenCalledWith(
      "Deployment succeeded, but pulling Vercel environment variables did not complete.",
    );
    expect(next.deploymentPending).toBe(false);
  });

  it("is skipped when presetNoDeploy was requested", async () => {
    const deps = createDeps();
    const box = headlessBox({ deps, skip: true });

    await runHeadless([box], pendingState(), silentSink);

    expect(deps.runVercel).not.toHaveBeenCalled();
  });

  it("is skipped when no Vercel project is planned or linked", async () => {
    const deps = createDeps();
    const box = headlessBox({ deps });
    const state = pendingState();
    state.vercelProject = { kind: "none" };
    state.project = { kind: "unresolved" };

    await runHeadless([box], state, silentSink);

    expect(deps.runVercel).not.toHaveBeenCalled();
  });

  it("deploys from a detected project link even without a Vercel plan (in-project setup)", async () => {
    const deps = createDeps();
    const box = headlessBox({ deps });
    const state = pendingState();
    // In-project setup has no onboarding plan; the on-disk link alone gates.
    state.vercelProject = { kind: "none" };

    await runHeadless([box], state, silentSink);

    expect(deps.runVercel).toHaveBeenCalledWith(
      ["deploy", "--prod", "--yes", "--non-interactive"],
      expect.objectContaining({ cwd: "/tmp/project" }),
    );
  });

  it("is skipped when no deployment is pending", async () => {
    const deps = createDeps();
    const box = headlessBox({ deps });
    const state = pendingState();
    state.deploymentPending = false;

    await runHeadless([box], state, silentSink);

    expect(deps.runVercel).not.toHaveBeenCalled();
  });

  it("applies the deploy facts onto a copy, leaving the input state untouched", async () => {
    const deps = createDeps();
    const state = pendingState();
    const box = headlessBox({ deps });

    const next = await runHeadless([box], state, silentSink);

    expect(next.deploymentPending).toBe(false);
    expect(next.project).toEqual({
      kind: "deployed",
      projectId: "prj_demo",
      productionUrl: "https://my-agent.vercel.app",
    });
    expect(state.deploymentPending).toBe(true);
    expect(state.project).toEqual({ kind: "linked", projectId: "prj_demo" });
  });
});
