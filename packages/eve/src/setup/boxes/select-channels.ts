import { SCAFFOLDABLE_CHANNELS, type ChannelKind } from "#setup/scaffold/index.js";
import type { DisabledChannelReasons } from "#setup/cli/index.js";

import type { Asker, MultiSelectOption } from "../ask.js";
import { hasVercelProject, type SetupState } from "../state.js";
import type { SetupBox } from "../step.js";

const SLACK_REQUIRES_VERCEL =
  "Slack requires a Vercel project. Link this directory (`vercel link`) and re-run to add Slack.";

/** The channel question, shared with the dev TUI's /channels action list. */
export const CHANNELS_PROMPT_MESSAGE = "Where will you chat with your agent?";

/**
 * Sentinel for the local terminal UI (`eve dev`) row in the channel picker.
 * The terminal UI needs no scaffolding and no deploy, so its row is locked:
 * the picker auto-selects it and the user cannot toggle it off. It writes no
 * channel files, so it is stripped from the selection before that becomes
 * {@link ChannelKind}-typed scaffold input.
 */
const TUI_PICKER_VALUE = "tui";
type ChannelPickerValue = ChannelKind | typeof TUI_PICKER_VALUE;

export interface SelectChannelsOptions {
  /** Resolves the channels question; the composed stack decides how. */
  asker: Asker;
  /**
   * Resolve to these channels without asking. Stays a factory option (not a
   * `withAnswers` rung) so it keeps short-circuiting the picker exactly as the
   * dual-face box did, while still passing the Slack/Vercel gate and
   * `validateSelection` like a picked selection.
   */
  presetChannels?: ChannelKind[];
  /**
   * Picker shape, chosen explicitly because the variants differ in whether a
   * selection is required, whether the REPL row is shown, and how Slack is
   * gated. The "channels-add" picker allows an empty submission and keeps Slack
   * selectable from an unlinked directory because its add-channels box can run
   * an interactive `vercel link` on demand.
   */
  variant: "onboarding" | "in-project" | "channels-add";
  /**
   * Reasons for channel kinds that cannot be added to this project (existing
   * registrations); matching rows render disabled with the reason.
   */
  disabledChannelReasons?: DisabledChannelReasons;
  /**
   * Rejects a selection before any later box runs effects. Runs on both the
   * asked and the preset path, so a flag-driven selection is validated exactly
   * like a picked one. A throw aborts the run.
   */
  validateSelection?(channels: readonly ChannelKind[]): Promise<void> | void;
}

/**
 * THE CHANNELS BOX: interview-phase channel picker. Choosing channels is human
 * input, so it runs before any filesystem work; the channels box scaffolds the
 * chosen channels afterward from `state.channelSelection`. During onboarding
 * the deployment decision has not been made yet, so Slack is never gated here:
 * picking it is what makes the later provisioning box resolve to Vercel. Only
 * the in-project variant gates Slack, on the detected on-disk link.
 *
 * The onboarding picker is required and always carries a locked, pre-selected
 * Terminal UI row, so an empty selection is impossible: every agent can at least be
 * chatted with locally in the terminal. Web and Slack stack on top of it.
 */
export function selectChannels(
  options: SelectChannelsOptions,
): SetupBox<SetupState, ChannelKind[], ChannelKind[]> {
  const channelsAdd = options.variant === "channels-add";
  const inProject = options.variant === "in-project";

  /** Asked and preset selections both reject a Slack request without a Vercel project. */
  function assertSlackHasVercel(noVercel: boolean, channels: readonly ChannelPickerValue[]): void {
    if (noVercel && channels.includes("slack")) {
      throw new Error(SLACK_REQUIRES_VERCEL);
    }
  }

  /**
   * Slack's Vercel gate: only the in-project variant has a deployment fact to
   * gate on (the detected link). Onboarding decides deployment after this box,
   * and channels-add links on demand.
   */
  function slackLacksVercel(state: Readonly<SetupState>): boolean {
    return inProject && !hasVercelProject(state);
  }

  return {
    id: "select-channels",

    async gather({ state }): Promise<ChannelKind[]> {
      const noVercel = slackLacksVercel(state);
      if (options.presetChannels !== undefined) {
        assertSlackHasVercel(noVercel, options.presetChannels);
        await options.validateSelection?.(options.presetChannels);
        return options.presetChannels;
      }
      const scaffoldableOptions: MultiSelectOption<ChannelPickerValue>[] =
        SCAFFOLDABLE_CHANNELS.map((channel): MultiSelectOption<ChannelPickerValue> => {
          const disabledReason = options.disabledChannelReasons?.[channel.kind];
          if (disabledReason !== undefined) {
            return {
              id: channel.kind,
              value: channel.kind,
              label: channel.label,
              hint: channel.hint,
              disabled: true,
              disabledReason,
            };
          }
          if (noVercel && channel.kind === "slack") {
            return {
              id: channel.kind,
              value: channel.kind,
              label: channel.label,
              disabled: true,
              disabledReason: "needs a Vercel project",
            };
          }
          return {
            id: channel.kind,
            value: channel.kind,
            label: channel.label,
            hint: channel.hint,
          };
        });
      const tuiOption: MultiSelectOption<ChannelPickerValue> = {
        id: TUI_PICKER_VALUE,
        value: TUI_PICKER_VALUE,
        label: "Terminal UI",
        locked: true,
        lockedReason: "always available",
      };
      const selected = await options.asker.askMany<ChannelPickerValue>({
        key: "channels",
        message: CHANNELS_PROMPT_MESSAGE,
        options: channelsAdd ? scaffoldableOptions : [...scaffoldableOptions, tuiOption],
        // A headless run without preset channels must fail rather than guess a
        // channel set, in either variant, as the dual-face box did.
        required: true,
        // The empty-submission gate is the onboarding variant's: channels-add
        // accepts an empty pick (its "No channels added." path).
        requireSelection: !channelsAdd,
      });
      assertSlackHasVercel(noVercel, selected);
      // The select reducer force-selects the locked Terminal UI row, so it
      // comes back in the submission; strip it before the selection becomes
      // ChannelKind-typed scaffold input.
      const channels = selected.filter((value): value is ChannelKind => value !== TUI_PICKER_VALUE);
      await options.validateSelection?.(channels);
      return channels;
    },

    async perform({ input }): Promise<ChannelKind[]> {
      return input;
    },

    apply(state, payload) {
      return { ...state, channelSelection: payload };
    },
  };
}
