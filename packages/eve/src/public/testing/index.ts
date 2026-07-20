/**
 * Public event builders for integration tests that exercise authored hooks and
 * client replay without hand-authoring protocol objects.
 *
 * For emitter-order assertions, run the real eve harness; these builders are
 * intended for downstream lifecycle fixtures at public hook/reducer seams.
 */
export {
  createActionResultEvent,
  createInputRequestedEvent,
  createInputResponseActionResultEvent,
  createInputTerminalActionResultEvent,
  createMessageCompletedEvent,
} from "#protocol/message.js";

export type {
  ActionResultStreamEvent,
  InputResponseActionResultStreamEvent,
  InputRequestedStreamEvent,
  MessageCompletedStreamEvent,
} from "#protocol/message.js";
