/**
 * AI SDK conversation-message shape that the harness uses as the unit of
 * session history and turn input. Re-exported from the `ai` package so
 * authors wiring up the Slack channel can type their own message arrays
 * without taking a direct `ai` dependency.
 */
export type { ModelMessage } from "ai";

export {
  slackChannel,
  type SlackApiResponse,
  type SlackAuthorizationEventContext,
  type SlackAuthorizationRequiredHandler,
  type SlackBotToken,
  type SlackChannel,
  type SlackChannelConfig,
  type SlackChannelCredentials,
  type SlackChannelEvents,
  type SlackChannelState,
  type SlackContext,
  type SlackEventContext,
  type SlackHandle,
  type SlackInboundResult,
  type SlackInboundResultOrPromise,
  type SlackInstrumentationMetadata,
  type SlackInitialMessage,
  type SlackInteractionAction,
  type SlackMentionResult,
  type SlackMentionResultOrPromise,
  type SlackReceiveTarget,
  type SlackThread,
  type SlackWebhookVerifier,
} from "#public/channels/slack/slackChannel.js";

export type {
  SlackAttachment,
  SlackAuthor,
  SlackInboundContext,
  SlackMessage,
} from "#public/channels/slack/inbound.js";

export {
  callSlackApi,
  resolveSlackBotToken,
  slackContinuationToken,
  type SlackPostInput,
  type SlackPostedMessage,
  type SlackThreadMessage,
  type SlackUploadFilesOptions,
  type SlackUploadFilesResult,
} from "#public/channels/slack/api.js";

export { defaultSlackAuth } from "#public/channels/slack/defaults.js";

export {
  describeActionRequest,
  describeActionRequests,
} from "#public/channels/slack/action-status.js";

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

/**
 * Card builders and element types re-exported from the vendored chat
 * SDK module. These are pure data factories. They return plain typed
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
} from "#compiled/chat/index.js";

export type {
  ActionsElement,
  AdapterPostableMessage,
  Attachment,
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
} from "#compiled/chat/index.js";
