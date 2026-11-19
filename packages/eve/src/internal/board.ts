export {
  BOARD_PROFILE_PATTERN,
  BOARD_TEXT_LIMIT,
  createBoardChannel,
  resolveBoardTarget,
  type BoardChannelSettings,
  type BoardHeldClaim,
  type BoardWorker,
} from "#public/channels/board/boardChannel.js";
export {
  createBoardClient,
  type BoardCan,
  type BoardClient,
  type BoardMessage,
  type BoardThread,
  type BoardWrittenMessage,
} from "#public/channels/board/client.js";
export { BOARD_WORKER_WATCHER } from "#public/channels/board/worker.js";

export const BOARD_UPLOAD_LIMIT = 4 * 1024 * 1024;
