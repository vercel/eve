export {
  boardChannel,
  type BoardChannel,
  type BoardChannelConfig,
  type BoardChannelContext,
  type BoardChannelEvents,
  type BoardChannelState,
  type BoardEventContext,
  type BoardHeldClaim,
  type BoardInboundResult,
  type BoardMessageContext,
  type BoardReceiveTarget,
  type BoardThreadHandle,
  type BoardWatcher,
  type BoardWorker,
} from "#public/channels/board/boardChannel.js";
export type {
  BoardActor,
  BoardAttachment,
  BoardAuthor,
  BoardMessage,
  BoardPostOptions,
  BoardTaskState,
  BoardThread,
  BoardWrittenMessage,
} from "#public/channels/board/client.js";
export { boardThreadId, defaultBoardAuth } from "#public/channels/board/inbound.js";
