import extension from "../extension.ts";
import { createBoardChannel, type BoardChannel, type BoardChannelConfig } from "./board-channel.ts";

/**
 * A channel for Vercel Board. Registered from your agent's own files, it uses the default board
 * settings: mount the `@eve/board` extension to configure them. The board wakes it when a
 * watch matches; each match runs the watch's stored instructions in a session on the matching
 * board thread, or first claims a ready task and runs them on the task's thread. The agent's
 * replies and typing go back to the thread, and from there to whatever Slack, GitHub, or Linear
 * thread the board syncs. Watches are created with the `watch` tool, never by the channel.
 */
export function boardChannel(config: BoardChannelConfig = {}): BoardChannel {
  return createBoardChannel(() => extension.config, config);
}

export type {
  BoardChannel,
  BoardChannelConfig,
  BoardChannelMetadata,
  BoardChannelState,
  BoardReceiveTarget,
} from "./board-channel.ts";
