import { SCAFFOLDABLE_CHANNELS, type ChannelKind } from "#setup/scaffold/index.js";
import { toErrorMessage } from "#shared/errors.js";

import { interactiveAsker } from "../ask.js";
import { addChannels, type AddChannelsDeps } from "../boxes/add-channels.js";
import { CHANNELS_PROMPT_MESSAGE, selectChannels } from "../boxes/select-channels.js";
import {
  assertCanAddSelectedChannels,
  inspectExistingChannelRegistrations,
  type ExistingChannelRegistrations,
} from "../channel-add-conflicts.js";
import {
  detectDeployment,
  isProjectResolved,
  projectResolutionFromDeployment,
} from "../project-resolution.js";
import type { Prompter, SelectOption, SingleSelectOptions } from "../prompter.js";
import { WizardCancelledError } from "../step.js";
import { runInteractive, type AnySetupBox } from "../runner.js";
import { createDefaultSetupState, snapshotSetupState, type SetupState } from "../state.js";
import {
  getVercelAuthStatus,
  vercelAuthBlockerReason,
  type VercelAuthStatus,
} from "../vercel-project.js";
import { withSpinner } from "../with-spinner.js";

import { prompterSink } from "./in-project.js";

/** Injected for tests; defaults to the real detection and box effects. */
export interface ChannelsFlowDeps {
  detectDeployment: typeof detectDeployment;
  inspectExistingChannelRegistrations: typeof inspectExistingChannelRegistrations;
  getVercelAuthStatus: typeof getVercelAuthStatus;
  addChannels?: AddChannelsDeps;
}

export type ChannelsFlowResult =
  | {
      kind: "done";
      addedChannels: readonly string[];
    }
  | {
      /**
       * The user chose "Deploy and chat" on the post-Slack "See it live"
       * prompt. The caller deploys, then points them at this workspace.
       */
      kind: "deploy-and-chat";
      addedChannels: readonly string[];
      chat: { chatUrl?: string; workspaceName?: string };
    }
  | { kind: "cancelled" }
  | {
      kind: "failed";
      addedChannels: readonly string[];
      message: string;
    };

/** The post-Slack "see it live" chooser's title. */
export const SEE_IT_LIVE_MESSAGE = "See it live";

/**
 * The streamlined hop from a fresh Slack connection to a live agent. A Slack
 * bot only receives messages once the project is deployed, so rather than leave
 * the user to discover `/deploy`, offer it inline: "Deploy and chat" ends the
 * channel loop so the caller can deploy and surface the workspace; "Later" (or
 * Esc) drops back to the channel list unchanged.
 */
async function promptSeeItLive(prompter: Prompter): Promise<"deploy" | "later"> {
  try {
    return await prompter.select<"deploy" | "later">({
      message: SEE_IT_LIVE_MESSAGE,
      options: [
        { value: "deploy", label: "Deploy and chat" },
        { value: "later", label: "Later" },
      ],
    });
  } catch (error) {
    if (error instanceof WizardCancelledError) return "later";
    throw error;
  }
}

/** One row on the channel task list: a channel, the local TUI, or Done. */
type ChannelListRow = ChannelKind | "done" | "repl";

function channelAlreadyAdded(
  registrations: ExistingChannelRegistrations,
  channel: ChannelKind,
): boolean {
  return channel === "web" ? registrations.webAppPresent : registrations.slackOwners.length > 0;
}

function appendChannel(channels: readonly ChannelKind[], channel: ChannelKind): ChannelKind[] {
  return channels.includes(channel) ? [...channels] : [...channels, channel];
}

type ChannelPickResult = { kind: "picked"; value: ChannelListRow } | { kind: "cancelled" };

async function pickChannel(
  prompter: Prompter,
  registrations: ExistingChannelRegistrations,
  projectLinked: boolean,
  authStatus: VercelAuthStatus,
): Promise<ChannelPickResult> {
  const rows = channelListRows(registrations, projectLinked, authStatus);
  // When every channel is already added or unavailable, the only action left
  // is to finish: default to "Done" instead of a completed row.
  const onlyDoneRemains = !rows.some(
    (row) => row.value !== "done" && row.completed !== true && row.disabled !== true,
  );
  const request: SingleSelectOptions<ChannelListRow> = {
    message: CHANNELS_PROMPT_MESSAGE,
    options: rows,
    hintLayout: "inline",
  };
  if (onlyDoneRemains) request.initialValue = "done";

  try {
    return { kind: "picked", value: await prompter.select<ChannelListRow>(request) };
  } catch (error) {
    if (error instanceof WizardCancelledError) return { kind: "cancelled" };
    throw error;
  }
}

function channelLandedDuringSubflow(
  before: ExistingChannelRegistrations,
  after: ExistingChannelRegistrations,
  channel: ChannelKind,
): boolean {
  return !channelAlreadyAdded(before, channel) && channelAlreadyAdded(after, channel);
}

function deployAndChatDetails(state: Readonly<SetupState>): {
  chatUrl?: string;
  workspaceName?: string;
} {
  const details: { chatUrl?: string; workspaceName?: string } = {};
  if (state.slackChatUrl !== undefined) details.chatUrl = state.slackChatUrl;
  if (state.slackWorkspaceName !== undefined) details.workspaceName = state.slackWorkspaceName;
  return details;
}

/**
 * The action list reads like a task list: the active Terminal UI and configured
 * channels render checked and remain cursor-addressable for an "Already
 * installed" hint, but cannot be selected. Conflicting channels are disabled
 * with the reason, and the rest are pickable. The Web Chat row tracks the
 * Next.js app itself (`webAppPresent`), not the authored session-route channel
 * used by this REPL.
 */
/**
 * Why a Vercel-backed channel can't be added yet, or `undefined` when it can.
 * Provisioning needs an installed CLI, a logged-in session, and a linked
 * project — all three, on independent axes — so each missing piece points at
 * its own fix rather than dead-ending. Authentication is checked regardless of
 * link state: a linked directory whose session is logged out still cannot
 * provision.
 */
function vercelChannelBlocker(
  authStatus: VercelAuthStatus,
  projectLinked: boolean,
): string | undefined {
  const authBlocker = vercelAuthBlockerReason(authStatus);
  if (authBlocker !== undefined) return authBlocker;
  if (!projectLinked) return "Requires Vercel account, see /model";
  return undefined;
}

function channelListRows(
  registrations: ExistingChannelRegistrations,
  projectLinked: boolean,
  authStatus: VercelAuthStatus,
): SelectOption<ChannelListRow>[] {
  const rows: SelectOption<ChannelListRow>[] = [
    {
      value: "repl",
      label: "Terminal UI",
      completed: true,
      focusHint: "Already installed",
    },
  ];
  for (const channel of SCAFFOLDABLE_CHANNELS) {
    if (channelAlreadyAdded(registrations, channel.kind)) {
      rows.push({
        value: channel.kind,
        label: channel.label,
        completed: true,
        focusHint: "Already installed",
      });
      continue;
    }
    const disabledReason = registrations.disabledChannelReasons[channel.kind];
    if (disabledReason !== undefined) {
      rows.push({ value: channel.kind, label: channel.label, disabled: true, disabledReason });
      continue;
    }
    // The add sub-flow for these channels provisions against the linked Vercel
    // project, which needs an installed CLI, a logged-in session, and a link.
    // The row points at whichever is missing instead of dead-ending.
    if (channel.requiresVercelProject === true) {
      const blocker = vercelChannelBlocker(authStatus, projectLinked);
      if (blocker !== undefined) {
        rows.push({
          value: channel.kind,
          label: channel.label,
          disabled: true,
          disabledReason: blocker,
          disabledReasonTone: "warning",
        });
        continue;
      }
    }
    const row: SelectOption<ChannelListRow> = { value: channel.kind, label: channel.label };
    if (channel.hint !== undefined) row.hint = channel.hint;
    rows.push(row);
  }
  rows.push({ value: "done", label: "Done" });
  return rows;
}

/**
 * THE CHANNELS FLOW for the dev TUI's `/channels`: a task list that loops.
 * Pick an unregistered channel, run its add sub-flow (Slack provisioning
 * included), and land back on the repainted list with that channel checked;
 * "Done" or Esc leaves. Filesystem effects can land before the runner applies
 * their in-memory payload, so every cancelled or failed sub-flow re-inspects
 * authored registrations and preserves a channel that became durable. Esc on
 * the list after something was added reports the additions exactly like Done;
 * only an empty exit folds to cancelled.
 *
 * Each pick reuses the `eve channels add` composition — the same conflict
 * validation, Vercel services config pinned on, and the default empty agent
 * name (the Slack connector slug falls back to the package.json name) — with
 * two TUI-specific differences: no trailing deploy box (the TUI exposes
 * `/deploy` as its own command), and no inline link pickers — channels that
 * provision against the Vercel project render disabled with a warning
 * pointing at /model while the directory is unlinked, so a pick can never
 * reach provisioning without a link.
 */
export async function runChannelsFlow(input: {
  appRoot: string;
  prompter: Prompter;
  signal?: AbortSignal;
  deps?: Partial<ChannelsFlowDeps>;
}): Promise<ChannelsFlowResult> {
  const { appRoot, prompter, signal } = input;
  const deps: ChannelsFlowDeps = {
    detectDeployment,
    inspectExistingChannelRegistrations,
    getVercelAuthStatus,
    ...input.deps,
  };

  // Link detection and the auth probe are independent `vercel` round-trips;
  // the registration compile is local. One ephemeral spinner covers all three
  // so the list paints with no persisted loading lines. Login is a separate
  // axis from link: a logged-out (or CLI-missing) session blocks a Vercel-backed
  // channel even when the directory is linked.
  const [deployment, initialRegistrations, authStatus] = await withSpinner(
    prompter,
    "Checking the project…",
    () =>
      Promise.all([
        deps.detectDeployment(appRoot, { signal }),
        deps.inspectExistingChannelRegistrations(appRoot),
        deps.getVercelAuthStatus(appRoot, { signal }),
      ]),
  );
  signal?.throwIfAborted();
  let registrations = initialRegistrations;

  // The detected on-disk link is the only seeded fact, exactly like
  // `eve channels add`. The state carries forward across picks so a link or
  // slackbot established for one channel is not redone for the next.
  let state: SetupState = {
    ...createDefaultSetupState(),
    project: projectResolutionFromDeployment(deployment),
    projectPath: { kind: "resolved", inPlace: true, path: appRoot },
  };
  let retainedFailure: string | undefined;

  while (true) {
    const picked = await pickChannel(
      prompter,
      registrations,
      isProjectResolved(state.project),
      authStatus,
    );
    if (picked.kind === "cancelled") {
      if (state.channels.length === 0) return { kind: "cancelled" };
      break;
    }
    const pick = picked.value;
    if (pick === "done") break;
    if (pick === "repl" || channelAlreadyAdded(registrations, pick)) continue;

    const boxes: AnySetupBox<SetupState>[] = [
      selectChannels({
        asker: interactiveAsker(prompter),
        variant: "channels-add",
        presetChannels: [pick],
        validateSelection: (channels) => assertCanAddSelectedChannels(channels, registrations),
      }),
      addChannels({
        asker: interactiveAsker(prompter),
        prompter,
        configureVercelServices: true,
        deps: deps.addChannels,
      }),
    ];
    let result: Awaited<ReturnType<typeof runInteractive<SetupState>>>;
    try {
      result = await runInteractive(boxes, state, prompterSink(prompter), {
        snapshot: snapshotSetupState,
        signal,
      });
    } catch (error) {
      const observed = await withSpinner(prompter, "Checking the project…", () =>
        deps.inspectExistingChannelRegistrations(appRoot),
      );
      if (channelLandedDuringSubflow(registrations, observed, pick)) {
        state = { ...state, channels: appendChannel(state.channels, pick) };
        registrations = observed;
        retainedFailure = toErrorMessage(error);
        if (signal?.aborted === true) break;
        continue;
      }
      // A provisioning failure (login / forbidden / missing CLI) throws before
      // the channel file is scaffolded, so it never lands here — it propagates
      // to the command handler, which routes it to its fix command.
      throw error;
    }
    if (result.kind === "done") {
      state = result.state;
      registrations = await withSpinner(prompter, "Checking the project…", () =>
        deps.inspectExistingChannelRegistrations(appRoot),
      );
      signal?.throwIfAborted();
      // A fresh Slack connection only comes alive once deployed, so offer the
      // shortcut right here; "Later" falls back to the list like any other lap.
      if (
        pick === "slack" &&
        state.slackbotAttached &&
        (await promptSeeItLive(prompter)) === "deploy"
      ) {
        return {
          kind: "deploy-and-chat",
          addedChannels: state.channels,
          chat: deployAndChatDetails(state),
        };
      }
    } else {
      const observed = await withSpinner(prompter, "Checking the project…", () =>
        deps.inspectExistingChannelRegistrations(appRoot),
      );
      if (channelLandedDuringSubflow(registrations, observed, pick)) {
        return { kind: "done", addedChannels: appendChannel(state.channels, pick) };
      }
      registrations = observed;
    }
  }

  if (retainedFailure === undefined) {
    return { kind: "done", addedChannels: state.channels };
  }
  return { kind: "failed", addedChannels: state.channels, message: retainedFailure };
}
