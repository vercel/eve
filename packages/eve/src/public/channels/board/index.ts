export {
  boardChannel,
  type BoardChannel,
  type BoardChannelConfig,
  type BoardChannelContext,
  type BoardChannelEvents,
  type BoardChannelState,
  type BoardEventContext,
  type BoardInboundResult,
  type BoardMessageContext,
  type BoardReceiveTarget,
  type BoardThreadHandle,
  type BoardWatcher,
} from "#public/channels/board/boardChannel.js";
export { BoardRequestError } from "#public/channels/board/client.js";
export type {
  BoardActor,
  BoardApiOptions,
  BoardAttachment,
  BoardAuthor,
  BoardCredentials,
  BoardMessage,
  BoardPostOptions,
  BoardThread,
  BoardWrittenMessage,
} from "#public/channels/board/client.js";
export { boardThreadId, defaultBoardAuth } from "#public/channels/board/inbound.js";
