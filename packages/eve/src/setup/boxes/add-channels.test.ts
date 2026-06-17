import { describe, expect, it, vi } from "vitest";

import { HumanActionRequiredError } from "#setup/human-action.js";
import { normalizeSlackConnectorSlug } from "#setup/scaffold/index.js";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";

import { headlessAsker, interactiveAsker } from "../ask.js";
import type { Prompter } from "../prompter.js";
import { createDefaultSetupState, snapshotSetupState, type SetupState } from "../state.js";
import type { OutputSink } from "../step.js";
import { runHeadless, runInteractive } from "../runner.js";
import { addChannels, type AddChannelsDeps, type AddChannelsOptions } from "./add-channels.js";

const silentSink: OutputSink = { write: () => {} };
const snapshot = { snapshot: snapshotSetupState };
const TEST_EVE_PACKAGE = { version: "latest", nodeEngine: ">=24" } as const;

function createPrompter(): Prompter {
  return createFakePrompter().prompter;
}

/**
 * Builds the box with the ask channel composed the way each composition site
 * does: an interactive base over the test prompter, or the headless base paired
 * with the box's `headless` flag. The slackbot question now travels the asker,
 * so an interactive prompter's `single` handler answers it through
 * {@link interactiveAsker} exactly as the old direct `prompter.select` did.
 */
function makeBox(
  options: Omit<AddChannelsOptions, "asker" | "headless"> & { headless?: boolean },
): ReturnType<typeof addChannels> {
  const headless = options.headless ?? false;
  return addChannels({
    ...options,
    asker: headless ? headlessAsker() : interactiveAsker(options.prompter),
    headless,
  });
}

/** Default fakes: every effect succeeds and the slackbot attaches cleanly. */
function createDeps() {
  return {
    ensureChannel: vi.fn<AddChannelsDeps["ensureChannel"]>(async (options) =>
      options.kind === "web"
        ? {
            kind: "web",
            action: "created",
            filesWritten: ["/tmp/project/app/page.tsx"],
            filesSkipped: [],
            packageJsonUpdated: [],
          }
        : {
            kind: "slack",
            action: "created",
            filesWritten: ["/tmp/project/agent/channels/slack.ts"],
            filesSkipped: [],
            packageJsonUpdated: [],
            slackConnectorSlug: normalizeSlackConnectorSlug("my-agent"),
          },
    ),
    deriveSlackConnectorSlug: vi.fn<AddChannelsDeps["deriveSlackConnectorSlug"]>(
      async (_projectRoot, hint) => normalizeSlackConnectorSlug(hint ?? "my-agent"),
    ),
    provisionSlackbot: vi.fn<AddChannelsDeps["provisionSlackbot"]>(async () => ({
      state: "attached",
      connectorUid: "slack/my-agent",
      chatUrl: "https://slack.com/app_redirect?app=A0&team=T0",
      workspaceName: "Vercel",
    })),
    reconcileSlackUid: vi.fn<AddChannelsDeps["reconcileSlackUid"]>(async () => true),
    detectPackageManager: vi.fn<AddChannelsDeps["detectPackageManager"]>(async () => ({
      kind: "pnpm",
      source: "default",
    })),
    runPackageManagerInstall: vi.fn<AddChannelsDeps["runPackageManagerInstall"]>(async () => true),
    runVercel: vi.fn<AddChannelsDeps["runVercel"]>(async () => true),
    detectDeployment: vi.fn<AddChannelsDeps["detectDeployment"]>(async () => ({
      state: "linked",
      projectId: "prj_demo",
    })),
  };
}

function resolvedState(channelSelection: SetupState["channelSelection"] = ["web"]): SetupState {
  return {
    ...createDefaultSetupState(),
    agentName: "my-agent",
    channelSelection,
    vercelProject: { kind: "new", project: "my-agent", team: "team" },
    project: { kind: "linked", projectId: "prj_demo" },
    projectPath: { kind: "resolved", inPlace: false, path: "/tmp/project" },
  };
}

/** A flow that chose not to deploy to Vercel: no project planned or linked. */
function noVercelState(): SetupState {
  return {
    ...createDefaultSetupState(),
    agentName: "my-agent",
    channelSelection: ["web"],
    projectPath: { kind: "resolved", inPlace: false, path: "/tmp/project" },
  };
}

describe("addChannels box", () => {
  it("rejects Slack headlessly with a plain error before any effect", async () => {
    const deps = createDeps();
    const box = makeBox({
      prompter: createPrompter(),
      evePackage: TEST_EVE_PACKAGE,
      // A preset answer must NOT rescue headless Slack: the Connect create flow
      // opens a browser, so only the guided flow can finish it.
      presetCreateSlackbot: true,
      headless: true,
      deps,
    });

    const run = runHeadless([box], resolvedState(["web", "slack"]), silentSink, snapshot);

    await expect(run).rejects.toThrow(
      "Slack setup is interactive. Run `eve channels add slack` from an interactive terminal.",
    );
    // This is a command-mode mismatch, not a browser action the caller can resume.
    await expect(run).rejects.not.toBeInstanceOf(HumanActionRequiredError);
    expect(deps.ensureChannel).not.toHaveBeenCalled();
    expect(deps.provisionSlackbot).not.toHaveBeenCalled();
  });

  it("passes the web scaffold options through to ensureChannel", async () => {
    const deps = createDeps();
    deps.detectPackageManager.mockResolvedValue({
      kind: "npm",
      source: "package-manager-field",
    });
    const box = makeBox({ prompter: createPrompter(), evePackage: TEST_EVE_PACKAGE, deps });

    await runHeadless([box], resolvedState(), silentSink, snapshot);

    expect(deps.ensureChannel).toHaveBeenCalledWith({
      projectRoot: "/tmp/project",
      kind: "web",
      packageManager: "npm",
      force: undefined,
      webPackageVersions: { evePackage: TEST_EVE_PACKAGE },
      configureVercelServices: true,
    });
    expect(deps.runPackageManagerInstall).toHaveBeenCalledWith(
      "npm",
      "/tmp/project",
      expect.anything(),
    );
  });

  it("scaffolds Web Chat without Vercel Services config when not deploying to Vercel", async () => {
    const deps = createDeps();
    const box = makeBox({ prompter: createPrompter(), evePackage: TEST_EVE_PACKAGE, deps });

    const next = await runHeadless([box], noVercelState(), silentSink, snapshot);

    expect(deps.ensureChannel).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "web", configureVercelServices: false }),
    );
    expect(next.channels).toEqual(["web"]);
    expect(next.webScaffolded).toBe(true);
    expect(next.deploymentPending).toBe(true);
  });

  it("installs dependencies after recording channels and marks the deploy install done", async () => {
    const deps = createDeps();
    const box = makeBox({ prompter: createPrompter(), evePackage: TEST_EVE_PACKAGE, deps });

    const next = await runHeadless([box], resolvedState(), silentSink, snapshot);

    expect(deps.runPackageManagerInstall).toHaveBeenCalledExactlyOnceWith("pnpm", "/tmp/project", {
      onOutput: expect.any(Function),
    });
    expect(next.channels).toEqual(["web"]);
    expect(next.deploymentDependenciesInstalled).toBe(true);
  });

  it("keeps channels recorded when the install fails, leaving the deploy install pending", async () => {
    const deps = createDeps();
    deps.runPackageManagerInstall.mockResolvedValueOnce(false);
    const prompter = createPrompter();
    const box = makeBox({ prompter, evePackage: TEST_EVE_PACKAGE, deps });

    // An earlier success must go stale: the scaffold just changed package.json.
    const next = await runHeadless(
      [box],
      { ...resolvedState(), deploymentDependenciesInstalled: true },
      silentSink,
      snapshot,
    );

    expect(prompter.log.warning).toHaveBeenCalledWith(
      "Dependency installation failed. The new channels stay unloadable until `pnpm install` or a deploy succeeds.",
    );
    expect(next.channels).toEqual(["web"]);
    expect(next.deploymentPending).toBe(true);
    expect(next.deploymentDependenciesInstalled).toBe(false);
  });

  it("skips the install when no channel was recorded", async () => {
    const deps = createDeps();
    deps.ensureChannel.mockResolvedValueOnce({
      kind: "web",
      action: "skipped",
      skipReason: "nextjs-project",
      filesWritten: [],
      filesSkipped: ["/tmp/project/package.json"],
      packageJsonUpdated: [],
    });
    const box = makeBox({ prompter: createPrompter(), evePackage: TEST_EVE_PACKAGE, deps });

    const next = await runHeadless(
      [box],
      { ...resolvedState(), deploymentDependenciesInstalled: true },
      silentSink,
      snapshot,
    );

    expect(deps.runPackageManagerInstall).not.toHaveBeenCalled();
    // Nothing recorded, nothing installed: the earlier install stays valid.
    expect(next.deploymentDependenciesInstalled).toBe(true);
  });

  it("honors the configureVercelServices override over the Vercel-project gate", async () => {
    const deps = createDeps();
    // `eve channels add` pins the services config on even when unlinked, the
    // behavior the dissolved engine had (ensureChannel defaulted it to true).
    const box = makeBox({
      prompter: createPrompter(),
      evePackage: TEST_EVE_PACKAGE,
      configureVercelServices: true,
      deps,
    });

    await runHeadless([box], noVercelState(), silentSink, snapshot);

    expect(deps.ensureChannel).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "web", configureVercelServices: true }),
    );
  });

  it("omits webPackageVersions entirely when no evePackage is set", async () => {
    const deps = createDeps();
    const box = makeBox({ prompter: createPrompter(), deps });

    await runHeadless([box], resolvedState(), silentSink, snapshot);

    const [ensureOptions] = deps.ensureChannel.mock.calls[0]!;
    // The key must be absent, not undefined-valued: ensureChannel resolves its
    // build-stamped defaults only from a missing webPackageVersions input.
    expect("webPackageVersions" in ensureOptions).toBe(false);
  });

  it("threads force to both channel scaffolds", async () => {
    const deps = createDeps();
    const box = makeBox({
      prompter: createPrompter(),
      presetCreateSlackbot: true,
      force: true,
      deps,
    });

    const result = await runInteractive(
      [box],
      resolvedState(["web", "slack"]),
      silentSink,
      snapshot,
    );

    expect(deps.ensureChannel).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "web", force: true }),
    );
    expect(deps.ensureChannel).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "slack", force: true }),
    );
    expect(result.kind).toBe("done");
  });

  it("warns for overwritten files, an overridden node engine, and competing Next.js configs", async () => {
    const deps = createDeps();
    deps.ensureChannel.mockResolvedValueOnce({
      kind: "web",
      action: "overwritten",
      filesWritten: ["/tmp/project/app/page.tsx"],
      filesOverwritten: ["/tmp/project/app/page.tsx"],
      nodeEngineOverride: { previous: "22.x", next: "24.x" },
      competingNextConfigFiles: ["/tmp/project/next.config.mjs"],
      filesSkipped: [],
      packageJsonUpdated: [],
    });
    const prompter = createPrompter();
    const box = makeBox({ prompter, evePackage: TEST_EVE_PACKAGE, force: true, deps });

    await runHeadless([box], resolvedState(), silentSink, snapshot);

    expect(prompter.log.warning).toHaveBeenCalledWith("Overwrote /tmp/project/app/page.tsx");
    expect(prompter.log.warning).toHaveBeenCalledWith(
      'Overrode package.json engines.node from "22.x" to "24.x" because the previous value was not confined to the Node.js major selected by eve.',
    );
    expect(prompter.log.warning).toHaveBeenCalledWith(
      "Found competing Next.js config at /tmp/project/next.config.mjs; merge any needed settings into next.config.ts and remove it before starting the preview, or Next.js may ignore the generated eve rewrite.",
    );
  });

  it("no-ops cleanly on an empty channel selection", async () => {
    const deps = createDeps();
    // The fake prompter throws on any prompt, so reaching the end also proves
    // the slackbot question is not asked for an empty selection.
    const box = makeBox({ prompter: createPrompter(), evePackage: TEST_EVE_PACKAGE, deps });

    const next = await runInteractive([box], resolvedState([]), silentSink, snapshot);

    expect(deps.ensureChannel).not.toHaveBeenCalled();
    expect(deps.provisionSlackbot).not.toHaveBeenCalled();
    expect(next.kind).toBe("done");
    if (next.kind === "done") {
      expect(next.state.channels).toEqual([]);
      expect(next.state.deploymentPending).toBe(false);
    }
  });

  it("links an unresolved project before provisioning when the link seam is set", async () => {
    const deps = createDeps();
    const state = resolvedState(["slack"]);
    state.project = { kind: "unresolved" };
    state.vercelProject = { kind: "none" };
    const box = makeBox({
      prompter: createPrompter(),
      presetCreateSlackbot: true,
      ensureLinkedProject: "interactive-vercel-link",
      deps,
    });

    const result = await runInteractive([box], state, silentSink, snapshot);

    // The engine's exact fallback: a bare interactive `vercel link` with NO
    // onOutput, then a fresh deployment detection.
    expect(deps.runVercel).toHaveBeenCalledWith(["link"], { cwd: "/tmp/project" });
    expect(deps.runVercel.mock.invocationCallOrder[0]).toBeLessThan(
      deps.provisionSlackbot.mock.invocationCallOrder[0]!,
    );
    expect(deps.detectDeployment).toHaveBeenCalledWith("/tmp/project", { signal: undefined });
    expect(result.kind).toBe("done");
    if (result.kind === "done") {
      expect(result.state.project).toEqual({ kind: "linked", projectId: "prj_demo" });
      expect(result.state.channels).toEqual(["slack"]);
    }
  });

  it("skips the link fallback when the slackbot is declined", async () => {
    const deps = createDeps();
    const state = resolvedState(["slack"]);
    state.project = { kind: "unresolved" };
    state.vercelProject = { kind: "none" };
    const prompter = createFakePrompter({ single: () => "no" }).prompter;
    const box = makeBox({
      prompter,
      ensureLinkedProject: "interactive-vercel-link",
      deps,
    });

    const result = await runInteractive([box], state, silentSink, snapshot);

    expect(deps.runVercel).not.toHaveBeenCalled();
    expect(deps.provisionSlackbot).not.toHaveBeenCalled();
    expect(prompter.log.info).toHaveBeenCalledWith(
      "Slack channel was not added because Slackbot setup was skipped.",
    );
    expect(result.kind).toBe("done");
  });

  it("fails the link fallback with the engine's copy when `vercel link` fails", async () => {
    const deps = createDeps();
    deps.runVercel.mockResolvedValue(false);
    const state = resolvedState(["slack"]);
    state.project = { kind: "unresolved" };
    state.vercelProject = { kind: "none" };
    const box = makeBox({
      prompter: createPrompter(),
      presetCreateSlackbot: true,
      ensureLinkedProject: "interactive-vercel-link",
      deps,
    });

    await expect(runInteractive([box], state, silentSink, snapshot)).rejects.toThrow(
      "Vercel project linking failed. Slackbot creation did not start.",
    );
    expect(deps.provisionSlackbot).not.toHaveBeenCalled();
  });

  it("scaffolds the exact connector UID without a second patch step", async () => {
    const deps = createDeps();
    deps.provisionSlackbot.mockResolvedValue({
      state: "attached",
      connectorUid: "slack/my-agent-2",
      chatUrl: "https://slack.com/app_redirect?app=A0&team=T0",
      workspaceName: "Vercel",
    });
    const prompter = createFakePrompter({ single: () => "yes" }).prompter;
    const box = makeBox({ prompter, evePackage: TEST_EVE_PACKAGE, deps });

    const result = await runInteractive([box], resolvedState(["slack"]), silentSink, snapshot);

    expect(deps.provisionSlackbot.mock.invocationCallOrder[0]).toBeLessThan(
      deps.ensureChannel.mock.invocationCallOrder[0]!,
    );
    expect(deps.ensureChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "slack",
        slackConnectorUid: "slack/my-agent-2",
        slackConnectorSlug: "my-agent",
      }),
    );
    expect(deps.reconcileSlackUid).not.toHaveBeenCalled();
    expect(result.kind).toBe("done");
    if (result.kind === "done") {
      expect(result.state.channels).toEqual(["slack"]);
      expect(result.state.slackbotCreated).toBe(true);
      expect(result.state.slackbotAttached).toBe(true);
      expect(result.state.slackConnectorUid).toBe("slack/my-agent-2");
      expect(result.state.slackChatUrl).toBe("https://slack.com/app_redirect?app=A0&team=T0");
      expect(result.state.slackWorkspaceName).toBe("Vercel");
      expect(result.state.deploymentPending).toBe(true);
    }
  });

  it("asks the slackbot question only when Slack is selected and undecided", async () => {
    const deps = createDeps();
    const fake = createFakePrompter({ single: () => "no" });
    const box = makeBox({ prompter: fake.prompter, evePackage: TEST_EVE_PACKAGE, deps });

    const result = await runInteractive([box], resolvedState(["slack"]), silentSink, snapshot);

    expect(fake.selectMessages).toEqual(["Do you want to create your slackbot?"]);
    expect(deps.provisionSlackbot).not.toHaveBeenCalled();
    expect(deps.ensureChannel).not.toHaveBeenCalled();
    expect(fake.prompter.log.info).toHaveBeenCalledWith(
      "Slack channel was not added because Slackbot setup was skipped.",
    );
    expect(result.kind).toBe("done");
    if (result.kind === "done") {
      expect(result.state.channels).toEqual([]);
      expect(result.state.deploymentPending).toBe(false);
    }
  });

  it("does not prompt when the slackbot decision is preset", async () => {
    const deps = createDeps();
    // The fake prompter throws on any unconfigured prompt, so reaching the end
    // proves no question was asked.
    const fake = createFakePrompter();
    const box = makeBox({
      prompter: fake.prompter,
      evePackage: TEST_EVE_PACKAGE,
      presetCreateSlackbot: true,
      deps,
    });

    const result = await runInteractive([box], resolvedState(["slack"]), silentSink, snapshot);

    expect(fake.selectMessages).toEqual([]);
    expect(deps.provisionSlackbot).toHaveBeenCalledOnce();
    expect(result.kind).toBe("done");
  });

  it("passes concurrent retry controls separately from the setup log", async () => {
    const deps = createDeps();
    const awaitChoice = vi.fn(() => ({
      choice: Promise.resolve(undefined),
      close: vi.fn(),
    }));
    const prompter = { ...createPrompter(), awaitChoice };
    const box = makeBox({
      prompter,
      presetCreateSlackbot: true,
      deps,
    });

    await runInteractive([box], resolvedState(["slack"]), silentSink, snapshot);

    expect(deps.provisionSlackbot).toHaveBeenCalledWith(
      prompter.log,
      "/tmp/project",
      "my-agent",
      undefined,
      { awaitChoice },
    );
    expect("awaitChoice" in prompter.log).toBe(false);
  });

  it("still scaffolds Web Chat when the slackbot is skipped", async () => {
    const deps = createDeps();
    const prompter = createFakePrompter({ single: () => "no" }).prompter;
    const box = makeBox({ prompter, evePackage: TEST_EVE_PACKAGE, deps });

    const result = await runInteractive(
      [box],
      resolvedState(["web", "slack"]),
      silentSink,
      snapshot,
    );

    expect(deps.ensureChannel).toHaveBeenCalledTimes(1);
    expect(deps.ensureChannel).toHaveBeenCalledWith(expect.objectContaining({ kind: "web" }));
    expect(deps.provisionSlackbot).not.toHaveBeenCalled();
    expect(result.kind).toBe("done");
    if (result.kind === "done") {
      expect(result.state.channels).toEqual(["web"]);
      expect(result.state.deploymentPending).toBe(true);
    }
  });

  it("records nothing for web when a Next.js project skips the scaffold", async () => {
    const deps = createDeps();
    deps.ensureChannel.mockResolvedValueOnce({
      kind: "web",
      action: "skipped",
      skipReason: "nextjs-project",
      filesWritten: [],
      filesSkipped: ["/tmp/project/package.json"],
      packageJsonUpdated: [],
    });
    const prompter = createPrompter();
    const box = makeBox({ prompter, evePackage: TEST_EVE_PACKAGE, deps });

    const next = await runHeadless([box], resolvedState(), silentSink, snapshot);

    expect(prompter.log.info).toHaveBeenCalledWith(
      "Next.js project detected. Skipping Web Chat scaffolding.",
    );
    // The deliberate asymmetry: a skipped Web scaffold is NOT recorded, so it
    // cannot arm a deploy; a skipped Slack file write still records the channel.
    expect(next.channels).toEqual([]);
    expect(next.webScaffolded).toBe(false);
    expect(next.deploymentPending).toBe(false);
  });

  it("continues without Slack when creation fails under warn-and-continue", async () => {
    const deps = createDeps();
    deps.provisionSlackbot.mockResolvedValue({
      state: "create-failed",
    });
    const prompter = createFakePrompter({ single: () => "yes" }).prompter;
    const box = makeBox({
      prompter,
      evePackage: TEST_EVE_PACKAGE,
      presetCreateSlackbot: true,
      slackbotFailure: "warn-and-continue",
      deps,
    });

    const result = await runInteractive(
      [box],
      resolvedState(["web", "slack"]),
      silentSink,
      snapshot,
    );

    expect(result.kind).toBe("done");
    if (result.kind !== "done") return;
    // Web survives; Slack records nothing, so a later add starts clean.
    expect(result.state.channels).toEqual(["web"]);
    expect(result.state.slackScaffolded).toBe(false);
    expect(result.state.slackbotCreated).toBe(false);
    expect(prompter.log.warning).toHaveBeenCalledWith(
      "Slackbot creation failed. Continuing without Slack — add it later with `eve channels add slack`.",
    );
    // The slack channel scaffold never ran (only web's).
    expect(deps.ensureChannel).toHaveBeenCalledTimes(1);
    expect(deps.reconcileSlackUid).not.toHaveBeenCalled();
  });

  it("folds a cancelled Slack connection attempt without logging an error", async () => {
    const deps = createDeps();
    deps.provisionSlackbot.mockResolvedValue({
      state: "cancelled",
    });
    const prompter = createPrompter();
    const box = makeBox({
      prompter,
      presetCreateSlackbot: true,
      deps,
    });

    const result = await runInteractive([box], resolvedState(["slack"]), silentSink, snapshot);

    expect(result).toEqual({ kind: "cancelled" });
    expect(prompter.log.error).not.toHaveBeenCalled();
    expect(deps.ensureChannel).not.toHaveBeenCalled();
  });

  it("surfaces connector cleanup failure instead of claiming the attempt was cleaned up", async () => {
    const deps = createDeps();
    deps.provisionSlackbot.mockResolvedValue({
      state: "cleanup-failed",
      connectorUids: ["slack/my-agent"],
    });
    const prompter = createPrompter();
    const box = makeBox({
      prompter,
      presetCreateSlackbot: true,
      deps,
    });

    await expect(
      runInteractive([box], resolvedState(["slack"]), silentSink, snapshot),
    ).rejects.toThrow(
      "The abandoned Slack connector could not be removed. Slack channel was not added.",
    );
    expect(prompter.log.error).toHaveBeenCalledWith(
      "The abandoned Slack connector could not be removed. Slack channel was not added.",
    );
    expect(deps.ensureChannel).not.toHaveBeenCalled();
  });

  it("continues without Slack when attachment fails under warn-and-continue", async () => {
    const deps = createDeps();
    deps.provisionSlackbot.mockResolvedValue({
      state: "attach-failed",
      connectorUid: "slack/my-agent",
    });
    const prompter = createFakePrompter({ single: () => "yes" }).prompter;
    const box = makeBox({
      prompter,
      evePackage: TEST_EVE_PACKAGE,
      presetCreateSlackbot: true,
      slackbotFailure: "warn-and-continue",
      deps,
    });

    const result = await runInteractive([box], resolvedState(["slack"]), silentSink, snapshot);

    expect(result.kind).toBe("done");
    if (result.kind !== "done") return;
    expect(result.state.channels).toEqual([]);
    expect(result.state.slackbotCreated).toBe(false);
    // Not "eve channels add slack": re-creating would orphan the connector
    // that already exists; the attach remediation was printed by the provision.
    expect(prompter.log.warning).toHaveBeenCalledWith(
      "Slackbot provisioning did not attach this project. Slack channel was not added. Continuing without Slack — finish event delivery with the `vercel connect attach` command above.",
    );
  });

  it("continues without Slack when detach fails under warn-and-continue", async () => {
    const deps = createDeps();
    deps.provisionSlackbot.mockResolvedValue({
      state: "detach-failed",
      connectorUid: "slack/my-agent",
    });
    const prompter = createFakePrompter({ single: () => "yes" }).prompter;
    const box = makeBox({
      prompter,
      evePackage: TEST_EVE_PACKAGE,
      presetCreateSlackbot: true,
      slackbotFailure: "warn-and-continue",
      deps,
    });

    const result = await runInteractive([box], resolvedState(["slack"]), silentSink, snapshot);

    expect(result.kind).toBe("done");
    if (result.kind !== "done") return;
    expect(result.state.channels).toEqual([]);
    expect(result.state.slackbotCreated).toBe(false);
    expect(prompter.log.warning).toHaveBeenCalledWith(
      "Slackbot provisioning could not replace the existing trigger destination. Slack channel was not added. Continuing without Slack — run the `vercel connect detach` and `vercel connect attach` commands above.",
    );
  });

  it("does not scaffold when the Slackbot has no workspace installation", async () => {
    const deps = createDeps();
    deps.provisionSlackbot.mockResolvedValue({
      state: "not-installed",
    });
    const state = resolvedState(["slack"]);
    const box = makeBox({
      prompter: createPrompter(),
      evePackage: TEST_EVE_PACKAGE,
      presetCreateSlackbot: true,
      deps,
    });

    await expect(runInteractive([box], state, silentSink, snapshot)).rejects.toThrow(
      "Slackbot is not connected to a Slack workspace. Slack channel was not added.",
    );

    // The whole point: no channel files land without a successful connection.
    expect(deps.ensureChannel).not.toHaveBeenCalled();
    expect(state.channels).toEqual([]);
    expect(state.slackScaffolded).toBe(false);
  });

  it("continues without Slack when the workspace install is missing under warn-and-continue", async () => {
    const deps = createDeps();
    deps.provisionSlackbot.mockResolvedValue({
      state: "not-installed",
    });
    const prompter = createFakePrompter({ single: () => "yes" }).prompter;
    const box = makeBox({
      prompter,
      evePackage: TEST_EVE_PACKAGE,
      presetCreateSlackbot: true,
      slackbotFailure: "warn-and-continue",
      deps,
    });

    const result = await runInteractive([box], resolvedState(["slack"]), silentSink, snapshot);

    expect(result.kind).toBe("done");
    if (result.kind !== "done") return;
    expect(result.state.channels).toEqual([]);
    expect(result.state.slackScaffolded).toBe(false);
    expect(prompter.log.warning).toHaveBeenCalledWith(
      "Slackbot is not connected to a Slack workspace. Slack channel was not added. Continuing without Slack — the install timed out and was cleaned up; re-run `eve channels add slack` to try again.",
    );
  });

  it("does not misreport an installation lookup failure as an unfinished browser install", async () => {
    const deps = createDeps();
    deps.provisionSlackbot.mockResolvedValue({
      state: "installation-check-failed",
      connectorUid: "slack/my-agent",
    });
    const box = makeBox({
      prompter: createPrompter(),
      evePackage: TEST_EVE_PACKAGE,
      presetCreateSlackbot: true,
      deps,
    });

    await expect(
      runInteractive([box], resolvedState(["slack"]), silentSink, snapshot),
    ).rejects.toThrow(
      "Slack workspace installation could not be verified. Slack channel was not added.",
    );
    expect(deps.ensureChannel).not.toHaveBeenCalled();
  });

  it("does not create or scaffold when existing connectors cannot be inspected", async () => {
    const deps = createDeps();
    deps.provisionSlackbot.mockResolvedValue({
      state: "connector-lookup-failed",
    });
    const box = makeBox({
      prompter: createPrompter(),
      evePackage: TEST_EVE_PACKAGE,
      presetCreateSlackbot: true,
      deps,
    });

    await expect(
      runInteractive([box], resolvedState(["slack"]), silentSink, snapshot),
    ).rejects.toThrow(
      "Existing Slack connectors could not be inspected. Slack channel was not added.",
    );
    expect(deps.ensureChannel).not.toHaveBeenCalled();
  });

  it("records nothing when Connect attachment fails, so a retry restarts cleanly", async () => {
    const deps = createDeps();
    deps.provisionSlackbot.mockResolvedValue({
      state: "attach-failed",
      connectorUid: "slack/my-agent",
    });
    const state = resolvedState(["slack"]);
    const box = makeBox({
      prompter: createPrompter(),
      evePackage: TEST_EVE_PACKAGE,
      presetCreateSlackbot: true,
      deps,
    });

    await expect(runInteractive([box], state, silentSink, snapshot)).rejects.toThrow(
      "Slackbot provisioning did not attach this project. Slack channel was not added.",
    );

    expect(deps.ensureChannel).not.toHaveBeenCalled();
    expect(state.channels).toEqual([]);
    expect(state.slackbotCreated).toBe(false);
    expect(state.slackScaffolded).toBe(false);
  });

  it("reports a pre-existing connector without an installation as manual recovery", async () => {
    const deps = createDeps();
    deps.provisionSlackbot.mockResolvedValue({
      state: "existing-not-installed",
      connectorUid: "slack/my-agent",
    });
    const state = resolvedState(["slack"]);
    const box = makeBox({
      prompter: createPrompter(),
      evePackage: TEST_EVE_PACKAGE,
      presetCreateSlackbot: true,
      deps,
    });

    await expect(runInteractive([box], state, silentSink, snapshot)).rejects.toThrow(
      "The existing Slack connector is not connected to a Slack workspace. Slack channel was not added.",
    );
    expect(deps.ensureChannel).not.toHaveBeenCalled();
  });

  it("surfaces a failed connector UID reconciliation and records no channel", async () => {
    const deps = createDeps();
    deps.ensureChannel.mockResolvedValue({
      kind: "slack",
      action: "skipped",
      filesWritten: [],
      filesSkipped: ["/tmp/project/agent/channels/slack.ts"],
      packageJsonUpdated: [],
    });
    deps.reconcileSlackUid.mockResolvedValue(false);
    const state = resolvedState(["slack"]);
    const box = makeBox({
      prompter: createPrompter(),
      evePackage: TEST_EVE_PACKAGE,
      presetCreateSlackbot: true,
      deps,
    });

    await expect(runInteractive([box], state, silentSink, snapshot)).rejects.toThrow(
      "Slack connector UID update is required before deployment.",
    );
    expect(state.channels).toEqual([]);
    expect(state.slackbotCreated).toBe(false);
  });

  it("reuses an attached slackbot on rerun and scaffolds its exact UID", async () => {
    const deps = createDeps();
    const state: SetupState = {
      ...resolvedState(["slack"]),
      slackbotCreated: true,
      slackbotAttached: true,
      slackConnectorUid: "slack/my-agent",
      deploymentPending: true,
    };
    const box = makeBox({
      prompter: createPrompter(),
      evePackage: TEST_EVE_PACKAGE,
      presetCreateSlackbot: true,
      deps,
    });

    const result = await runInteractive([box], state, silentSink, snapshot);

    expect(deps.provisionSlackbot).not.toHaveBeenCalled();
    expect(deps.ensureChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "slack",
        slackConnectorUid: "slack/my-agent",
        slackConnectorSlug: "my-agent",
      }),
    );
    expect(deps.reconcileSlackUid).not.toHaveBeenCalled();
    expect(result.kind).toBe("done");
    if (result.kind === "done") {
      expect(result.state.channels).toEqual(["slack"]);
    }
  });

  it("throws on rerun when the recorded slackbot never attached", async () => {
    const deps = createDeps();
    const state: SetupState = {
      ...resolvedState(["slack"]),
      slackbotCreated: true,
      slackbotAttached: false,
    };
    const box = makeBox({
      prompter: createPrompter(),
      evePackage: TEST_EVE_PACKAGE,
      presetCreateSlackbot: true,
      deps,
    });

    await expect(runInteractive([box], state, silentSink, snapshot)).rejects.toThrow(
      "Slackbot provisioning did not attach this project. Slack channel was not added.",
    );
    expect(deps.provisionSlackbot).not.toHaveBeenCalled();
  });

  it("throws when Slack is selected without a Vercel project", async () => {
    const deps = createDeps();
    const state: SetupState = { ...noVercelState(), channelSelection: ["slack"] };
    const box = makeBox({
      prompter: createPrompter(),
      evePackage: TEST_EVE_PACKAGE,
      presetCreateSlackbot: true,
      deps,
    });

    await expect(runInteractive([box], state, silentSink, snapshot)).rejects.toThrow(
      /Slack requires a Vercel project/,
    );
    expect(deps.provisionSlackbot).not.toHaveBeenCalled();
  });

  it("throws when the project resolution is missing while deploying to Vercel", async () => {
    const deps = createDeps();
    const state = resolvedState(["slack"]);
    // project stays unresolved: the link box did not record a resolution.
    state.project = { kind: "unresolved" };
    const box = makeBox({
      prompter: createPrompter(),
      evePackage: TEST_EVE_PACKAGE,
      presetCreateSlackbot: true,
      deps,
    });

    await expect(runInteractive([box], state, silentSink, snapshot)).rejects.toThrow(
      /none was resolved/,
    );
    expect(deps.provisionSlackbot).not.toHaveBeenCalled();
  });

  it("logs the one-line error through the rail before rethrowing", async () => {
    const deps = createDeps();
    deps.ensureChannel.mockRejectedValueOnce(new Error("disk full\nlong stack detail"));
    const prompter = createPrompter();
    const box = makeBox({ prompter, evePackage: TEST_EVE_PACKAGE, deps });

    await expect(runHeadless([box], resolvedState(), silentSink, snapshot)).rejects.toThrow(
      "disk full",
    );
    expect(prompter.log.error).toHaveBeenCalledWith("disk full");
  });

  it("applies the payload onto a copy, leaving the input state untouched", async () => {
    const deps = createDeps();
    const state = resolvedState();
    const box = makeBox({ prompter: createPrompter(), evePackage: TEST_EVE_PACKAGE, deps });

    const next = await runHeadless([box], state, silentSink, snapshot);

    expect(next.channels).toEqual(["web"]);
    expect(next.webScaffolded).toBe(true);
    expect(next.deploymentPending).toBe(true);
    expect(state.channels).toEqual([]);
    expect(state.webScaffolded).toBe(false);
  });
});
