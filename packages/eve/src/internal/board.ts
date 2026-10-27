// What the bundled `eve/extensions/board` extension needs from eve beyond its public exports.
export {
  createBoardChannel,
  DEFAULT_BOARD_PROFILE,
  type BoardChannelSettings,
} from "#public/channels/board/boardChannel.js";
export {
  createBoardClient,
  type BoardClient,
  type BoardClientOptions,
  type BoardMessage,
} from "#public/channels/board/client.js";
