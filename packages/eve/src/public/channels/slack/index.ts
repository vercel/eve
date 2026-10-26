export {
  slackChannel,
  type SlackApiResponse,
  type SlackAuthorizationEventContext,
  type SlackBotToken,
  type SlackChannel,
  type SlackChannelConfig,
  type SlackChannelContext,
  type SlackChannelCredentials,
  type SlackChannelState,
  type SlackContext,
  type SlackEventContext,
  type SlackEventRespondFn,
  type SlackEventRespondOptions,
  type SlackEventSendFn,
  type SlackEventSendOptions,
  type SlackHandle,
  type SlackInboundEventContext,
  type SlackInboundMessageContext,
  type SlackInboundResult,
  type SlackInitialMessage,
  type SlackAnswerContext,
  type SlackAnswerResult,
  type SlackAnswerSubmission,
  type SlackInstrumentationMetadata,
  type SlackInteractionAction,
  type SlackInteractionContext,
  type SlackSlashCommand,
  type SlackSlashCommandContext,
  type SlackShortcut,
  type SlackShortcutContext,
  type SlackShortcutMessage,
  type SlackMentionResult,
  type SlackReceiveTarget,
  type SlackSessionTarget,
  type SlackRespondOptions,
  type SlackSendOptions,
  type SlackSessionOperations,
  type SlackThread,
  type SlackWebhookVerifier,
  type SlackWorkspaceHandle,
} from "#public/channels/slack/slackChannel.js";

export type {
  SlackAttachment,
  SlackAuthor,
  SlackEvent,
  SlackEventEnvelope,
  SlackInboundContext,
  SlackMessage,
} from "#public/channels/slack/inbound.js";

export {
  callSlackApi,
  resolveSlackBotToken,
  slackContinuationToken,
  type SlackPostInput,
  type SlackPostedMessage,
  type SlackBotTokenContext,
  type SlackThreadMessage,
  type SlackUploadFilesOptions,
  type SlackUploadFilesResult,
} from "#public/channels/slack/api.js";

export { type SlackFetch, type SlackTransportOptions } from "#public/channels/slack/transport.js";

export { defaultSlackAuth } from "#public/channels/slack/defaults.js";

export {
  postCompletedSlackReply,
  type SlackCompletedReply,
} from "#public/channels/slack/reply-delivery.js";

export {
  defineSlackRenderer,
  type SlackRenderer,
  type SlackRendererEvents,
  type SlackRenderHandler,
  type SlackRenderNext,
  type SlackTaskCard,
} from "#public/channels/slack/renderers.js";

export type { TaskCard } from "#channel/task-card.js";

export {
  loadThreadContextMessages,
  type LoadThreadContextMessagesOptions,
  type ThreadContextSince,
} from "#public/channels/slack/thread.js";

export {
  cardToBlocks,
  cardToFallbackText,
  type BlockKitBlock,
} from "#public/channels/slack/blocks.js";

export {
  answerFromSlackAction,
  ANSWER_ACTION_PREFIX,
  renderInteractionBlocks,
  type DerivedHitlResponse,
  type SlackHitlAction,
  type SlackHitlRoute,
} from "#public/channels/slack/hitl.js";

/**
 * Card builders and eve-owned element types. The vendored factories remain an
 * implementation detail. These are pure data factories. They return plain typed
 * objects that the channel passes to {@link cardToBlocks} at post time.
 * The chat SDK runtime (`Chat`, `Thread`, `Adapter`, etc.) is not
 * imported and not reachable through this entry point.
 */
export {
  Actions,
  Button,
  Card,
  CardLink,
  CardText,
  Divider,
  ExternalSelect,
  Field,
  Fields,
  Image,
  LinkButton,
  Modal,
  RadioSelect,
  Section,
  Select,
  SelectOption,
  Table,
  TextInput,
  cardChildToFallbackText,
  isCardElement,
} from "#public/channels/slack/cards.js";

export type {
  ActionsElement,
  ButtonElement,
  ButtonOptions,
  ButtonProps,
  ButtonStyle,
  CardChild,
  CardElement,
  CardJSXElement,
  CardJSXProps,
  CardLinkProps,
  CardOptions,
  CardProps,
  ChatElement,
  ContainerProps,
  DividerElement,
  DividerProps,
  ExternalSelectElement,
  ExternalSelectOptions,
  ExternalSelectProps,
  FieldElement,
  FieldProps,
  FieldsElement,
  FileUpload,
  ImageElement,
  ImageProps,
  LinkButtonElement,
  LinkButtonOptions,
  LinkButtonProps,
  LinkElement,
  ModalChild,
  ModalElement,
  ModalOptions,
  ModalProps,
  PostableCard,
  RadioSelectElement,
  RadioSelectOptions,
  SectionElement,
  SelectElement,
  SelectOptionElement,
  SelectOptionProps,
  SelectOptions,
  SelectProps,
  TableAlignment,
  TableElement,
  TableOptions,
  TextElement,
  TextInputElement,
  TextInputOptions,
  TextInputProps,
  TextProps,
  TextStyle,
} from "#public/channels/slack/cards.js";
