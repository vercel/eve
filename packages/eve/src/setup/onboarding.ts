import { resolve } from "node:path";

import { headlessAsker, interactiveAsker, type Asker } from "./ask.js";
import { addChannels } from "./boxes/add-channels.js";
import { addConnections } from "./boxes/add-connections.js";
import { applyAiGatewayCredential } from "./boxes/apply-ai-gateway-credential.js";
import { deployProject } from "./boxes/deploy-project.js";
import { detectAiGateway } from "./boxes/detect-ai-gateway.js";
import { linkVercelProject } from "./boxes/link-project.js";
import { oneShotNextSteps } from "./boxes/one-shot-next-steps.js";
import { preflight } from "./boxes/preflight.js";
import { resolveProvisioning } from "./boxes/resolve-provisioning.js";
import { resolveTarget } from "./boxes/resolve-target.js";
import { scaffold } from "./boxes/scaffold.js";
import { selectChannels } from "./boxes/select-channels.js";
import { selectChat } from "./boxes/select-chat.js";
import { selectConnections } from "./boxes/select-connections.js";
import { selectModel } from "./boxes/select-model.js";
import { selectSetupMode } from "./boxes/select-setup-mode.js";
import type { Prompter } from "./prompter.js";
import type { AnySetupBox } from "./runner.js";
import type { EvePackageContract } from "./scaffold/index.js";
import type {
  ArgsHeadlessAiGateway,
  ArgsHeadlessProject,
  ChannelKind,
  ChatPreference,
  ProvisioningMode,
  SetupMode,
  SetupState,
} from "./state.js";

/**
 * Options for {@link composeOnboardingBoxes}. These carry exactly what the
 * create flow's options carried: the preset answers that let each box resolve
 * without prompting, plus the directory and headless dispatch decisions.
 */
export interface OnboardingBoxesOptions {
  prompter: Prompter;
  /** Skip the name prompt and use this value. */
  presetName?: string;
  /** Skip the setup-mode prompt and use this value. */
  presetMode?: SetupMode;
  /** Skip the model prompt and use this value. */
  presetModel?: string;
  /** Skip the channels prompt and use these kinds. */
  presetChannels?: ChannelKind[];
  /** Skip the connections picker and scaffold these catalog slugs. */
  presetConnections?: string[];
  /** Skip the "Create slackbot?" prompt inside the add-to-agent step. */
  presetCreateSlackbot?: boolean;
  /** Headless-only Vercel provisioning flags. Ignored on the interactive path. */
  provisioning?: { project: ArgsHeadlessProject; aiGateway: ArgsHeadlessAiGateway };
  /** Skip the chat-preference prompt and use this value. */
  presetChatPreference?: ChatPreference;
  /** Parent directory the project folder is created inside. Defaults to cwd. */
  targetDirectory?: string;
  /** Scaffold into cwd or targetDirectory instead of creating a child directory. */
  inPlace?: boolean;
  /** Allow the in-place scaffold to replace eve scaffold files that already exist. */
  overwriteExisting?: boolean;
  /** Skip the post-channel Vercel deployment entirely. */
  presetNoDeploy?: boolean;
  /**
   * Headless mode: never prompt or spawn an interactive Vercel command. Boxes
   * needing a human/browser action throw `HumanActionRequiredError`. Slack
   * setup remains an interactive/onboarding handoff, not a headless flow.
   */
  headless?: boolean;
  /** eve package metadata baked into the scaffolded `package.json`. */
  evePackage?: EvePackageContract;
}

/**
 * Gates a box at composition time without teaching the box about flow shapes.
 * ANDs with the box's own `shouldRun` so existing self-skips keep working.
 */
function onlyWhen(
  predicate: (state: Readonly<SetupState>) => boolean,
  box: AnySetupBox<SetupState>,
): AnySetupBox<SetupState> {
  return {
    ...box,
    shouldRun: (state) => predicate(state) && (box.shouldRun?.(state) ?? true),
  };
}

/**
 * Gates a box to complete-setup runs: a one-shot run stops at the scaffold, so
 * every interview and post-scaffold box is wrapped with this instead of
 * teaching each box about setup modes.
 */
function completeSetupOnly(box: AnySetupBox<SetupState>): AnySetupBox<SetupState> {
  return onlyWhen((state) => state.setupMode === "complete", box);
}

/**
 * Composes the full programmatic onboarding flow.
 *
 * 1. The interview phase: name, then the agent itself (model, channels,
 *    connections), then where it runs (the provisioning plans).
 * 2. Input preflight before filesystem writes.
 * 3. The scaffold box writes or reuses the agent template.
 * 4. Project and gateway facts are detected and executed from the plans.
 * 5. Channel setup writes Web/Slack surfaces and returns setup facts.
 * 6. Deploy runs once when Slack was added (the connector needs a public URL).
 * 7. Chat preference is picked from the final channel state.
 */
export function composeOnboardingBoxes(options: OnboardingBoxesOptions): AnySetupBox<SetupState>[] {
  // The headless provisioning flags are read only on the headless path; an
  // interactive run prompts for every provisioning decision instead.
  const mode: ProvisioningMode = options.headless
    ? {
        headless: true,
        project: options.provisioning?.project ?? {},
        aiGateway: options.provisioning?.aiGateway ?? {},
      }
    : { headless: false };
  // The ask channel for the unified boxes, built here because the composition
  // already owns the prompter and the headless dispatch decision; commands
  // keep passing exactly what they passed before. Migrated presets stay
  // factory options on their boxes (see each box's option docs), so no
  // withAnswers rung is composed yet.
  const asker: Asker = options.headless ? headlessAsker() : interactiveAsker(options.prompter);
  // Decide-once, execute-in-order. The interview boxes gather the directory,
  // agent, and provisioning decisions as plans; the link box executes the
  // project plan after scaffold and records the resolution in `state.project`,
  // which every later box reads. The on-disk `.vercel` link is the single
  // source of truth.
  return [
    resolveTarget({
      asker,
      notify: (message) => options.prompter.note(message),
      presetName: options.presetName,
      targetDirectory: options.targetDirectory,
      inPlace: options.inPlace,
      // Only headless re-runs converge onto an existing eve project directory;
      // interactive runs keep refusing so a human notices the collision.
      resumeExisting: options.headless,
    }),
    selectSetupMode({
      asker,
      presetMode: options.presetMode,
      presetModel: options.presetModel,
    }),
    // The complete-setup interview. The agent is described first — model,
    // channels, connections — and only then where it runs: the provisioning
    // box reads those selections, so Slack or a Connect-backed connection
    // resolves the deployment question to Vercel without asking it. This also
    // keeps the interview phase (prompts) ahead of the programmatic phase
    // (file writes, linking, deploy).
    ...[
      selectModel({ asker, presetModel: options.presetModel }),
      selectChannels({
        asker,
        presetChannels: options.presetChannels,
        variant: "onboarding",
      }),
      selectConnections({
        asker,
        presetConnections: options.presetConnections,
        headless: options.headless,
      }),
      resolveProvisioning({
        asker,
        prompter: options.prompter,
        targetDirectory: options.targetDirectory,
        mode,
      }),
    ].map(completeSetupOnly),
    preflight({
      cwd: resolve(options.targetDirectory ?? process.cwd()),
      headless: options.headless,
    }),
    scaffold({
      prompter: options.prompter,
      evePackage: options.evePackage,
      targetDirectory: options.targetDirectory,
      overwriteExisting: options.overwriteExisting,
      headless: options.headless,
    }),
    // The complete-setup execution phase: everything a one-shot run defers.
    ...[
      detectAiGateway(),
      linkVercelProject({ prompter: options.prompter, headless: options.headless }),
      applyAiGatewayCredential({ prompter: options.prompter }),
      addChannels({
        asker,
        prompter: options.prompter,
        evePackage: options.evePackage,
        presetCreateSlackbot: options.presetCreateSlackbot,
        headless: options.headless,
        // A failed slackbot must not abort onboarding: the agent still
        // scaffolds, deploys, and chats; Slack can be added later.
        slackbotFailure: "warn-and-continue",
      }),
      addConnections({ prompter: options.prompter }),
    ].map(completeSetupOnly),
    // Onboarding deploys only for Slack: the connector needs a public
    // production URL before it can receive events, while Web Chat runs
    // locally through `eve dev`. Adding channels to an existing project
    // (in-project setup, `eve channels add`) keeps deploying for any
    // channel — this gate is onboarding-only.
    completeSetupOnly(
      onlyWhen(
        (state) => state.slackScaffolded,
        deployProject({
          prompter: options.prompter,
          skip: options.presetNoDeploy,
          headless: options.headless,
        }),
      ),
    ),
    completeSetupOnly(
      selectChat({
        asker,
        presetPreference: options.presetChatPreference,
      }),
    ),
    oneShotNextSteps({ prompter: options.prompter }),
  ];
}
