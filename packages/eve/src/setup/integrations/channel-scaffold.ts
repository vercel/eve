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
import { ensureVercelProject } from "#setup/flows/ensure-vercel-project.js";
import {
  isProjectResolved,
  mergeProjectResolution,
  type ProjectResolution,
} from "../project-resolution.js";
import type { Asker } from "../ask.js";
import type { Prompter } from "../prompter.js";
import {
  provisionSlackbot,
  reconcileSlackUid,
  type ProvisionSlackbotOptions,
  type ProvisionSlackbotResult,
} from "../slackbot.js";
import { WizardCancelledError, type SetupBox } from "../step.js";

/** State required by channel setup, kept narrow so the integration can move packages. */
export interface AddChannelsState {
  projectPath:
    | string
    | { kind: "unresolved"; inPlace: boolean }
    | { kind: "resolved"; inPlace: boolean; path: string };
  project: ProjectResolution;
  channels: ChannelKind[];
  webScaffolded: boolean;
  slackScaffolded: boolean;
}

const SLACK_REQUIRES_VERCEL = "Slack setup with Vercel Connect requires a linked Vercel project.";

const SLACK_HEADLESS_ERROR =
  "Slack setup is interactive. Run `eve add channel/slack` from an interactive terminal.";

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
          "Continuing without Slack — the install timed out and was cleaned up; re-run `eve add channel/slack` to try again.",
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
          "Continuing without Slack — restore Vercel CLI access, then re-run `eve add channel/slack`.",
      };
    case "installation-check-failed":
      return {
        reason: SLACKBOT_INSTALLATION_CHECK_FAILED_ERROR,
        followUp:
          "Continuing without Slack — verify Vercel Connect is reachable, then re-run `eve add channel/slack`.",
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
        followUp: "Continuing without Slack — add it later with `eve add channel/slack`.",
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
  ensureVercelProject: typeof ensureVercelProject;
}

export interface AddChannelsOptions {
  /** The integration channel this operation scaffolds. */
  kind: ChannelKind;
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
  /** Reuse the preferred existing Slack connector without prompting. */
  presetCreateSlackbot?: boolean;
  /** Overwrite existing channel files (`eve add --overwrite channel/slack`). */
  force?: boolean;
  /** Credential source for Slack. Defaults to Vercel Connect. */
  slackCredentials?: "vercel-connect" | "environment";
  /**
   * Override for the web scaffold's Vercel services config. The explicit
   * environment plan takes precedence; otherwise this defaults to
   * `hasVercelProject(state)`.
   */
  configureVercelServices?: boolean;
  /**
   * Opt-in fallback when Slack is chosen interactively but `state.project` is
   * unresolved: link the project before provisioning the slackbot. The Slack
   * integration sets this so Vercel Connect setup can link an unlinked project.
   */
  ensureLinkedProject?: "interactive-vercel-link";
  /**
   * What a failed slackbot provision (create or attach) does to the run. The
   * default, "abort", fails the whole box — right for `eve add channel/slack`,
   * where Slack is the point. "warn-and-continue" records nothing so a later
   * `eve add channel/slack` starts clean.
   */
  slackbotFailure?: "abort" | "warn-and-continue";
  deps?: AddChannelsDeps;
  /** Registry installation already owns package dependency mutations. */
  skipDependencyMutation?: boolean;
}

/**
 * Inputs resolved before `perform` runs channel effects.
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
   * channels were recorded and when the install failed.
   */
  dependenciesChanged: boolean;
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
 * Channel integration setup. Scaffolds the requested channel: writes the Web Chat files,
 * provisions the Slackbot through Vercel Connect, writes the Slack channel
 * definition, reconciles a Connect-assigned connector UID, and installs the
 * dependencies the scaffold added to `package.json` so a running `eve dev`
 * can load the new channel modules right away. The only prompt
 * (the slackbot question) travels the asker in `gather`; `perform` is promptless
 * and reads `state.project` directly, resolved earlier by the link box or the
 * in-project seed.
 */
export function addChannels<State extends AddChannelsState = AddChannelsState>(
  options: AddChannelsOptions,
): SetupBox<State, AddChannelsInput, AddChannelsPayload> {
  const deps = options.deps ?? {
    ensureChannel,
    deriveSlackConnectorSlug,
    provisionSlackbot,
    reconcileSlackUid,
    detectPackageManager,
    runPackageManagerInstall,
    ensureVercelProject,
  };

  async function scaffoldSlackChannel(
    log: ChannelSetupLog,
    state: Readonly<AddChannelsState>,
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
        skipDependencyMutation: options.skipDependencyMutation,
      });
      payload.dependenciesChanged ||= result.packageJsonUpdated.length > 0;
      warnOverwrittenFiles(log, result.filesOverwritten);
      if (result.action === "created" || result.action === "overwritten") {
        log.success("Scaffolded channel: slack");
      } else {
        log.info('Channel "slack" already exists. Skipping file creation.');
      }
      wroteExactConnectorUid = result.action !== "skipped";
      payload.slackScaffolded = true;
    }
    // Slack is recorded even when the file already existed: the channel is live either way.
    payload.channelsAdded.push("slack");
    return wroteExactConnectorUid;
  }

  async function addWebChannelToPayload(
    log: ChannelSetupLog,
    state: Readonly<AddChannelsState>,
    projectPath: string,
    packageManager: PackageManagerKind,
    payload: AddChannelsPayload,
    signal?: AbortSignal,
  ): Promise<void> {
    if (options.kind !== "web") return;
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
      configureVercelServices: options.configureVercelServices ?? isProjectResolved(state.project),
      skipDependencyMutation: options.skipDependencyMutation,
    };
    if (options.evePackage !== undefined) {
      ensureWebOptions.webPackageVersions = { evePackage: options.evePackage };
    }
    const result = await deps.ensureChannel(ensureWebOptions);
    payload.dependenciesChanged ||= result.packageJsonUpdated.length > 0;
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

    // A skipped Web scaffold (the project already runs Next.js) records nothing.
    log.info("Next.js project detected. Skipping Web Chat scaffolding.");
  }

  function assertSlackProjectReady(state: Readonly<AddChannelsState>): void {
    if (options.ensureLinkedProject !== undefined) return;
    if (!isProjectResolved(state.project)) throw new Error(SLACK_REQUIRES_VERCEL);
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
    const provisionOptions: ProvisionSlackbotOptions = {
      selectConnector: async (connectors, preferred) => {
        if (options.presetCreateSlackbot === true) return preferred ?? connectors[0]!;
        const choices = connectors.map((connector) => {
          const choice: { value: string; label: string; hint?: string } = {
            value: connector.uid,
            label: `Use ${connector.uid}`,
          };
          if (connector.uid === preferred?.uid) choice.hint = "Matches this agent";
          return choice;
        });
        const request = {
          message: "Which Slack app would you like to use?",
          options: [...choices, { value: "create", label: "Create a new Slack app" }],
          initialValue: preferred?.uid,
        };
        const selected = await options.prompter.select<string>(request);
        if (selected === "create") return "create";
        return connectors.find((connector) => connector.uid === selected)!;
      },
    };
    if (signal !== undefined) provisionOptions.signal = signal;
    if (options.prompter.awaitChoice !== undefined) {
      provisionOptions.awaitChoice = options.prompter.awaitChoice;
    }
    return deps.provisionSlackbot(log, projectPath, slug, undefined, provisionOptions);
  }

  async function scaffoldAttachedSlackChannel(
    log: ChannelSetupLog,
    state: Readonly<AddChannelsState>,
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
    state: Readonly<AddChannelsState>,
    input: AddChannelsInput,
    projectPath: string,
    payload: AddChannelsPayload,
    signal?: AbortSignal,
  ): Promise<void> {
    if (options.kind !== "slack") return;

    const slug = await deps.deriveSlackConnectorSlug(projectPath);
    if (options.slackCredentials === "environment") {
      if (!state.slackScaffolded) {
        const result = await deps.ensureChannel({
          projectRoot: projectPath,
          kind: "slack",
          slackConnectorSlug: slug,
          slackCredentials: "environment",
          force: options.force,
          skipDependencyMutation: options.skipDependencyMutation,
        });
        payload.dependenciesChanged ||= result.packageJsonUpdated.length > 0;
        warnOverwrittenFiles(log, result.filesOverwritten);
        if (result.action === "created" || result.action === "overwritten") {
          log.success("Scaffolded channel: slack");
        } else {
          log.info('Channel "slack" already exists. Skipping file creation.');
        }
        payload.slackScaffolded = true;
      }
      payload.channelsAdded.push("slack");
      return;
    }

    assertSlackProjectReady(state);
    if (!isProjectResolved(payload.project)) {
      // Only reachable with the ensureLinkedProject seam; without it the gate
      // above already required a resolved project.
      if (input.headless) {
        throw new HumanActionRequiredError({
          kind: "vercel-link",
          command: "vercel link",
          reason: "Slackbot creation needs this directory linked to a Vercel project.",
        });
      }
      const linked = await deps.ensureVercelProject({
        appRoot: projectPath,
        prompter: options.prompter,
        signal,
      });
      payload.project = mergeProjectResolution(payload.project, {
        kind: "linked",
        projectId: linked.projectId,
      });
    }

    const slackbot = await provisionSlackbotWithControls(log, projectPath, slug, signal);
    signal?.throwIfAborted();
    if (slackbot.state === "cancelled") {
      // Provisioning already cleaned up its connector.
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
    if (options.skipDependencyMutation || !payload.dependenciesChanged) return;
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
    state: Readonly<AddChannelsState>,
    input: AddChannelsInput,
    signal?: AbortSignal,
  ): Promise<AddChannelsPayload> {
    signal?.throwIfAborted();
    const log = options.prompter.log;
    const projectPath =
      typeof state.projectPath === "string"
        ? state.projectPath
        : state.projectPath.kind === "resolved"
          ? state.projectPath.path
          : undefined;
    if (projectPath === undefined) throw new Error("Project path has not been resolved.");
    const payload: AddChannelsPayload = {
      channelsAdded: [],
      webScaffolded: state.webScaffolded,
      slackScaffolded: state.slackScaffolded,
      dependenciesChanged: false,
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

    async gather(): Promise<AddChannelsInput> {
      const headless = options.headless ?? false;
      // Connect opens a browser and remains interactive. Environment-backed
      // Slack has no provisioning effect, so headless setup can scaffold it.
      if (headless && options.kind === "slack" && options.slackCredentials !== "environment") {
        throw new Error(SLACK_HEADLESS_ERROR);
      }
      return { headless, createSlackbot: options.presetCreateSlackbot };
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
      const next: State = {
        ...state,
        channels,
        webScaffolded: payload.webScaffolded,
        slackScaffolded: payload.slackScaffolded,
        project: mergeProjectResolution(state.project, payload.project),
      } as State;
      if (payload.slackbot === undefined) {
        return next;
      }
      return next;
    },
  };
}
