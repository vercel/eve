import { select, type Asker, type SelectOption } from "../ask.js";
import type { ChannelKind, ChatPreference, SetupState } from "../state.js";
import type { SetupBox } from "../step.js";

const CHAT_PROMPT_MESSAGE = "Start a chat with your agent now";

/** The scaffolded facts the chat option list is derived from. */
export interface ChatPreferenceContext {
  /** Channels scaffolded earlier in the flow; controls option visibility. */
  availableChannels: ChannelKind[];
  /** Whether the Slack app was attached to the channel route and is ready to use. */
  slackbotAttached: boolean;
}

/**
 * Builds the chat-preference option list. Channel-backed options come
 * first (in the order Web -> Slack) when available, then the framework
 * built-ins (Terminal UI, API), then the explicit skip option last. Exported
 * for the unit test.
 */
export function buildChatPreferenceOptions(
  args: ChatPreferenceContext,
): SelectOption<ChatPreference>[] {
  const option = (
    value: ChatPreference,
    label: string,
    hint?: string,
  ): SelectOption<ChatPreference> => ({ id: value, label, value, hint });
  const options: SelectOption<ChatPreference>[] = [];
  if (args.availableChannels.includes("web")) {
    options.push(option("web", "Web chat", "next.js"));
  }
  if (args.availableChannels.includes("slack") && args.slackbotAttached) {
    options.push(option("slack", "Slack", "open workspace"));
  }
  options.push(option("repl", "Terminal UI"));
  options.push(option("api", "API"));
  options.push(option("skip", "Skip and chat later"));
  return options;
}

/**
 * Picks the initial cursor position so the most "user-built" option is
 * highlighted by default: Web Chat if scaffolded, then Slack (only when
 * the bot was successfully attached), then nothing (cursor falls on the first
 * option, i.e. REPL).
 */
function pickInitialPreference(args: ChatPreferenceContext): ChatPreference | undefined {
  if (args.availableChannels.includes("web")) return "web";
  if (args.availableChannels.includes("slack") && args.slackbotAttached) return "slack";
  return undefined;
}

export interface SelectChatOptions {
  /** Resolves the chat question; the composed stack decides how. */
  asker: Asker;
  /**
   * Resolve to this value without asking. The headless default ("skip") lives
   * at the composition site, not here, so a missing headless preset fails
   * fast. Stays a factory option (not a `withAnswers` rung) because a preset
   * must keep bypassing the option list, which hides choices the current
   * state did not scaffold, exactly as the dual-face box did.
   */
  presetPreference?: ChatPreference;
}

/**
 * THE CHAT BOX: final prompt of the create flow. Asks one required "chat"
 * select through the box's asker: where the user wants to chat with their
 * agent. Options are dynamic on what was scaffolded earlier. Web Chat appears
 * only if `web` is in the scaffolded channels, Slack appears only if `slack`
 * was scaffolded AND the bot was attached during the channel setup step.
 * REPL, API, and Skip are always present.
 */
export function selectChat(
  options: SelectChatOptions,
): SetupBox<SetupState, ChatPreference, ChatPreference> {
  return {
    id: "select-chat",

    async gather({ state }): Promise<ChatPreference> {
      if (options.presetPreference !== undefined) {
        return options.presetPreference;
      }
      const context: ChatPreferenceContext = {
        availableChannels: [...state.channels],
        slackbotAttached: state.slackbotAttached,
      };
      return options.asker.ask(
        select({
          key: "chat",
          message: CHAT_PROMPT_MESSAGE,
          options: buildChatPreferenceOptions(context),
          recommended: pickInitialPreference(context),
          // A headless run without a preset must fail rather than guess a
          // surface, as the dual-face box did.
          required: true,
        }),
      );
    },

    async perform({ input }): Promise<ChatPreference> {
      return input;
    },

    apply(state, payload) {
      return { ...state, chat: payload };
    },
  };
}
