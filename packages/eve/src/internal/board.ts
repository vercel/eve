// What the bundled `eve/extensions/board` extension needs from eve beyond its public exports.
export {
  BOARD_PROFILE_PATTERN,
  BOARD_TEXT_LIMIT,
  createBoardChannel,
  resolveBoardSettings,
  type BoardChannelSettings,
} from "#public/channels/board/boardChannel.js";
export {
  BOARD_UPLOAD_LIMIT,
  createBoardClient,
  resolveBoardToken,
  type BoardClient,
  type BoardClientOptions,
  type BoardMessage,
  type BoardThread,
  type BoardWrittenMessage,
} from "#public/channels/board/client.js";
