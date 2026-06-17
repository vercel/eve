import {
  deriveSlackConnectorSlug,
  ensureChannel,
  type ChannelKind,
  type EnsureChannelOptions,
  type EvePackageContract,
  type SlackConnectorSlug,
} from "#setup/scaffold/index.js";
import { HumanActionRequiredError } from "#setup/human-action.js";
import { createPromptCommandOutput, withPhase, type ChannelSetupLog } from "#setup/cli/index.js";
import { detectPackageManager, type PackageManagerKind } from "#setup/package-manager.js";
import { formatNodeEngineOverrideWarning } from "#setup/node-engine.js";
import { runPackageManagerInstall } from "#setup/primitives/pm/run.js";
import { runVercel } from "#setup/primitives/run-vercel.js";

import {
  detectDeployment,
  isProjectResolved,
  mergeProjectResolution,
  projectResolutionFromDeployment,
  type ProjectResolution,
} from "../project-resolution.js";
import { confirm, SkippedSignal, type Asker } from "../ask.js";
import type { Prompter } from "../prompter.js";
import {
  provisionSlackbot,
  reconcileSlackUid,
  type ProvisionSlackbotOptions,
  type ProvisionSlackbotResult,
} from "../slackbot.js";
import { hasVercelProject, requireProjectPath, type SetupState } from "../state.js";
import { WizardCancelledError, type SetupBox } from "../step.js";

const SLACK_REQUIRES_VERCEL =
  "Slack requires a Vercel project. Re-run and choose to deploy to Vercel to add Slack.";

const SLACK_HEADLESS_ERROR =
  "Slack setup is interactive. Run `eve channels add slack` from an interactive terminal.";

const SLACKBOT_NOT_ATTACHED_ERROR =
  "Slackbot provisioning did not attach this project. Slack channel was not added.";

const SLACKBOT_NOT_DETACHED_ERROR =
  "Slackbot provisioning could not replace the existing trigger destination. Slack channel was not added.";

const SLACKBOT_EXISTING_NOT_INSTALLED_ERROR =
  "The existing Slack connector is not connected to a Slack workspace. Slack channel was not added.";

const SLACKBOT_NOT_INSTALLED_ERROR =
  "Slackbot is not connected to a Slack workspace. Slack channel was not added.";

const SLACKBOT_LOOKUP_FAILED_ERROR =
  "Existing Slack connectors could not be inspected. Slack channel was not added.";

const SLACKBOT_INSTALLATION_CHECK_FAILED_ERROR =
  "Slack workspace installation could not be verified. Slack channel was not added.";

const SLACKBOT_CLEANUP_FAILED_ERROR =
  "The abandoned Slack connector could not be removed. Slack channel was not added.";

type SlackbotFailure = Exclude<
  ProvisionSlackbotResult,
  { state: "attached" } | { state: "cancelled" }
>;

interface SlackbotFailureCopy {
  reason: string;
  followUp: string;
}

function slackbotFailureCopy(result: SlackbotFailure): SlackbotFailureCopy {
  switch (result.state) {
    case "not-installed":
      return {
        reason: SLACKBOT_NOT_INSTALLED_ERROR,
        followUp:
          "Continuing without Slack — the install timed out and was cleaned up; re-run `eve channels add slack` to try again.",
      };
    case "cleanup-failed":
      return {
        reason: SLACKBOT_CLEANUP_FAILED_ERROR,
        followUp:
          "Continuing without Slack — resolve the cleanup warning above before trying again.",
      };
    case "connector-lookup-failed":
      return {
        reason: SLACKBOT_LOOKUP_FAILED_ERROR,
        followUp:
          "Continuing without Slack — restore Vercel CLI access, then re-run `eve channels add slack`.",
      };
    case "installation-check-failed":
      return {
        reason: SLACKBOT_INSTALLATION_CHECK_FAILED_ERROR,
        followUp:
          "Continuing without Slack — verify Vercel Connect is reachable, then re-run `eve channels add slack`.",
      };
    case "existing-not-installed":
      return {
        reason: SLACKBOT_EXISTING_NOT_INSTALLED_ERROR,
        followUp:
          "Continuing without Slack — resolve the existing connector warning above before trying again.",
      };
    case "detach-failed":
      return {
        reason: SLACKBOT_NOT_DETACHED_ERROR,
        followUp:
          "Continuing without Slack — run the `vercel connect detach` and `vercel connect attach` commands above.",
      };
    case "attach-failed":
      return {
        reason: SLACKBOT_NOT_ATTACHED_ERROR,
        followUp:
          "Continuing without Slack — finish event delivery with the `vercel connect attach` command above.",
      };
    case "create-failed":
      return {
        reason: "Slackbot creation failed.",
        followUp: "Continuing without Slack — add it later with `eve channels add slack`.",
      };
  }
}

/** Injected for tests; defaults to the real scaffold, Connect, and Vercel effects. */
export interface AddChannelsDeps {
  ensureChannel: typeof ensureChannel;
  deriveSlackConnectorSlug: typeof deriveSlackConnectorSlug;
  provisionSlackbot: typeof provisionSlackbot;
  reconcileSlackUid: typeof reconcileSlackUid;
  detectPackageManager: typeof detectPackageManager;
  runPackageManagerInstall: typeof runPackageManagerInstall;
  runVercel: typeof runVercel;
  detectDeployment: typeof detectDeployment;
}

export interface AddChannelsOptions {
  /** Resolves the slackbot question; the composed stack decides how. */
  asker: Asker;
  /**
   * Logs through `prompter.log` in `perform`, and owns the interactive
   * `vercel link` fallback. The slackbot question itself now travels the asker,
   * not this prompter.
   */
  prompter: Prompter;
  /**
   * Headless mode: gates the interactive `vercel link` fallback inside `perform`
   * and refuses Slack up front. Fixed at composition time (the same place the
   * asker base is chosen), since `gather` cannot read the mode off the asker.
   */
  headless?: boolean;
  /**
   * eve package metadata for the scaffolded web `package.json`. When omitted,
   * every package value comes from the build-stamped defaults.
   */
  evePackage?: EvePackageContract;
  /** Skip the "Create slackbot?" prompt and use this answer. */
  presetCreateSlackbot?: boolean;
  /** Overwrite existing channel files (`eve channels add --force`). */
  force?: boolean;
  /**
   * Override for the web scaffold's Vercel services config. Defaults to
   * `hasVercelProject(state)`; `eve channels add` pins it to true so an
   * unlinked directory still gets the config, matching the dissolved engine.
   */
  configureVercelServices?: boolean;
  /**
   * Opt-in fallback when Slack is chosen interactively but `state.project` is
   * unresolved: run the interactive bare `vercel link` before provisioning the
   * slackbot. Only the `eve channels add` composition sets this; onboarding
   * resolves the project up front via the link box and keeps the hard gate.
   */
  ensureLinkedProject?: "interactive-vercel-link";
  /**
   * What a failed slackbot provision (create or attach) does to the run. The
   * default, "abort", fails the whole box — right for `eve channels add slack`,
   * where Slack is the point. Onboarding passes "warn-and-continue": the agent
   * still scaffolds, deploys, and chats without Slack (recorded as nothing, so
   * a later `eve channels add slack` starts clean).
   */
  slackbotFailure?: "abort" | "warn-and-continue";
  deps?: AddChannelsDeps;
}

/**
 * What the user (or the preset) decided before `perform` runs effects.
 * `createSlackbot` is only consulted when Slack is in the channel selection.
 */
export interface AddChannelsInput {
  headless: boolean;
  createSlackbot: boolean | undefined;
}

/** Slackbot facts resolved by a successful Connect provision. */
export interface AddChannelsSlackbotFacts {
  connectorUid: string;
  /** Deep link that opens a DM compose with the bot ("chat with your agent"). */
  chatUrl?: string;
  workspaceName?: string;
}

/**
 * What `perform` actually did. `channelsAdded` lists the channels recorded this
 * run (web before slack); a skipped Web scaffold (Next.js detected) records
 * nothing, deliberately. `slackbot` is present only after a fresh, fully
 * attached provision; every failure mode either throws or (under
 * `slackbotFailure: "warn-and-continue"`) skips Slack entirely, so a failed
 * Slack setup records nothing (atomicity).
 */
export interface AddChannelsPayload {
  channelsAdded: ChannelKind[];
  webScaffolded: boolean;
  slackScaffolded: boolean;
  /**
   * Whether the post-scaffold dependency install succeeded. False both when no
   * channels were recorded (nothing ran) and when the install failed; only a
   * success lets `apply` mark the deploy-time install as already done.
   */
  dependenciesInstalled: boolean;
  project: ProjectResolution;
  slackbot?: AddChannelsSlackbotFacts;
}

function warnOverwrittenFiles(log: ChannelSetupLog, files: readonly string[] | undefined): void {
  for (const filePath of files ?? []) {
    log.warning(`Overwrote ${filePath}`);
  }
}

function warnCompetingNextConfigFiles(
  log: ChannelSetupLog,
  files: readonly string[] | undefined,
): void {
  for (const filePath of files ?? []) {
    log.warning(
      `Found competing Next.js config at ${filePath}; merge any needed settings into next.config.ts and remove it before starting the preview, or Next.js may ignore the generated eve rewrite.`,
    );
  }
}

/**
 * THE CHANNEL SCAFFOLD BOX. Scaffolds the channels chosen up front by the
 * select-channels box (`state.channelSelection`): writes the Web Chat files,
 * provisions the Slackbot through Vercel Connect, writes the Slack channel
 * definition, reconciles a Connect-assigned connector UID, and installs the
 * dependencies the scaffold added to `package.json` so a running `eve dev`
 * can load the new channel modules right away. The only prompt
 * (the slackbot question) travels the asker in `gather`; `perform` is promptless
 * and reads `state.project` directly, resolved earlier by the link box or the
 * in-project seed.
 */
export function addChannels(
  options: AddChannelsOptions,
): SetupBox<SetupState, AddChannelsInput, AddChannelsPayload> {
  const deps = options.deps ?? {
    ensureChannel,
    deriveSlackConnectorSlug,
    provisionSlackbot,
    reconcileSlackUid,
    detectPackageManager,
    runPackageManagerInstall,
    runVercel,
    detectDeployment,
  };

  async function scaffoldSlackChannel(
    log: ChannelSetupLog,
    state: Readonly<SetupState>,
    projectPath: string,
    slug: SlackConnectorSlug,
    payload: AddChannelsPayload,
    connectorUid: string,
  ): Promise<boolean> {
    let wroteExactConnectorUid = false;
    if (!state.slackScaffolded) {
      const result = await deps.ensureChannel({
        projectRoot: projectPath,
        kind: "slack",
        slackConnectorUid: connectorUid,
        slackConnectorSlug: slug,
        force: options.force,
      });
      warnOverwrittenFiles(log, result.filesOverwritten);
      if (result.action === "created" || result.action === "overwritten") {
        log.success("Scaffolded channel: slack");
      } else {
        log.info('Channel "slack" already exists. Skipping file creation.');
      }
      wroteExactConnectorUid = result.action !== "skipped";
      payload.slackScaffolded = true;
    }
    // Slack is recorded even when the file already existed: the channel is
    // live either way and the pending deploy must carry it.
    payload.channelsAdded.push("slack");
    return wroteExactConnectorUid;
  }

  /**
   * The {@link AddChannelsOptions.ensureLinkedProject} fallback: link the
   * directory interactively, then re-detect the on-disk resolution. The copy
   * and command shape are the dissolved engine's, byte for byte.
   */
  async function linkProjectForSlackbot(
    log: ChannelSetupLog,
    projectPath: string,
    current: ProjectResolution,
    headless: boolean,
    signal?: AbortSignal,
  ): Promise<ProjectResolution> {
    if (headless) {
      throw new HumanActionRequiredError({
        kind: "vercel-link",
        command: "vercel link",
        reason: "Slackbot creation needs this directory linked to a Vercel project.",
      });
    }
    // No onOutput: `vercel link` (without --project) is interactive, so it must
    // own the terminal. Piping its prompt through the rail renderer line-buffers
    // the unterminated question and deadlocks the CLI waiting on hidden input.
    log.message("Linking this directory to a Vercel project...");
    if (!(await deps.runVercel(["link"], { cwd: projectPath, signal }))) {
      signal?.throwIfAborted();
      throw new Error("Vercel project linking failed. Slackbot creation did not start.");
    }
    const deployment = await deps.detectDeployment(projectPath, { signal });
    const project = mergeProjectResolution(current, projectResolutionFromDeployment(deployment));
    if (!isProjectResolved(project)) {
      throw new Error("Vercel project linking failed. Slackbot creation did not start.");
    }
    return project;
  }

  async function addWebChannelToPayload(
    log: ChannelSetupLog,
    state: Readonly<SetupState>,
    projectPath: string,
    packageManager: PackageManagerKind,
    payload: AddChannelsPayload,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!state.channelSelection.includes("web")) return;
    if (state.webScaffolded) {
      // Already scaffolded by a prior attempt this run: record without
      // rewriting the files.
      payload.channelsAdded.push("web");
      return;
    }

    log.message("Scaffolding Web Chat channel files...");
    const ensureWebOptions: EnsureChannelOptions = {
      projectRoot: projectPath,
      kind: "web",
      packageManager,
      force: options.force,
      configureVercelServices: options.configureVercelServices ?? hasVercelProject(state),
    };
    if (options.evePackage !== undefined) {
      ensureWebOptions.webPackageVersions = { evePackage: options.evePackage };
    }
    const result = await deps.ensureChannel(ensureWebOptions);
    signal?.throwIfAborted();
    warnOverwrittenFiles(log, result.filesOverwritten);
    if (
      result.kind === "web" &&
      result.action !== "skipped" &&
      result.nodeEngineOverride !== undefined
    ) {
      log.warning(formatNodeEngineOverrideWarning(result.nodeEngineOverride));
    }
    warnCompetingNextConfigFiles(
      log,
      "competingNextConfigFiles" in result ? result.competingNextConfigFiles : undefined,
    );
    if (result.action === "created" || result.action === "overwritten") {
      log.success("Scaffolded channel: web");
      payload.webScaffolded = true;
      payload.channelsAdded.push("web");
      return;
    }

    // A skipped Web scaffold (the project already runs Next.js) records
    // nothing, so it cannot arm a deploy for files that were never written.
    log.info("Next.js project detected. Skipping Web Chat scaffolding.");
  }

  function assertSlackProjectReady(state: Readonly<SetupState>): void {
    if (options.ensureLinkedProject !== undefined) return;
    if (!hasVercelProject(state)) throw new Error(SLACK_REQUIRES_VERCEL);
    if (!isProjectResolved(state.project)) {
      throw new Error("Expected a linked Vercel project for Slack, but none was resolved.");
    }
  }

  async function provisionSlackbotWithControls(
    log: ChannelSetupLog,
    projectPath: string,
    slug: SlackConnectorSlug,
    signal?: AbortSignal,
  ): Promise<ProvisionSlackbotResult> {
    if (signal === undefined && options.prompter.awaitChoice === undefined) {
      return deps.provisionSlackbot(log, projectPath, slug);
    }

    const provisionOptions: ProvisionSlackbotOptions = {};
    if (signal !== undefined) provisionOptions.signal = signal;
    if (options.prompter.awaitChoice !== undefined) {
      provisionOptions.awaitChoice = options.prompter.awaitChoice;
    }
    return deps.provisionSlackbot(log, projectPath, slug, undefined, provisionOptions);
  }

  async function scaffoldAttachedSlackChannel(
    log: ChannelSetupLog,
    state: Readonly<SetupState>,
    projectPath: string,
    slug: SlackConnectorSlug,
    payload: AddChannelsPayload,
    slackbot: Extract<ProvisionSlackbotResult, { state: "attached" }>,
  ): Promise<void> {
    const wroteExactConnectorUid = await scaffoldSlackChannel(
      log,
      state,
      projectPath,
      slug,
      payload,
      slackbot.connectorUid,
    );
    if (wroteExactConnectorUid) return;

    const ready = await deps.reconcileSlackUid(log, projectPath, slackbot, `slack/${slug}`);
    if (!ready) {
      throw new Error("Slack connector UID update is required before deployment.");
    }
  }

  async function addSlackChannelToPayload(
    log: ChannelSetupLog,
    state: Readonly<SetupState>,
    input: AddChannelsInput,
    projectPath: string,
    payload: AddChannelsPayload,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!state.channelSelection.includes("slack")) return;
    assertSlackProjectReady(state);

    const slug = await deps.deriveSlackConnectorSlug(projectPath, state.agentName);
    if (state.slackbotCreated) {
      // Rerun with a provisioned slackbot: never create a second connector.
      if (!state.slackbotAttached) throw new Error(SLACKBOT_NOT_ATTACHED_ERROR);
      if (!state.deploymentPending) return;

      const connectorUid = state.slackConnectorUid;
      if (connectorUid === undefined) {
        throw new Error("Slack connector UID was not resolved. Slack deployment did not start.");
      }
      await scaffoldAttachedSlackChannel(log, state, projectPath, slug, payload, {
        state: "attached",
        connectorUid,
      });
      return;
    }

    if (input.createSlackbot !== true) {
      log.info("Slack channel was not added because Slackbot setup was skipped.");
      return;
    }

    if (!isProjectResolved(payload.project)) {
      // Only reachable with the ensureLinkedProject seam; without it the gate
      // above already required a resolved project.
      payload.project = await linkProjectForSlackbot(
        log,
        projectPath,
        payload.project,
        input.headless,
        signal,
      );
    }

    const slackbot = await provisionSlackbotWithControls(log, projectPath, slug, signal);
    signal?.throwIfAborted();
    if (slackbot.state === "cancelled") {
      // Provisioning already cleaned up its connector. Fold into a cancelled
      // run so /channels repaints the list like any other cancelled sub-flow.
      throw new WizardCancelledError();
    }
    if (slackbot.state !== "attached") {
      const copy = slackbotFailureCopy(slackbot);
      if (options.slackbotFailure !== "warn-and-continue") {
        throw new Error(copy.reason);
      }
      // Slack records nothing. A connector that exists but is not attached
      // must be recovered from the command printed above, not re-created.
      log.warning(`${copy.reason} ${copy.followUp}`);
      return;
    }

    payload.slackbot = {
      connectorUid: slackbot.connectorUid,
      chatUrl: slackbot.chatUrl,
      workspaceName: slackbot.workspaceName,
    };
    await scaffoldAttachedSlackChannel(log, state, projectPath, slug, payload, slackbot);
  }

  async function installChannelDependencies(
    log: ChannelSetupLog,
    projectPath: string,
    packageManager: PackageManagerKind,
    payload: AddChannelsPayload,
    signal?: AbortSignal,
  ): Promise<void> {
    if (payload.channelsAdded.length === 0) return;
    const installed = await withPhase(
      log,
      `Installing channel dependencies (${packageManager} install)...`,
      () =>
        deps.runPackageManagerInstall(packageManager, projectPath, {
          onOutput: createPromptCommandOutput(log),
          signal,
        }),
    );
    if (installed) {
      payload.dependenciesInstalled = true;
      return;
    }

    // The channels are durable; deploy retries the install. Until one
    // succeeds, `eve dev` cannot load the new channel modules.
    log.warning(
      `Dependency installation failed. The new channels stay unloadable until \`${packageManager} install\` or a deploy succeeds.`,
    );
  }

  async function performAddChannels(
    state: Readonly<SetupState>,
    input: AddChannelsInput,
    signal?: AbortSignal,
  ): Promise<AddChannelsPayload> {
    signal?.throwIfAborted();
    const log = options.prompter.log;
    const projectPath = requireProjectPath(state);
    const payload: AddChannelsPayload = {
      channelsAdded: [],
      webScaffolded: state.webScaffolded,
      slackScaffolded: state.slackScaffolded,
      dependenciesInstalled: false,
      project: state.project,
    };
    const packageManager = await deps.detectPackageManager(projectPath);
    await addWebChannelToPayload(log, state, projectPath, packageManager.kind, payload, signal);
    await addSlackChannelToPayload(log, state, input, projectPath, payload, signal);
    // A retry after a failed run can find durable channel files but no install;
    // recorded channels therefore always drive the dependency gate.
    await installChannelDependencies(log, projectPath, packageManager.kind, payload, signal);

    return payload;
  }

  return {
    id: "add-channels",

    async gather({ state }): Promise<AddChannelsInput> {
      const headless = options.headless ?? false;
      // A deliberately plain Error, not HumanActionRequiredError: there is no
      // single command a human can run to finish this; the guided flow owns it.
      // A presetCreateSlackbot does not rescue headless Slack either.
      if (headless && state.channelSelection.includes("slack")) {
        throw new Error(SLACK_HEADLESS_ERROR);
      }
      // The preset short-circuits the question, exactly as the dual-face box did,
      // so it stays a factory option rather than a withAnswers rung.
      if (
        !state.channelSelection.includes("slack") ||
        options.presetCreateSlackbot !== undefined ||
        state.slackbotCreated
      ) {
        return { headless, createSlackbot: options.presetCreateSlackbot };
      }
      try {
        const createSlackbot = await options.asker.ask(
          confirm({
            key: "create-slackbot",
            message: "Do you want to create your slackbot?",
          }),
        );
        return { headless, createSlackbot };
      } catch (error) {
        // The question is not required: a headless/assume skip means "do not
        // create", preserving the dual-face box's "false when unset" behavior.
        if (error instanceof SkippedSignal) {
          return { headless, createSlackbot: false };
        }
        throw error;
      }
    },

    async perform({ state, input, signal }): Promise<AddChannelsPayload> {
      try {
        return await performAddChannels(state, input, signal);
      } catch (error) {
        if (!(error instanceof WizardCancelledError)) {
          const message = error instanceof Error ? error.message : String(error);
          const oneLine = message.split("\n")[0]?.trim() ?? message;
          options.prompter.log.error(oneLine);
        }
        throw error;
      }
    },

    apply(state, payload) {
      const channels = [...state.channels];
      for (const channel of payload.channelsAdded) {
        if (!channels.includes(channel)) {
          channels.push(channel);
        }
      }
      const next: SetupState = {
        ...state,
        channels,
        webScaffolded: payload.webScaffolded,
        slackScaffolded: payload.slackScaffolded,
        deploymentPending: state.deploymentPending || payload.channelsAdded.length > 0,
        // Recorded channels touched the manifest, so the deploy-time install
        // gate must reflect this run's install outcome — an earlier success is
        // stale the moment new dependencies land in package.json.
        deploymentDependenciesInstalled:
          payload.channelsAdded.length > 0
            ? payload.dependenciesInstalled
            : state.deploymentDependenciesInstalled,
        project: mergeProjectResolution(state.project, payload.project),
      };
      if (payload.slackbot === undefined) {
        return next;
      }
      return {
        ...next,
        slackbotCreated: true,
        slackbotAttached: true,
        slackConnectorUid: payload.slackbot.connectorUid,
        slackChatUrl: payload.slackbot.chatUrl,
        slackWorkspaceName: payload.slackbot.workspaceName,
      };
    },
  };
}
