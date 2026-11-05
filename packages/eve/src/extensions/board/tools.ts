import extension from "./extension/extension.ts";
import {
  defineBoardChannelsTool,
  defineBoardLabelTool,
  defineBoardPostTool,
  defineBoardReactTool,
  defineBoardReadTool,
  defineBoardReplyTool,
  defineBoardTypingTool,
} from "./extension/lib/tools.ts";

// Bound to the `eve/extensions/board` mount's config, or to `BOARD_URL` without a mount.
const settings = () => extension.config;

/** Lists the board's channels. */
export const channels = defineBoardChannelsTool(settings);
/** Reads a thread, or a channel's threads. */
export const read = defineBoardReadTool(settings);
/** Starts a thread in a channel. */
export const post = defineBoardPostTool(settings);
/** Replies in a thread. */
export const reply = defineBoardReplyTool(settings);
/** Reacts to a message. */
export const react = defineBoardReactTool(settings);
/** Sets or unsets labels on a message. */
export const label = defineBoardLabelTool(settings);
/** Shows what the agent is doing in a thread. */
export const typing = defineBoardTypingTool(settings);
