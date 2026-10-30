import { createHash } from "node:crypto";

import type {
  ChannelEventContext,
  ChannelEventOf,
  CommittedLine,
} from "#public/definitions/channel.js";
import type { SessionEvent } from "#protocol/session-event.js";
import { parseSlackWebhookBody } from "#compiled/@chat-adapter/slack/webhook.js";

import type { MessageContent } from "#shared/message-content.js";
import { toSessionSendOptions, type SessionSendOptions } from "#channel/session.js";
import type { GenericReceiveInput } from "#shared/channel-definition.js";
import type {
  ChannelFrom,
  ChannelResolveSession,
  ChannelSource,
} from "#channel/channel-operations.js";
import type { ChannelDelivery } from "#shared/channel-delivery.js";
import { SessionNotActiveError } from "#channel/session-not-active-error.js";
import type { ChannelContext } from "#shared/channel-context.js";
import type { Delivery } from "#shared/delivery.js";
import { setChannelBuildMetadata } from "#channel/compiled-channel.js";
import type { SessionAuthContext, TurnPolicy } from "#channel/types.js";
import type { VercelConnectMetadata } from "#shared/vercel-connect-metadata.js";
import type { BlockKitBlock } from "#public/channels/slack/blocks.js";
import type { SlackHitlRoute } from "#public/channels/slack/hitl.js";
import type { SessionContext } from "#public/definitions/callback-context.js";
import type { SessionHistoryMessage } from "#shared/session-history.js";
import type { ChannelContinuationOps } from "#public/definitions/channel.js";

import { maxBytesOf } from "#internal/attachments/limited-read.js";
import { createLogger, logError } from "#internal/logging.js";
import { attachInputText } from "#internal/input-text.js";
import type { Answer, StrictAnswers, ValidatedAnswer } from "#shared/input.js";
import type { Interaction } from "#channel/interaction-prompts.js";
import {
  buildSlackBinding,
  buildSlackWorkspaceHandle,
  fetchSlackThreadWindow,
  slackCodeChannelContinuationToken,
  slackContinuationToken,
  slackSessionToken,
  type SlackBotToken,
  type SlackHandle,
  type SlackThread,
  type SlackPostInput,
  type SlackWorkspaceHandle,
} from "#public/channels/slack/api.js";
import {
  resolveSlackTransportOptions,
  type SlackTransportOptions,
} from "#public/channels/slack/transport.js";
import {
  buildSlackTurnMessage,
  collectInboundFileParts,
  createSlackFetchFile,
} from "#public/channels/slack/attachments.js";
import {
  createSlackCodeChannel,
  isSlackCodeChannel,
  isSlackCodeChannelOriginContext,
  setSlackCodeChannelStatus,
  type SlackRequest,
} from "#public/channels/slack/code-channel.js";
import {
  defaultEvents,
  defaultInteractionEvents,
  defaultOnMessage,
  defaultReceived,
} from "#public/channels/slack/defaults.js";
import { withFinalReplyDelivery } from "#public/channels/slack/reply-delivery.js";
import {
  composeInteractionCards,
  composeSlackRenderers,
  type SlackRenderChain,
  type SlackRenderedEvent,
  type SlackRenderer,
} from "#public/channels/slack/renderers.js";
import {
  renderDefaultSlackTaskCard,
  type SlackTaskCardState,
  withTaskCards,
} from "#public/channels/slack/task-card.js";
import type { SlackThreadStatus } from "#public/channels/slack/thread-status.js";
import {
  parseMessageEvent,
  type SlackEvent,
  slackEventBotUserId,
  slackEventInstallationTeamId,
  slackEventReceivingBotUserId,
  type SlackEventEnvelope,
  type SlackInboundContext,
  type SlackMessage,
  parseSlackEventEnvelope,
  slackMessageFromWebhookPayload,
} from "#public/channels/slack/inbound.js";
import {
  formatSlackInboundMessage,
  formatSlackThreadContext,
  slackThreadSessionHistory,
} from "#public/channels/slack/model-context.js";
import { isPrivateSlackConversation } from "#public/channels/slack/privacy.js";
import {
  createSlackUserResolver,
  resolveSlackUsers,
  withSlackUserInfo,
  type SlackUserResolver,
  type SlackUsersOption,
} from "#public/channels/slack/user-info.js";
import {
  loadThreadContextMessages,
  type LoadThreadContextMessagesOptions,
} from "#public/channels/slack/thread.js";
import { buildSlackAuthContext, slackUserIdFromAuthContext } from "#public/channels/slack/auth.js";
import { SLACK_CHANNEL_DEFAULT_ROUTE } from "#public/channels/slack/constants.js";
import { defineSlackAppManifest } from "#public/channels/slack/app-manifest.js";
import { handleInteractionPost } from "#public/channels/slack/interactions.js";
import {
  bindSlackSessionOperations,
  withSlackResponder,
  type SlackSendOptions,
  type SlackSessionOperations,
} from "#public/channels/slack/session-operations.js";
import {
  mergeUploadPolicy,
  type UploadPolicy,
  type UploadPolicyInput,
} from "#public/channels/upload-policy.js";
import { verifySlackRequest, type SlackWebhookVerifier } from "#public/channels/slack/verify.js";
import {
  type UndeliveredReplyState,
  withUndeliveredReplyNote,
} from "#public/channels/undelivered-reply.js";
import { defineChannel, POST, type Channel } from "#public/definitions/channel.js";
import { normalizeChannelAudience, type ChannelAudience } from "#shared/channel-audience.js";
import { markEventHandled } from "./utils.js";

export type {
  SlackRespondOptions,
  SlackSendOptions,
  SlackSessionOperations,
} from "#public/channels/slack/session-operations.js";

const log = createLogger("slack.channel");
const PRIVATE_SLACK_RUN_TITLE = "Private message";

/**
 * Base Slack context for inbound webhook handlers. These hooks run before the
 * runtime hydrates session state, so `state` is absent here.
 * {@link thread} owns thread-scoped operations (`post`, `postEphemeral`,
 * `startTyping`, `refresh`, `listParticipants`, `recentMessages`,
 * `mentionUser`); {@link slack} owns Slack identity (`channelId`, `threadTs`,
 * `teamId`) plus the raw-API escape hatch (`request`, `uploadFiles`).
 */
export interface SlackContext {
  readonly thread: SlackThread;
  readonly slack: SlackHandle;
}

/**
 * {@link SlackContext} plus the persisted per-session
 * {@link SlackChannelState}. Built by the channel's `context()` hook and
 * extended by {@link SlackEventContext}.
 */
export interface SlackChannelContext extends SlackContext {
  state: SlackChannelState;
}

/**
 * Slack context handed to `events[type]` handlers. Extends
 * {@link SlackChannelContext} (`thread`, `slack`, hydrated `state`) with
 * continuation routing ({@link ChannelContinuationOps}). Unlike the pre-dispatch
 * {@link SlackContext}, `state` is hydrated here.
 */
export interface SlackEventContext extends SlackChannelContext, ChannelContinuationOps {}

export type {
  SlackApiResponse,
  SlackBotToken,
  SlackHandle,
  SlackThread,
  SlackWorkspaceHandle,
} from "#public/channels/slack/api.js";
export type { SlackWebhookVerifier } from "#public/channels/slack/verify.js";

type SlackEventHandler<T extends SessionEvent["type"]> = (
  event: ChannelEventOf<T>,
  ctx: ChannelEventContext<SlackEventContext>,
) => void | Promise<void>;

/**
 * Delivery surface handed to a renderer's sign-in `interaction.opened` handler. The
 * connection challenge is a credential: anyone who completes the sign-in
 * binds their identity to this session's connection. So the only
 * delivery capabilities here are private ones, an ephemeral reply in the
 * thread or a direct message. There is deliberately no public `post`,
 * no raw `slack.request` escape hatch, and no full thread handle. An
 * override can change the words, not the audience.
 */
export interface SlackAuthorizationEventContext {
  /**
   * Ephemeral message in the current thread, visible only to `userId`.
   * Same contract as {@link SlackThread.postEphemeral}.
   */
  readonly postEphemeral: SlackThread["postEphemeral"];
  /**
   * Direct message to `userId`'s IM conversation with the bot. Same
   * contract as {@link SlackThread.postDirectMessage} (requires the
   * `im:write` scope).
   */
  readonly postDirectMessage: SlackThread["postDirectMessage"];
  /**
   * Hydrated per-session channel state. Resolve the recipient with
   * `slackUsersByPrincipal[eventData.principalId]`.
   */
  readonly state: SlackChannelState;
}

/** One request's controls in a posted card message. */
export interface SlackInteractionCardRequest {
  readonly interactionId: string;
  /** The controls blocks the message shows for this request now. */
  readonly blocks: readonly BlockKitBlock[];
  /** The separate details message, deleted once every request it covers settled. */
  readonly detailsTs?: string;
  /**
   * Set once eve sent the request's settled rendering, even if Slack refused it, so a failed
   * update is never retried forever. The message is forgotten once every request has it.
   */
  readonly settled?: true;
}

/** A message eve posted holding the controls of one or more input requests. */
export interface SlackInteractionCardRecord {
  /** The message's conversation: the session's channel, or the reviewer's DM. */
  readonly channelId: string;
  readonly ts: string;
  readonly destination: SlackApprovalChannel;
  /** The session a card's controls answer back to: a direct message's thread, or a code channel. */
  readonly route?: SlackHitlRoute;
  /** Thread post announcing a direct-message request; updated with the outcome. */
  readonly announcementTs?: string;
  readonly requests: readonly SlackInteractionCardRequest[];
}

/**
 * JSON-serializable per-session state, stored verbatim across workflow
 * step boundaries. Anything written here must round-trip through
 * `JSON.stringify` / `JSON.parse`.
 */
export interface SlackChannelState extends UndeliveredReplyState {
  /** Audience classification captured before the session is dispatched. */
  audience?: ChannelAudience;
  /** Slack channel id seeded by the inbound mention. */
  channelId: string | null;
  /** Slack thread root ts; `null` in a code channel, which is one session across its threads. */
  threadTs: string | null;
  /** Whether this session serves a Slack code channel. */
  codeChannel?: boolean;
  /**
   * In a code channel, the thread of the message the current turn answers;
   * `null` posts top-level.
   * @internal
   */
  replyThreadTs?: string | null;
  /**
   * In a code channel, the thread of the latest delivered message, which the
   * next turn replies in.
   * @internal
   */
  pendingReplyThreadTs?: string | null;
  /** Slack team id, when the inbound event carried one. */
  teamId: string | null;
  /** Slack message ts that triggered the active turn. */
  triggeringMessageTs?: string | null;
  /** Slack workspace whose app installation supplies this session's credentials. */
  installationTeamId?: string | null;
  /**
   * Slack user id of the actor that triggered the current session/turn.
   * A later message can change it, so sign-in and approval handlers address
   * recipients through `slackUsersByPrincipal` instead.
   */
  triggeringUserId?: string | null;
  /**
   * Buffered narration from a `content.completed` event (`phase: "narration"`). The default `call.requested` handler uses the
   * first non-empty line as the next typing indicator, surfacing the
   * model's pre-tool narration instead of the action label. Cleared at
   * `turn.started` and after use.
   * @internal
   */
  pendingToolCallMessage?: string | null;
  /**
   * The thread status the default renderer last set. A later model step shows
   * it again, as does a new task card, which Slack clears the status for.
   * @internal
   */
  threadStatus?: SlackThreadStatus | null;
  /**
   * Connection name to Slack message ts. Each entry is the public
   * link-free status post created by the default
   * sign-in `interaction.opened` handler; the matching
   * sign-in `interaction.settled` handler edits it in place to surface the
   * resolution outcome.
   * @internal
   */
  pendingAuthMessageTs?: Record<string, string>;
  /**
   * @internal The messages holding open or recently answered approvals, questions, and budget prompts.
   * Each is updated as its requests change and forgotten once all of them settle. eve ignores
   * the `pendingApprovalCards` field that earlier versions wrote, so cards posted before an
   * upgrade keep their buttons.
   */
  interactionCards?: readonly SlackInteractionCardRecord[];
  /**
   * Each recent turn's tool calls and the task card eve last wrote for it, by
   * turn id. The default `turn.paused` handler names the working tasks.
   * @internal
   */
  taskCards?: Record<string, SlackTaskCardState> | null;
  /**
   * Tasks that settled since the turn's last model step: each named agent, or
   * `null` for another task. The default `step.started` handler shows
   * `Reviewing results...` for the step that reads them.
   * @internal
   */
  pendingTaskResults?: {
    readonly names: readonly (string | null)[];
    readonly turnId: string;
  } | null;
  /**
   * Principal id to Slack user id, recorded as each message or input response
   * is delivered. Default handlers use it to address the principal named on
   * sign-in `interaction.opened` and approval events.
   */
  slackUsersByPrincipal?: Record<string, string>;
  /**
   * Whether eve has posted in this thread. Once it has, deleting the root
   * leaves a tombstone that keeps the thread, so the final reply skips the
   * deleted-root check.
   * @internal
   */
  postedInThread?: boolean;
}

/**
 * Per-session metadata attached to tracing spans, projected by the
 * channel's `metadata(state)` hook. Fields mirror the inbound mention
 * (channel, team, thread, triggering user) and are `null` until an inbound
 * event seeds them. Open-ended (`Record<string, unknown>`) so deployments
 * can attach extra span attributes.
 */
export interface SlackInstrumentationMetadata extends Record<string, unknown> {
  readonly channelId: string | null;
  readonly teamId: string | null;
  readonly threadTs: string | null;
  readonly triggeringUserId: string | null;
  /** `true` in a code channel session; absent elsewhere. */
  readonly codeChannel?: true;
}

/**
 * Slack channel credentials: outbound bot token plus inbound webhook
 * verification. Any field may be omitted to fall back to its env-var /
 * signing-secret default.
 */
export interface SlackChannelCredentials {
  /**
   * Bot token for all outbound Slack Web API calls. Function providers receive
   * the app installation workspace id when Slack supplies one. Falls back to
   * `process.env.SLACK_BOT_TOKEN` when omitted.
   */
  readonly botToken?: SlackBotToken;
  /**
   * Signing secret used to HMAC-verify inbound webhook requests. Falls
   * back to `process.env.SLACK_SIGNING_SECRET` when neither this nor
   * `webhookVerifier` is supplied.
   */
  readonly signingSecret?: string;
  /**
   * Custom inbound webhook verifier. When supplied, eve skips the
   * `SLACK_SIGNING_SECRET` fallback and delegates to it. Typically set by
   * integrations (e.g. Connect) that authenticate webhooks out-of-band.
   */
  readonly webhookVerifier?: SlackWebhookVerifier;
  /** Build-time metadata supplied by Vercel Connect credential helpers. */
  readonly vercelConnect?: VercelConnectMetadata;
}

/** Target accepted by `ctx.to(slack, target)` from route and schedule handlers. */
export interface SlackReceiveTarget {
  readonly channelId: string;
  readonly threadTs?: string;
  /**
   * Optional audience for proactive receives. Omit to leave `unknown`.
   * Pass when the caller already knows channel visibility, for example a
   * webhook or schedule that classified the Slack destination before handoff.
   */
  readonly audience?: ChannelAudience;
  /** Slack workspace whose app installation supplies credentials for this send. */
  readonly installationTeamId?: string;
  /**
   * Optional message posted into the Slack channel before the agent runs.
   * The post becomes the thread root and the first turn is threaded under
   * it, giving cross-channel handoffs a visible context anchor. Mutually
   * exclusive with {@link threadTs}.
   */
  readonly initialMessage?: SlackInitialMessage;
  /**
   * Opens a Slack code channel from a message in {@link channelId} and starts
   * the session there, as the code channel's one session. Slack links the
   * channel and the origin message to each other. One requester gets one code
   * channel per origin message, so a repeated send joins that channel's
   * session. Requires `codeChannels: true`. Mutually exclusive with
   * {@link threadTs} and {@link initialMessage}.
   */
  readonly codeChannel?: SlackCodeChannelTarget;
}

/** The code channel `slackChannel().receive` opens for `target.codeChannel`. */
export interface SlackCodeChannelTarget {
  /** Channel name shown in Slack. Omit it to let Slack name the channel from the message. */
  readonly name?: string;
  /** ts of the message the code channel continues. */
  readonly originTs: string;
  /** Thread of the origin message: its own ts when top-level. */
  readonly originThreadTs: string;
}

/**
 * Pre-agent post issued by `slackChannel().receive` when the caller
 * provides `target.initialMessage`. Accepts the same explicit message forms
 * as `ctx.thread.post`: Markdown, text, blocks, or a card, plus optional files.
 *
 * Unlike `thread.post({ text, files })`, which sends one message with the files
 * attached, this posts the root message first and then uploads files as a
 * threaded reply. Upload failures are logged, not thrown, so the run still starts.
 */
export type SlackInitialMessage = SlackPostInput;

/**
 * Options for one turn requested by a generic Slack event handler.
 */
export type SlackEventSendOptions = SessionSendOptions & {
  readonly target: SlackReceiveTarget;
};

/** Options for answering pending input requests from a generic Slack event handler. */
export interface SlackEventRespondOptions {
  readonly auth: SessionAuthContext | null;
  readonly target: SlackSessionTarget;
}

/**
 * Starts a session on the current Slack channel from `onEvent`. Call it zero,
 * one, or many times; each invocation returns the resulting session.
 */
export type SlackEventSendFn = (
  message: MessageContent,
  options: SlackEventSendOptions,
) => Promise<Delivery>;

/** Answers pending input requests on one Slack thread. */
export type SlackEventRespondFn = <const TResponses extends readonly Answer[]>(
  answers: StrictAnswers<TResponses>,
  options: SlackEventRespondOptions,
) => ReturnType<SlackSessionOperations["respond"]>;

/**
 * Slack session identity used by workspace-scoped inbound helpers: a thread,
 * or a code channel, whose one session spans all of its threads.
 */
export type SlackSessionTarget =
  | {
      readonly channelId: string;
      readonly threadTs: string;
      readonly codeChannel?: never;
    }
  | {
      readonly channelId: string;
      readonly codeChannel: true;
      readonly threadTs?: never;
    };

/**
 * Imperative surface handed to `slackChannel({ onEvent })`. Generic Events API
 * payloads are not necessarily tied to one thread, so the context exposes a
 * workspace API handle plus Slack-bound operations rather than the
 * thread-scoped {@link SlackContext} used by message handlers.
 */
export interface SlackInboundEventContext {
  /** Starts a turn on this Slack channel using the proactive send contract. */
  readonly send: SlackEventSendFn;
  /** Answers pending input requests on one Slack thread. */
  readonly respond: SlackEventRespondFn;
  /** Cancels the active turn for one Slack thread. */
  cancel(input: {
    readonly target: SlackSessionTarget;
    readonly turnId?: string;
  }): ReturnType<ChannelSource<SlackChannelState>["cancel"]>;
  /** Compacts the current session for one Slack thread. */
  compact(input: {
    readonly target: SlackSessionTarget;
  }): ReturnType<ChannelSource<SlackChannelState>["compact"]>;
  /** Clears the current session for one Slack thread. */
  clear(input: {
    readonly target: SlackSessionTarget;
  }): ReturnType<ChannelSource<SlackChannelState>["clear"]>;
  /** Retires the current session for one Slack thread without creating a replacement. */
  end(input: {
    readonly reason?: string;
    readonly target: SlackSessionTarget;
  }): ReturnType<ChannelSource<SlackChannelState>["end"]>;
  /** Resolves the current session for one Slack thread. */
  resolveSession(input: { readonly target: SlackSessionTarget }): ReturnType<ChannelResolveSession>;
  /** The complete signed Events API callback envelope. */
  readonly envelope: SlackEventEnvelope;
  /** Workspace-scoped Slack identity and raw Web API escape hatch. */
  readonly slack: SlackWorkspaceHandle;
  /** Keeps detached handler work alive after the Slack webhook is acknowledged. */
  readonly waitUntil: (task: Promise<unknown>) => void;
}

/**
 * Message-scoped context handed to `onMessage`, `onAppMention`, and
 * `onDirectMessage`.
 */
export interface SlackInboundMessageContext extends SlackContext, SlackSessionOperations {
  /**
   * Returns whether the inbound message belongs to a DM, group DM, or private channel.
   * Unknown conversation types fail closed and return `true`.
   */
  isDMOrPrivateChannel(): Promise<boolean>;
  /** Returns whether this message belongs to a thread with an active eve session. */
  isSubscribed(): Promise<boolean>;
  /** Returns whether the inbound event explicitly mentions this bot. */
  isBotMentioned(): boolean;
  /**
   * Opens a Slack code channel from this message and returns session
   * operations bound to the channel's one session. Slack links the channel
   * in this thread. Send the first turn with the returned `send`, then return
   * `null` to give the thread no turn. One author gets one code channel per
   * message, so calling it again returns the same channel. Requires
   * `codeChannels: true`, and throws for a message already in a code channel.
   */
  openCodeChannel(options?: SlackOpenCodeChannelOptions): Promise<SlackOpenedCodeChannel>;
}

/** Options for `ctx.openCodeChannel()`. */
export interface SlackOpenCodeChannelOptions {
  /** Channel name shown in Slack. Omit to let Slack name it from the message. */
  readonly name?: string;
}

/** A code channel opened by `ctx.openCodeChannel()`, bound to its one session. */
export interface SlackOpenedCodeChannel extends SlackSessionOperations {
  /** Slack channel id of the new code channel. */
  readonly channelId: string;
}

/** Interaction-scoped context handed to `slackChannel({ onInteraction })`. */
export interface SlackInteractionContext extends SlackContext, SlackSessionOperations {}

/** Workspace-scoped context handed to `slackChannel({ onShortcut })`. */
export interface SlackShortcutContext {
  /** Slack workspace identity and raw Web API escape hatch. */
  readonly slack: SlackWorkspaceHandle;
}

/** Workspace-scoped context handed to `slackChannel({ onSlashCommand })`. */
export interface SlackSlashCommandContext {
  /** Slack workspace identity and raw Web API escape hatch. */
  readonly slack: SlackWorkspaceHandle;
}

/** Context handed to `slackChannel({ onAnswers })` before eve resumes HITL. */
export interface SlackAnswerContext extends SlackContext {
  /** Auth derived from the Slack user who submitted the signed interaction. */
  readonly defaultAuth: SessionAuthContext;
}

export interface SlackInteractionAction {
  readonly actionId: string;
  readonly value?: string;
  readonly blockId?: string;
  /**
   * `selected_option.value` for radio / select / external_select
   * widgets. `undefined` for buttons and multi-select widgets.
   */
  readonly selectedOptionValue?: string;
  /**
   * `ts` of the Slack message hosting the clicked component. Required to
   * update that message in place via `chat.update`, since `ctx.slack.threadTs`
   * resolves to the thread root (not the clicked message) for components
   * inside thread replies.
   */
  readonly messageTs?: string;
  /**
   * Slack `trigger_id` of the click. Pass it to `views.open` (for example
   * through `ctx.slack.request`) to open a modal from a message button. Slack
   * accepts it for about 3 seconds, so call `views.open` first in the handler.
   */
  readonly triggerId?: string;
  /**
   * Display label of the clicked widget: `text.text` for buttons,
   * `selected_option.text.text` for radio/static_select. Renders the
   * "answered" card without re-fetching the original request.
   */
  readonly label?: string;
  /**
   * Slack actor who triggered the interaction, letting `onInteraction`
   * handlers attribute resolutions back to the clicker without re-parsing
   * the raw payload. Always present, since Slack requires `user` on every
   * `block_actions` payload.
   */
  readonly user: SlackInteractionUser;
}

/** Slack actor on an interactive payload, mirroring `body.user`. */
export interface SlackInteractionUser {
  readonly id: string;
  /** Modern canonical display handle. */
  readonly username?: string;
  /** Legacy display handle, kept for older workspaces. */
  readonly name?: string;
}

/** Decoded Slack slash command invocation. */
export interface SlackSlashCommand {
  /** Configured command name, including its leading slash. */
  readonly command: string;
  readonly text: string;
  readonly user: SlackInteractionUser;
  readonly teamId?: string;
  readonly channelId: string;
  readonly channelName?: string;
  readonly enterpriseId?: string;
  readonly isEnterpriseInstall: boolean;
  readonly triggerId?: string;
  readonly responseUrl?: string;
}

/** Message selected through a Slack message shortcut. */
export interface SlackShortcutMessage {
  readonly text: string;
  readonly ts: string;
  readonly threadTs?: string;
  readonly userId?: string;
}

/** Decoded Slack message shortcut or global shortcut. */
export type SlackShortcut =
  | {
      readonly type: "message_action";
      readonly callbackId: string;
      readonly triggerId: string;
      readonly user: SlackInteractionUser;
      readonly teamId?: string;
      readonly channelId: string;
      readonly message: SlackShortcutMessage;
      readonly responseUrl?: string;
    }
  | {
      readonly type: "shortcut";
      readonly callbackId: string;
      readonly triggerId: string;
      readonly user: SlackInteractionUser;
      readonly teamId?: string;
    };

/** Decoded eve-owned HITL response submitted through Slack interactivity. */
export type SlackAnswerSubmission =
  | {
      readonly type: "block_actions";
      readonly answers: readonly ValidatedAnswer[];
      readonly actions: readonly SlackInteractionAction[];
      readonly messageTs?: string;
      readonly user: SlackInteractionUser;
    }
  | {
      readonly type: "view_submission";
      readonly answers: readonly ValidatedAnswer[];
      readonly messageTs: string;
      readonly user: SlackInteractionUser;
    };

/** Result of a Slack HITL response admission hook. Return `null` to reject. */
export type SlackAnswerResult = { readonly auth: SessionAuthContext | null } | null;

/**
 * Result of an `onAppMention` or `onDirectMessage` callback. Return an
 * object (auth may be `null`) to dispatch a turn, or `null` to drop the
 * inbound message. `context` strings are appended as user messages to
 * session history before the delivery message. `history` entries are added as
 * user and assistant turns before it; when present, `threadContext` keeps its
 * transcript and never seeds. `title` overrides the workflow run title without
 * changing the message sent to the model.
 */
export type SlackMentionResult = {
  readonly auth: SessionAuthContext | null;
  readonly context?: readonly string[];
  readonly history?: readonly SessionHistoryMessage[];
  readonly title?: string;
} | null;

/**
 * Alias of {@link SlackMentionResult} for the `onDirectMessage` signature,
 * so DM handlers do not read in terms of "mention".
 */
export type SlackInboundResult = SlackMentionResult;

/** {@link SlackInboundResult}, or a promise resolving to one. */

/**
 * eve's full-context Slack event handlers: the innermost link of every
 * channel's renderer chain. The default sign-in `interaction.opened` handler keeps
 * the full {@link SlackEventContext} because it owns the public link-free
 * status, which authored renderers, limited to private delivery, can't post.
 */
export type SlackChannelInternalEvents = {
  readonly [T in SlackRenderedEvent]?: SlackEventHandler<T>;
} & {
  readonly committed?: (
    line: CommittedLine,
    ctx: Parameters<SlackEventHandler<"turn.started">>[1],
  ) => void | Promise<void>;
};

export type SlackApprovalChannel = "direct-message" | "thread";

/** Input request passed to a {@link SlackApprovalChannelResolver}. */
export type SlackApprovalRequest = Interaction;

/** Chooses the Slack destination for one input request. */
export type SlackApprovalChannelResolver = (
  request: SlackApprovalRequest,
  ctx: SessionContext,
) => SlackApprovalChannel | Promise<SlackApprovalChannel>;

export interface SlackChannelConfig {
  /** Slack API transport overrides: base URLs and a custom fetch. */
  readonly api?: SlackTransportOptions;
  readonly credentials?: SlackChannelCredentials;
  readonly botName?: string;

  /**
   * Chooses where each input request is delivered. Direct-message requests go to the
   * Slack user who triggered the active turn; the session thread names that reviewer
   * without exposing the request. Defaults to `"thread"` when omitted.
   */
  readonly approvalChannel?: SlackApprovalChannelResolver;

  /** Override the default webhook route path (`/eve/v1/slack`). */
  readonly route?: string;
  /** Policy for accepted messages that arrive while a turn is active. */
  readonly turnPolicy?: TurnPolicy;

  /**
   * Serves each Slack code channel as one session and answers every message in
   * it, not just mentions. Un-mentioned messages go to `onMessage`, else
   * `onAppMention` (where `ctx.isBotMentioned()` returns `false`), else the
   * default handler. Adds the code channel scopes, events, and feature flag to
   * the app manifest. Without it, eve treats a code channel like any other
   * channel and never looks one up.
   */
  readonly codeChannels?: boolean;

  /**
   * Inbound upload policy applied to file attachments before they reach
   * the harness. Violating attachments are dropped with a warning so the
   * mention's text portion still gets delivered. Pass `"disabled"` to
   * reject every attachment. Defaults to the framework's 25 MB cap with
   * unrestricted media types.
   */
  readonly uploadPolicy?: UploadPolicyInput;

  /**
   * Adds earlier replies from the current Slack thread to each triggering
   * turn. Messages are rendered with their Slack sender ids attached so a
   * multi-user transcript retains unambiguous speaker attribution. When the
   * message starts the thread's session, the same replies are added as
   * history instead: this app's replies become assistant turns. Omit this
   * option to avoid fetching thread history.
   */
  readonly threadContext?: LoadThreadContextMessagesOptions;

  /**
   * Adds to what eve attaches to each model-visible `<slack_message>`.
   */
  readonly messageContext?: {
    /**
     * Looks up each human sender with `users.info` and adds `display_name`
     * and `real_name` to their `<sender>` block, plus `email` with
     * `email: true` (`name: false` leaves names out), including
     * `threadContext` replies. The triggering author
     * is also written to `message.author` (`fullName`, `displayName`,
     * `email`) and to the default Slack auth attributes: before
     * `onAppMention` and `onDirectMessage` run, and for other channel
     * messages only once a hook delivers them.
     *
     * `true` caches results in memory per workspace and user for an hour.
     * `resolve(user, next)` owns caching instead; `next()` is the uncached
     * `users.info` call. A lookup that fails or takes over two seconds is
     * left out, and the message is still delivered.
     *
     * Adds the `users:read` scope to the app manifest, and `users:read.email`
     * with `email: true`. Off by default: names and emails then reach model
     * context, session history, and traces.
     */
    readonly users?: SlackUsersOption;
  };

  /**
   * Handles human-authored Slack messages. Specialized `onAppMention` and
   * `onDirectMessage` handlers take precedence for their event types. Other
   * channel messages are ignored when this hook is omitted.
   */
  onMessage?(
    ctx: SlackInboundMessageContext,
    message: SlackMessage,
  ): SlackMentionResult | Promise<SlackMentionResult>;

  /**
   * Invoked when a Slack `app_mention` event arrives (only `app_mention`;
   * other event types are ignored). Decides whether to dispatch and with
   * what auth. It renders nothing: the renderer chain's `received`
   * acknowledges the mention while this hook runs.
   *
   * Return `{ auth }` to dispatch with that session auth context, or `null`
   * to drop the mention. May be sync or async; the result is awaited before
   * dispatching. Thrown errors are caught and logged and the mention is
   * dropped. Defaults to a workspace-scoped auth derivation.
   */
  onAppMention?(
    ctx: SlackInboundMessageContext,
    message: SlackMessage,
  ): SlackMentionResult | Promise<SlackMentionResult>;

  /**
   * Invoked on a direct message: a Slack `message` event with
   * `channel_type: "im"`. Subtype messages (edits, deletes, joins, etc.)
   * and bot messages (`bot_id` set, including the bot's own replies) are
   * filtered out first, so handlers only see plain user-authored DMs.
   * Decides whether to dispatch and with what auth. It renders nothing: the
   * renderer chain's `received` acknowledges the message while this hook runs.
   *
   * Return `{ auth }` to dispatch with that session auth context, or `null`
   * to drop the message. May be sync or async; the result is awaited before
   * dispatching. Thrown errors are caught and logged and the message is
   * dropped. Defaults to a workspace-scoped auth derivation.
   * Requires the bot's Slack app to subscribe to `message.im` with the
   * `im:history` scope.
   */
  onDirectMessage?(
    ctx: SlackInboundMessageContext,
    message: SlackMessage,
  ): SlackMentionResult | Promise<SlackMentionResult>;

  /**
   * Fallback handler for signed Slack Events API callbacks. An authored
   * `onAppMention` or `onDirectMessage` takes precedence for events accepted
   * by that specialized handler; otherwise the raw event arrives here. When
   * neither a specialized handler nor `onEvent` is authored, mentions and DMs
   * retain their built-in defaults and other event types are ignored.
   *
   * The handler owns control flow. Call `ctx.send(...)` zero, one, or many
   * times to start turns on Slack, and use `ctx.waitUntil(...)` for detached
   * work. The return value is ignored. Runs after the webhook has been
   * acknowledged through the host's `waitUntil` mechanism. Errors are caught
   * and logged and never fall through to another handler.
   *
   * URL verification, slash commands, and interactive payloads are not Events
   * API callbacks and do not reach this handler.
   */
  onEvent?(ctx: SlackInboundEventContext, event: SlackEvent): void | Promise<void>;

  /**
   * Handler for Slack `block_actions` interactive callbacks (button
   * clicks, select changes, etc.) **not** consumed by the framework's
   * HITL pipeline. Slack POSTs interactive payloads to the same webhook
   * route as mentions; the framework decodes them, routes any action whose
   * `action_id` starts with `eve_input:` to the runtime as an HITL
   * response (resuming a paused session), and forwards everything else
   * here, one invocation per non-HITL action.
   *
   * Runs on the inbound webhook side via `waitUntil()`, so the channel
   * returns `200 OK` immediately. Errors are caught and logged; they do
   * not affect the webhook response or sibling invocations.
   *
   * The `SlackContext` here is rebuilt from the interaction payload
   * (channel id, thread ts, team id), **not** the persisted thread state
   * used by event handlers. Use `ctx.slack.request(...)` for arbitrary
   * Slack Web API calls and `action.messageTs` to target `chat.update`.
   */
  onInteraction?(
    action: SlackInteractionAction,
    ctx: SlackInteractionContext,
  ): void | Promise<void>;

  /**
   * Handles Slack message shortcuts (`message_action`) and global shortcuts
   * (`shortcut`) with workspace-scoped Slack Web API access.
   *
   * eve returns `200 OK` immediately and keeps the handler alive through
   * `waitUntil()`. Errors are caught and logged.
   */
  onShortcut?(shortcut: SlackShortcut, ctx: SlackShortcutContext): void | Promise<void>;

  /**
   * Handles Slack slash commands configured with this channel's webhook route.
   * The command includes the configured command name, arguments, invoking user,
   * channel, workspace, trigger ID, and response URL.
   *
   * eve returns an empty `200 OK` immediately and keeps the handler alive
   * through `waitUntil()`. Errors are caught and logged.
   */
  onSlashCommand?(command: SlackSlashCommand, ctx: SlackSlashCommandContext): void | Promise<void>;

  /**
   * Authorizes an eve-owned HITL answer before the pending input resolves.
   * Return `{ auth }` to accept the response, or `null` to reject it and keep
   * the request pending. Thrown errors are logged and treated as rejection.
   *
   * When this hook is omitted, Slack preserves its built-in behavior and
   * accepts the response with the submitting user's auth, regardless of other
   * authored handlers.
   */
  onAnswers?(
    ctx: SlackAnswerContext,
    submission: SlackAnswerSubmission,
  ): SlackAnswerResult | Promise<SlackAnswerResult>;

  /**
   * Renderers that wrap eve's default Slack rendering, outermost first. Omit
   * it and eve renders with its default alone. Each renderer can acknowledge
   * messages (`received`), render session events (`events`), and shape the
   * task card (`taskCard`). A handler runs the rest of the chain, ending with
   * eve's default, by calling `next`, and skips it by not calling it.
   */
  readonly renderers?: readonly SlackRenderer[];
}

function rebuildSlackContext(
  state: SlackChannelState,
  session: ChannelContext,
  api: SlackTransportOptions | undefined,
  credentials: SlackChannelCredentials | undefined,
): SlackChannelContext {
  const { thread, slack } = buildSlackBinding({
    api,
    botToken: credentials?.botToken,
    channelId: state.channelId ?? "",
    threadTs: state.threadTs ?? "",
    codeChannel: state.codeChannel === true,
    // Read at post time: `deliver` may move replies to a new thread after the context is built.
    replyThreadTs: () => state.replyThreadTs ?? undefined,
    installationTeamId: state.installationTeamId ?? undefined,
    teamId: state.teamId ?? undefined,
    onThreadTsChanged(ts) {
      state.threadTs = ts;
      if (state.channelId) {
        session.continuation?.alias(
          slackContinuationToken({ channelId: state.channelId, threadTs: ts }),
        );
      }
    },
    onPosted() {
      state.postedInThread = true;
    },
  });
  return { thread, slack, state };
}

/**
 * Concrete return type of {@link slackChannel}. Named so consumers can
 * default-export a `slackChannel(...)` call under `declaration: true`
 * without TypeScript emitting an internal path for `Channel`.
 */
export interface SlackChannel extends Channel<
  SlackChannelState,
  SlackReceiveTarget,
  SlackInstrumentationMetadata
> {}

/**
 * Slack channel factory. Wires up the webhook route, message dispatch,
 * interaction handling, and eve's default rendering: the `Thinking...`
 * acknowledgement, status lines, replies, questions, sign-ins, errors, and a
 * live task card for each turn that starts tasks. Message hooks decide whether
 * and how to dispatch; `renderers` wrap the default rendering without
 * replacing it.
 */
export function slackChannel(config: SlackChannelConfig = {}): SlackChannel {
  const api = resolveSlackTransportOptions(config.api);
  const uploadPolicy = mergeUploadPolicy(config.uploadPolicy);
  const usersOption = config.messageContext?.users;
  const userResolver = createSlackUserResolver(usersOption);
  const slackFetchFile = createSlackFetchFile({
    api,
    botToken: config.credentials?.botToken,
    maxBytes: maxBytesOf(uploadPolicy),
  });
  const onAnswers = config.onAnswers ?? defaultOnAnswers;
  const interactionCard = composeInteractionCards(config.renderers ?? []);
  const rendering = composeSlackRenderers(config.renderers ?? [], {
    events: {
      ...defaultEvents,
      ...defaultInteractionEvents(config.approvalChannel, interactionCard),
    },
    received: defaultReceived,
    taskCard: renderDefaultSlackTaskCard,
  });
  const renderTurnStarted = rendering.events["turn.started"];
  const events = withTaskCards(
    {
      ...rendering.events,
      "content.completed": withFinalReplyDelivery(rendering.events["content.completed"]),
      async "turn.started"(event, ctx) {
        const { channel } = ctx;
        const triggeringUserId = slackUserIdFromAuthContext(ctx.session.auth.current);
        if (triggeringUserId !== undefined) {
          channel.state.triggeringUserId = triggeringUserId;
        }
        // A message folded into a running turn doesn't move that turn's replies.
        if (channel.state.pendingReplyThreadTs !== undefined) {
          channel.state.replyThreadTs = channel.state.pendingReplyThreadTs;
          channel.state.pendingReplyThreadTs = undefined;
        }
        await renderTurnStarted?.(event, ctx);
      },
    },
    rendering.taskCard,
  );

  // Set of events we've already handled on this process.
  // Light weight dedup mechanism - not reliable across multiple invocations.
  const handledEvents = new Set<string>();

  const channel = defineChannel<
    SlackChannelState,
    SlackChannelContext,
    SlackReceiveTarget,
    SlackInstrumentationMetadata
  >({
    turnPolicy: config.turnPolicy,
    uploadPolicy: config.uploadPolicy,
    state: {
      channelId: null as string | null,
      threadTs: null as string | null,
      teamId: null as string | null,
      installationTeamId: null as string | null,
      triggeringUserId: null,
      triggeringMessageTs: null,
      pendingToolCallMessage: null,
      pendingAuthMessageTs: {},
      interactionCards: [],
      slackUsersByPrincipal: {},
    },
    fetchFile: slackFetchFile,
    metadata(state): SlackInstrumentationMetadata {
      return {
        channelId: state.channelId,
        teamId: state.teamId,
        threadTs: state.threadTs,
        triggeringUserId: state.triggeringUserId ?? null,
        // Unlisted in SlackInstrumentationMetadata, so not public API: openCodeChannel() locates
        // the conversation with these whatever auth the session runs as.
        installationTeamId: state.installationTeamId ?? null,
        triggeringMessageTs: state.triggeringMessageTs ?? null,
        ...(state.codeChannel === true && { codeChannel: true }),
      };
    },
    audience: ({ state }) => state.audience ?? "unknown",

    context(state, session) {
      return rebuildSlackContext(state, session, api, config.credentials);
    },

    // The runtime hands `deliver` the full adapter context; `session.auth.current`
    // is the caller of this delivery.
    deliver(
      payload,
      channel: SlackChannelContext & { readonly session: ChannelContext["session"] },
    ) {
      recordSlackPrincipal(channel.state, channel.session.auth.current, payload);
      followReplyThread(channel.state, payload);
      followTriggeringMessage(channel.state, payload);
      return withUndeliveredReplyNote(channel.state, payload, "Slack");
    },

    routes: [
      POST<SlackChannelState>(config.route ?? SLACK_CHANNEL_DEFAULT_ROUTE, async (req, args) => {
        const { waitUntil } = args;
        const { from, resolveSession } = args;
        const body = await verifyInbound(req, config.credentials);
        if (body === null) return new Response("unauthorized", { status: 401 });

        if (shouldDropSlackHttpTimeoutRetry(req.headers)) {
          return new Response("ok");
        }

        const contentType = req.headers.get("content-type") ?? "";
        if (contentType.includes("application/x-www-form-urlencoded")) {
          return handleInteractionPost(
            body,
            { from, resolveSession, waitUntil },
            { api, config, onAnswers },
          );
        }
        return handleEventPost({
          api,
          body,
          from,
          resolveSession,
          waitUntil,
          config,
          received: rendering.received,
          userResolver,
          uploadPolicy,
          handledEvents,
          headers: req.headers,
        });
      }),
    ],

    receive(input, { from }) {
      return receiveOnSlack(input, {
        from,
        api,
        codeChannels: config.codeChannels === true,
        credentials: config.credentials,
      });
    },

    events,
  });
  const credentials = config.credentials as { readonly vercelConnect?: unknown } | undefined;
  const manifest = defineSlackAppManifest({
    botName: config.botName,
    codeChannels: config.codeChannels === true,
    users: userResolver !== undefined,
    userEmails: typeof usersOption === "object" && usersOption.email === true,
  });
  setChannelBuildMetadata(channel, (channelName) => ({
    externalCredentials: credentials?.vercelConnect,
    manifest: manifest.build(channelName),
  }));
  return channel;
}

function defaultOnAnswers(ctx: SlackAnswerContext): SlackAnswerResult {
  return { auth: ctx.defaultAuth };
}

/**
 * Shared proactive Slack receive path used by both the channel's public
 * `receive` hook and the pre-bound `send` function exposed to `onEvent`.
 */
async function receiveOnSlack(
  input: GenericReceiveInput<SlackReceiveTarget>,
  deps: {
    readonly from: ChannelFrom<SlackChannelState>;
    readonly api: SlackTransportOptions | undefined;
    /** Whether `slackChannel({ codeChannels: true })` enabled code channels. */
    readonly codeChannels: boolean;
    readonly credentials: SlackChannelCredentials | undefined;
    /** Installation workspace inherited from an inbound trigger. */
    readonly installationTeamId?: string;
    /** Slack team id seeded into session state, when the trigger carried one. */
    readonly teamId?: string;
    /** Slack user id seeded into session state, when the trigger carried one. */
    readonly triggeringUserId?: string;
  },
): Promise<Delivery> {
  const { message, target, ...send } = input;
  const receiveTarget = target as Partial<SlackReceiveTarget>;
  const channelId = receiveTarget.channelId;
  if (!channelId || typeof channelId !== "string") {
    throw new Error("slackChannel().receive requires target.channelId.");
  }
  const requestedThreadTs =
    typeof receiveTarget.threadTs === "string" ? receiveTarget.threadTs : "";
  const installationTeamId =
    typeof receiveTarget.installationTeamId === "string"
      ? receiveTarget.installationTeamId
      : deps.installationTeamId;
  const initialMessage = receiveTarget.initialMessage;
  if (initialMessage && requestedThreadTs.length > 0) {
    throw new Error(
      "slackChannel().receive: `threadTs` and `initialMessage` are mutually exclusive.",
    );
  }
  if (receiveTarget.codeChannel !== undefined) {
    if (!deps.codeChannels) {
      throw new Error(
        "slackChannel().receive: set `codeChannels: true` on slackChannel() to open code channels.",
      );
    }
    if (initialMessage || requestedThreadTs.length > 0) {
      throw new Error(
        "slackChannel().receive: `codeChannel` can't be combined with `threadTs` or `initialMessage`.",
      );
    }
    return await receiveInNewCodeChannel(input, deps, {
      codeChannel: receiveTarget.codeChannel,
      installationTeamId,
      originChannelId: channelId,
    });
  }

  let threadTs = requestedThreadTs;
  if (initialMessage) {
    const { thread, slack } = buildSlackBinding({
      api: deps.api,
      botToken: deps.credentials?.botToken,
      channelId,
      threadTs: "",
      installationTeamId,
      teamId: deps.teamId,
    });
    // Upload-only posts return a file ID, not a message ts; always anchor the root first.
    const { files, ...rootMessage } = initialMessage;
    const posted = await thread.post(rootMessage);
    threadTs = posted.id;
    if (files?.length) {
      try {
        await slack.uploadFiles(files);
      } catch (error) {
        log.warn("file upload after initial message post failed", { error });
      }
    }
  }

  // Threadless proactive runs need distinct identities until their first
  // Slack post supplies the real thread timestamp and aliases the session.
  // A keyed send derives its identity from the key, so a retry finds its session.
  const continuationThreadTs =
    threadTs ||
    (send.idempotencyKey === undefined
      ? crypto.randomUUID()
      : threadlessIdentityFromKey(send.idempotencyKey));
  const audience =
    receiveTarget.audience === undefined
      ? undefined
      : normalizeChannelAudience(receiveTarget.audience);
  const state: {
    channelId: string;
    installationTeamId: string | null;
    threadTs: string | null;
    teamId: string | null;
    triggeringUserId: string | null;
    audience?: ChannelAudience;
  } = {
    channelId,
    installationTeamId: installationTeamId ?? null,
    threadTs: threadTs || null,
    teamId: deps.teamId ?? null,
    triggeringUserId: deps.triggeringUserId ?? null,
  };
  if (audience !== undefined) {
    state.audience = audience;
  }

  return deps
    .from(slackContinuationToken({ channelId: channelId, threadTs: continuationThreadTs }))
    .send(message, { ...send, state });
}

function threadlessIdentityFromKey(idempotencyKey: string): string {
  return `key-${createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32)}`;
}

/** Opens a code channel from the origin message and starts its one session. */
async function receiveInNewCodeChannel(
  input: Parameters<typeof receiveOnSlack>[0],
  deps: Parameters<typeof receiveOnSlack>[1],
  target: {
    readonly codeChannel: SlackCodeChannelTarget;
    readonly installationTeamId: string | undefined;
    readonly originChannelId: string;
  },
): Promise<Delivery> {
  const { codeChannel, installationTeamId, originChannelId } = target;
  const { request } = buildSlackWorkspaceHandle({
    api: deps.api,
    botToken: deps.credentials?.botToken,
    installationTeamId,
    teamId: deps.teamId,
  });
  const opened = await openSlackCodeChannel({
    auth: input.auth,
    installationTeamId,
    name: codeChannel.name,
    originChannelId,
    originTs: codeChannel.originTs,
    request,
    teamId: deps.teamId,
    triggeringUserId: deps.triggeringUserId ?? slackUserIdFromAuthContext(input.auth),
  });
  // A session someone already started in the channel gets the history too, so
  // a repeated call delivers it twice rather than an early message losing it.
  const { message, target: _target, ...send } = input;
  return await deps
    .from(opened.address)
    .send(message, { ...send, auth: opened.auth, state: opened.state });
}

/**
 * Opens a Slack code channel from a message and returns what its one session
 * needs: the address, the state, and the auth moved into the channel. Both
 * `target.codeChannel` and `ctx.openCodeChannel()` open through it.
 */
async function openSlackCodeChannel(input: {
  readonly auth: SessionAuthContext | null;
  readonly installationTeamId: string | undefined;
  readonly name: string | undefined;
  readonly originChannelId: string;
  readonly originTs: string;
  readonly request: SlackRequest;
  readonly teamId: string | undefined;
  readonly triggeringUserId: string | undefined;
}): Promise<{
  readonly address: string;
  readonly auth: SessionAuthContext | null;
  readonly channelId: string;
  readonly state: SlackChannelState;
}> {
  const { channelId, isPrivate } = await createSlackCodeChannel({
    name: input.name ?? "",
    originChannelId: input.originChannelId,
    originTs: input.originTs,
    requester: input.auth?.principalId ?? "anonymous",
    request: input.request,
  });
  return {
    address: slackCodeChannelContinuationToken(channelId),
    auth: codeChannelAuth(input.auth, channelId),
    channelId,
    state: {
      // The channel has the origin's privacy, which eve checked before copying anything.
      audience: isPrivate ? "private" : "public",
      channelId,
      codeChannel: true,
      installationTeamId: input.installationTeamId ?? null,
      replyThreadTs: null,
      teamId: input.teamId ?? null,
      threadTs: null,
      triggeringUserId: input.triggeringUserId ?? null,
    },
  };
}

/** The origin's Slack auth, moved to the code channel, so the session knows where it runs. */
function codeChannelAuth(
  auth: SessionAuthContext | null,
  codeChannelId: string,
): SessionAuthContext | null {
  if (auth?.authenticator !== "slack-webhook") return auth;
  // A code channel session has no thread of its own.
  const { thread_ts: _threadTs, ...attributes } = auth.attributes;
  return {
    ...auth,
    attributes: { ...attributes, channel_id: codeChannelId },
  };
}

function shouldDropSlackHttpTimeoutRetry(headers: Headers): boolean {
  const retryNum = Number(headers.get("x-slack-retry-num") ?? "0");
  return retryNum >= 1 && headers.get("x-slack-retry-reason") === "http_timeout";
}

/**
 * Handles an inbound non-interactivity Slack POST: parses the JSON envelope,
 * answers URL verification, selects one authored specific handler, generic
 * fallback, or built-in message default, and schedules it under `waitUntil`.
 * Returns `200 OK` in every case because Slack only requires an immediate ACK.
 */
async function handleEventPost(input: {
  readonly api: SlackTransportOptions | undefined;
  readonly body: string;
  readonly from: ChannelFrom<SlackChannelState>;
  readonly resolveSession: ChannelResolveSession;
  readonly headers: Headers;
  readonly waitUntil: (task: Promise<unknown>) => void;
  readonly config: SlackChannelConfig;
  readonly received: SlackRenderChain["received"];
  readonly userResolver: SlackUserResolver | undefined;
  readonly uploadPolicy: UploadPolicy;
  readonly handledEvents: Set<string>;
}): Promise<Response> {
  const { config } = input;
  let payload;
  let envelope: SlackEventEnvelope | null;
  try {
    payload = parseSlackWebhookBody(input.body, { headers: input.headers });
    envelope = parseSlackEventEnvelope(input.body);
  } catch (error) {
    log.warn("inbound webhook body is not valid JSON", { error });
    return new Response("ok");
  }

  if (payload.kind === "url_verification") {
    return new Response(payload.challenge, {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }

  if (envelope === null) return new Response("ok");
  const appId = typeof envelope.api_app_id === "string" ? envelope.api_app_id : undefined;
  const botUserId = slackEventBotUserId(envelope);
  const receivingBotUserId = slackEventReceivingBotUserId(envelope);
  const installationTeamId = slackEventInstallationTeamId(envelope);

  // Slack requires an agent to stop when a person stops a code channel session.
  // The stop names the channel, or a thread in it; both are the channel's one session.
  const stopped = envelope.event;
  const stoppedChannelId = stopped.channel;
  if (
    config.codeChannels === true &&
    stopped.type === "agent_session_stopped" &&
    typeof stoppedChannelId === "string"
  ) {
    // A redelivered stop must not cancel a turn that started after the first one.
    if (isDuplicateEvent(envelope, payload.retry, input.handledEvents)) {
      return new Response("ok");
    }
    const workspaceRequest = buildSlackWorkspaceHandle({
      api: input.api,
      botToken: config.credentials?.botToken,
      installationTeamId,
      teamId: typeof envelope.team_id === "string" ? envelope.team_id : undefined,
    }).request;
    const onEvent = config.onEvent;
    input.waitUntil(
      (async () => {
        // A threaded stop needs the code channel lookup, which must not hold Slack's ack.
        if (
          stopped.thread_ts !== undefined &&
          !(await isSlackCodeChannel(stoppedChannelId, workspaceRequest))
        ) {
          if (onEvent === undefined) return;
          await dispatchSlackEvent({
            api: input.api,
            from: input.from,
            resolveSession: input.resolveSession,
            codeChannels: true,
            credentials: config.credentials,
            envelope,
            handler: onEvent,
            installationTeamId,
          });
          return;
        }
        // A turn that died without ending leaves the status at `processing`, which
        // never times out, so stop must still reset it.
        if (!(await cancelledARunningTurn(input.from, stoppedChannelId))) {
          await setSlackCodeChannelStatus(workspaceRequest, stoppedChannelId, "active");
        }
      })().catch((error: unknown) => {
        logError(log, "agent_session_stopped handling failed", error, {
          channelId: stoppedChannelId,
        });
      }),
    );
    return new Response("ok");
  }

  // Handler precedence, in fall-through order:
  // 1) an authored mention/DM handler for its own event kind,
  // 2) an authored generic `onEvent` fallback,
  // 3) the built-in mention/DM defaults.
  let dispatch: (() => Promise<void>) | null = null;
  let builtinDefault: (() => Promise<void>) | null = null;

  const dispatchMessage =
    (
      kind: "app_mention" | "channel_message" | "direct_message",
      message: SlackMessage,
      handler: NonNullable<SlackChannelConfig["onMessage"]>,
      codeChannelOnly?: SlackCodeChannelOnly,
    ) =>
    () =>
      dispatchSlackMessage({
        api: input.api,
        appId,
        botUserId,
        codeChannelOnly,
        detectCodeChannels: config.codeChannels === true,
        receivingBotUserId,
        from: input.from,
        resolveSession: input.resolveSession,
        credentials: config.credentials,
        handler,
        installationTeamId,
        kind,
        message,
        received: input.received,
        // A typed reply would bypass a custom `onAnswers` and could answer
        // a request `approvalChannel` sent privately, so either one disables it.
        resolvesTypedInput: config.onAnswers === undefined && config.approvalChannel === undefined,
        threadContext: config.threadContext,
        uploadPolicy: input.uploadPolicy,
        userResolver: input.userResolver,
      });

  if (payload.kind === "app_mention" || payload.kind === "direct_message") {
    const kind = payload.kind;
    const message = slackMessageFromWebhookPayload(payload, installationTeamId);
    if (message !== null && !isSelfAuthoredSlackMessage({ appId, botUserId }, message)) {
      const specialized = kind === "app_mention" ? config.onAppMention : config.onDirectMessage;
      const handler = specialized ?? config.onMessage;
      if (handler !== undefined) dispatch = dispatchMessage(kind, message, handler);
      else builtinDefault = dispatchMessage(kind, message, defaultOnMessage);
    }
  }

  const onMessage = config.onMessage;
  if (dispatch === null && onMessage !== undefined) {
    const message = parseMessageEvent(envelope);
    if (message !== null && !isSelfAuthoredSlackMessage({ appId, botUserId }, message)) {
      // Slack also emits message.channels for an app mention. The app_mention
      // callback owns that user action so the generic message is not duplicated.
      if (botUserId === undefined || !message.text.includes(`<@${botUserId}`)) {
        dispatch = dispatchMessage("channel_message", message, onMessage);
      }
    }
  }

  const onEvent = config.onEvent;
  const dispatchOnEvent =
    onEvent === undefined
      ? undefined
      : () =>
          dispatchSlackEvent({
            api: input.api,
            from: input.from,
            resolveSession: input.resolveSession,
            credentials: config.credentials,
            codeChannels: config.codeChannels === true,
            envelope,
            handler: onEvent,
            installationTeamId,
          });

  // Slack asks agents to answer in a code channel without a mention. Every message
  // there is addressed to the agent, so an authored mention handler gates it. Only the
  // lookup tells a code channel apart, so a message elsewhere falls back to `onEvent`.
  if (dispatch === null && builtinDefault === null && config.codeChannels === true) {
    const message = parseMessageEvent(envelope);
    if (
      message !== null &&
      message.author?.isBot === false &&
      !isSelfAuthoredSlackMessage({ appId, botUserId }, message) &&
      !isSlackCodeChannelOriginContext(message.raw) &&
      (botUserId === undefined || !message.text.includes(`<@${botUserId}`))
    ) {
      const onAppMention = config.onAppMention;
      if (onAppMention !== undefined) {
        dispatch = dispatchMessage("channel_message", message, onAppMention, {
          otherwise: dispatchOnEvent,
        });
      } else {
        builtinDefault = dispatchMessage("channel_message", message, defaultOnMessage, {});
      }
    }
  }

  // Specialized handlers retain their bot/subtype filters. onMessage receives
  // newly posted messages except this app's own; onEvent is the raw fallback.
  dispatch ??= dispatchOnEvent ?? builtinDefault;
  if (dispatch === null) return new Response("ok");

  if (isDuplicateEvent(envelope, payload.retry, input.handledEvents)) return new Response("ok");

  input.waitUntil(dispatch());
  return new Response("ok");
}

/** Whether this process already handled the event; marks it handled otherwise. */
function isDuplicateEvent(
  envelope: SlackEventEnvelope,
  retry: { readonly num?: unknown; readonly reason?: unknown } | undefined,
  handledEvents: Set<string>,
): boolean {
  const eventId = envelope.event_id;
  if (!eventId) return false;
  if (handledEvents.has(eventId)) {
    log.warn("received a duplicate event", {
      event_id: eventId,
      event_time: envelope.event_time,
      retry_num: retry?.num ?? "(null)",
      retry_reason: retry?.reason ?? "(null)",
    });
    return true;
  }
  markEventHandled(eventId, handledEvents);
  return false;
}

function isSelfAuthoredSlackMessage(
  identity: { readonly appId: string | undefined; readonly botUserId: string | undefined },
  message: SlackMessage,
): boolean {
  if (identity.botUserId !== undefined && message.author?.userId === identity.botUserId) {
    return true;
  }

  // App-authored message events can omit `user`, so match Slack's app identity
  // as a fallback. Other bots keep flowing to authored onMessage handlers.
  return identity.appId !== undefined && message.raw.app_id === identity.appId;
}

/** Limits a message hook to code channels; `otherwise` serves a message posted elsewhere. */
interface SlackCodeChannelOnly {
  readonly otherwise?: () => Promise<void>;
}

async function dispatchSlackMessage(input: {
  readonly api: SlackTransportOptions | undefined;
  readonly appId: string | undefined;
  readonly botUserId: string | undefined;
  /** Serves the message only when it was posted in a code channel. */
  readonly codeChannelOnly: SlackCodeChannelOnly | undefined;
  readonly detectCodeChannels: boolean;
  readonly receivingBotUserId: string | undefined;
  readonly from: ChannelFrom<SlackChannelState>;
  readonly resolveSession: ChannelResolveSession;
  readonly credentials: SlackChannelCredentials | undefined;
  readonly handler: NonNullable<SlackChannelConfig["onMessage"]>;
  readonly installationTeamId: string | undefined;
  readonly kind: "app_mention" | "channel_message" | "direct_message";
  readonly message: SlackMessage;
  readonly received: SlackRenderChain["received"];
  readonly resolvesTypedInput: boolean;
  readonly threadContext: LoadThreadContextMessagesOptions | undefined;
  readonly uploadPolicy: UploadPolicy;
  readonly userResolver: SlackUserResolver | undefined;
}): Promise<void> {
  const request = buildSlackWorkspaceHandle({
    api: input.api,
    botToken: input.credentials?.botToken,
    installationTeamId: input.installationTeamId,
    teamId: input.message.teamId,
  }).request;
  const userLookup = {
    request,
    teamId: input.installationTeamId ?? input.message.teamId,
  };
  let resolvedMessage: Promise<SlackMessage> | undefined;
  const resolveMessage = () =>
    (resolvedMessage ??=
      input.userResolver === undefined
        ? Promise.resolve(input.message)
        : withSlackUserInfo(input.message, input.userResolver, userLookup));
  // Mentions and DMs are addressed to the agent, so their hooks see the looked-up author.
  // Other channel messages are mostly dropped, so they are looked up only at delivery.
  const message = input.kind === "channel_message" ? input.message : await resolveMessage();
  const author = message.author;
  // Code channel detection and the privacy check read the same conversation.
  let conversationInfo: ReturnType<typeof request> | undefined;
  const conversationRequest: typeof request = (operation, body) =>
    operation === "conversations.info"
      ? (conversationInfo ??= request(operation, body))
      : request(operation, body);
  const codeChannel =
    input.detectCodeChannels &&
    input.kind !== "direct_message" &&
    (await isSlackCodeChannel(input.message.channelId, conversationRequest));
  if (!codeChannel && input.codeChannelOnly !== undefined) {
    await input.codeChannelOnly.otherwise?.();
    return;
  }
  // A code channel is one session: every message in it, threaded or not, shares its address.
  const threadTs = codeChannel ? "" : input.message.threadTs;
  const isThreadReply = input.message.threadTs !== input.message.ts;
  const replyThreadTs = codeChannel && isThreadReply ? input.message.threadTs : null;
  const continuationToken = codeChannel
    ? slackCodeChannelContinuationToken(input.message.channelId)
    : slackContinuationToken({ channelId: input.message.channelId, threadTs });
  const { thread, slack } = buildSlackBinding({
    api: input.api,
    appId: input.appId,
    botToken: input.credentials?.botToken,
    botUserId: input.botUserId,
    channelId: input.message.channelId,
    threadTs,
    codeChannel,
    replyThreadTs: () => replyThreadTs ?? undefined,
    threadHasReplies: isThreadReply,
    installationTeamId: input.installationTeamId,
    teamId: input.message.teamId,
  });
  const channelState: SlackChannelState = {
    channelId: input.message.channelId,
    installationTeamId: input.installationTeamId ?? null,
    teamId: input.message.teamId ?? null,
    threadTs: threadTs || null,
    triggeringMessageTs: input.message.ts,
    triggeringUserId: author?.userId ?? null,
    ...(codeChannel && { codeChannel: true, replyThreadTs }),
  };
  const sessionDefaultAuth =
    author === undefined
      ? null
      : buildSlackAuthContext({
          channelId: input.message.channelId,
          email: author.email,
          fullName: author.fullName,
          installationTeamId: input.installationTeamId,
          isBot: author.isBot,
          teamId: input.message.teamId,
          threadTs,
          userId: author.userId,
          userName: author.userName,
        });
  const sessionOperations = bindSlackSessionOperations({
    address: continuationToken,
    defaultAuth: sessionDefaultAuth,
    from: input.from,
    resolveSession: input.resolveSession,
    state: channelState,
  });
  let privateConversation: Promise<boolean> | undefined;
  const isDMOrPrivateChannel = () =>
    (privateConversation ??= isPrivateSlackConversation({
      channelId: input.message.channelId,
      raw: input.message.raw,
      request: conversationRequest,
    }));
  const openCodeChannel = async (options: SlackOpenCodeChannelOptions = {}) => {
    if (!input.detectCodeChannels) {
      throw new Error(
        "ctx.openCodeChannel(): set `codeChannels: true` on slackChannel() to open code channels.",
      );
    }
    if (codeChannel) {
      throw new Error("ctx.openCodeChannel(): this message is already in a code channel.");
    }
    return await openCodeChannelFromMessage({
      defaultAuth: sessionDefaultAuth,
      from: input.from,
      installationTeamId: input.installationTeamId,
      message: input.message,
      name: options.name,
      // Not `conversationRequest`: its cached origin lookup would answer the
      // privacy check on the new channel.
      request,
      resolveSession: input.resolveSession,
    });
  };
  const isBotMentioned =
    input.kind === "app_mention" ||
    (input.botUserId !== undefined && input.message.text.includes(`<@${input.botUserId}`));
  const ctx: SlackInboundMessageContext = {
    ...sessionOperations,
    isBotMentioned: () => isBotMentioned,
    isDMOrPrivateChannel,
    isSubscribed: async () => (await sessionOperations.resolveSession()) !== undefined,
    openCodeChannel,
    slack,
    thread,
  };

  // A mention or DM is addressed to the agent, so it is acknowledged while the
  // hook decides. Other channel messages are mostly dropped, so they are
  // acknowledged only once the hook dispatches. A code channel's status belongs
  // to its one session, so a dropped message must not clear it mid-turn.
  const acknowledgeFirst = input.kind !== "channel_message" && !codeChannel;
  const acknowledged = acknowledgeFirst
    ? acknowledgeMessage(input.received, input.message, { slack, thread })
    : undefined;
  let result;
  try {
    result = await input.handler(ctx, message);
  } catch (error) {
    logError(log, `${input.kind} handler failed`, error, {
      channelId: input.message.channelId,
    });
  }
  if (result === null || result === undefined) {
    if (acknowledged !== undefined) {
      await acknowledged;
      await thread.startTyping();
    }
    return;
  }
  await (acknowledged ?? acknowledgeMessage(input.received, input.message, { slack, thread }));

  const isPrivateConversation = await isDMOrPrivateChannel();
  channelState.audience =
    input.kind === "direct_message" || isPrivateConversation ? "private" : "public";
  await deliverSlackMessage({
    botUserId: input.receivingBotUserId,
    credentials: input.credentials,
    kind: input.kind,
    isPrivateConversation,
    isMentioned: isBotMentioned,
    message: await resolveMessage(),
    resolvesTypedInput: input.resolvesTypedInput,
    result,
    sessionOperations,
    thread,
    threadContext: input.threadContext,
    uploadPolicy: input.uploadPolicy,
    users: input.userResolver && { resolver: input.userResolver, ...userLookup },
  });
}

/** Opens a code channel from an inbound message and binds operations to its one session. */
async function openCodeChannelFromMessage(input: {
  readonly defaultAuth: SessionAuthContext | null;
  readonly from: ChannelFrom<SlackChannelState>;
  readonly installationTeamId: string | undefined;
  readonly message: SlackMessage;
  readonly name: string | undefined;
  readonly request: SlackRequest;
  readonly resolveSession: ChannelResolveSession;
}): Promise<SlackOpenedCodeChannel> {
  const opened = await openSlackCodeChannel({
    auth: input.defaultAuth,
    installationTeamId: input.installationTeamId,
    name: input.name,
    originChannelId: input.message.channelId,
    originTs: input.message.ts,
    request: input.request,
    teamId: input.message.teamId,
    triggeringUserId: input.message.author?.userId,
  });
  const operations = bindSlackSessionOperations({
    address: opened.address,
    defaultAuth: opened.auth,
    from: input.from,
    resolveSession: input.resolveSession,
    state: opened.state,
  });
  // Slack auth a hook passes names the origin thread; the session runs in the channel.
  const moved = <T extends { readonly auth?: SessionAuthContext | null }>(
    options: T | undefined,
  ) =>
    options?.auth ? { ...options, auth: codeChannelAuth(options.auth, opened.channelId) } : options;
  return {
    ...operations,
    channelId: opened.channelId,
    send: (message, options) => operations.send(message, moved(options)),
    respond: (inputResponses, options) => operations.respond(inputResponses, moved(options)),
  };
}

/** Runs the renderer chain's `received`; an acknowledgement that fails never fails dispatch. */
async function acknowledgeMessage(
  received: SlackRenderChain["received"],
  message: SlackMessage,
  channel: SlackContext,
): Promise<void> {
  try {
    await received(message, channel);
  } catch (error) {
    logError(log, "received renderer failed", error, { channelId: message.channelId });
  }
}

/** Runs a generic Events API handler with an imperative Slack operation surface. */
async function dispatchSlackEvent(input: {
  readonly api: SlackTransportOptions | undefined;
  readonly from: ChannelFrom<SlackChannelState>;
  readonly resolveSession: ChannelResolveSession;
  readonly credentials: SlackChannelCredentials | undefined;
  readonly envelope: SlackEventEnvelope;
  readonly codeChannels: boolean;
  readonly handler: NonNullable<SlackChannelConfig["onEvent"]>;
  readonly installationTeamId: string | undefined;
}): Promise<void> {
  const eventTeamId = input.envelope.event.team_id;
  const teamId =
    typeof eventTeamId === "string"
      ? eventTeamId
      : typeof input.envelope.team_id === "string"
        ? input.envelope.team_id
        : undefined;
  const waitUntilTasks: Promise<unknown>[] = [];
  const sourceFor = (target: SlackSessionTarget) => input.from(slackSessionToken(target));
  const ctx: SlackInboundEventContext = {
    cancel: ({ target, turnId }) => sourceFor(target).cancel({ turnId }),
    clear: ({ target }) => sourceFor(target).clear(),
    compact: ({ target }) => sourceFor(target).compact(),
    envelope: input.envelope,
    end: ({ reason, target }) => sourceFor(target).end({ reason }),
    resolveSession: ({ target }) => input.resolveSession(slackSessionToken(target)),
    respond: (answers, { auth, target }) =>
      sourceFor(target).respond(answers, {
        auth,
        state: withSlackResponder(
          undefined,
          typeof input.envelope.event.user === "string" ? input.envelope.event.user : undefined,
        ),
      }),
    send: async (message, options) =>
      await receiveOnSlack(
        { ...toSessionSendOptions(options), target: options.target, message },
        {
          from: input.from,
          api: input.api,
          codeChannels: input.codeChannels,
          credentials: input.credentials,
          installationTeamId: input.installationTeamId,
          teamId,
          ...(typeof input.envelope.event.user === "string"
            ? { triggeringUserId: input.envelope.event.user }
            : {}),
        },
      ),
    slack: buildSlackWorkspaceHandle({
      api: input.api,
      botToken: input.credentials?.botToken,
      installationTeamId: input.installationTeamId,
      teamId,
    }),
    waitUntil(task) {
      waitUntilTasks.push(task);
    },
  };

  try {
    await input.handler(ctx, input.envelope.event);
  } catch (error) {
    logError(log, "event handler failed", error, {
      eventId: input.envelope.event_id,
      eventType: input.envelope.event.type,
    });
  }

  await Promise.allSettled(waitUntilTasks);
}

/**
 * Verifies the inbound Slack request and returns its raw body, or
 * `null` when verification fails. Failures are logged so misconfigured
 * deployments are visible — the route returns 401 to Slack.
 */
async function verifyInbound(
  req: Request,
  credentials: SlackChannelCredentials | undefined,
): Promise<string | null> {
  try {
    return await verifySlackRequest(req, {
      signingSecret:
        credentials?.signingSecret ??
        (credentials?.webhookVerifier ? undefined : process.env.SLACK_SIGNING_SECRET),
      webhookVerifier: credentials?.webhookVerifier,
    });
  } catch (error) {
    log.warn("slack inbound verification failed", { error });
    return null;
  }
}

async function deliverSlackMessage(input: {
  readonly botUserId: string | undefined;
  readonly sessionOperations: SlackSessionOperations;
  readonly credentials: SlackChannelCredentials | undefined;
  readonly isPrivateConversation: boolean;
  readonly isMentioned: boolean;
  readonly kind: string;
  readonly message: SlackMessage;
  readonly resolvesTypedInput: boolean;
  readonly result: Exclude<SlackInboundResult, null>;
  readonly thread: SlackThread;
  readonly threadContext: LoadThreadContextMessagesOptions | undefined;
  readonly uploadPolicy: UploadPolicy;
  /** Looks up thread-reply senders; `undefined` when `messageContext.users` is off. */
  readonly users:
    | {
        readonly resolver: SlackUserResolver;
        readonly request: SlackRequest;
        readonly teamId: string | undefined;
      }
    | undefined;
}): Promise<void> {
  const { message, thread } = input;
  // This runs in the webhook's `waitUntil` task; an unguarded throw would
  // reject silently into the dispatch `allSettled` ("no response, no logs").
  try {
    const priorMessages =
      input.threadContext === undefined
        ? []
        : await loadThreadContextMessages(thread, message, input.threadContext);
    // A message that starts the thread's session carries the replies as history; a started
    // session gets them as a transcript, as before. Authored history keeps the transcript.
    const seedsHistory =
      priorMessages.length > 0 &&
      input.result.history === undefined &&
      (await input.sessionOperations.resolveSession()) === undefined;
    // Thread replies are only model-visible, so their senders are looked up here.
    const users =
      input.users === undefined
        ? undefined
        : await resolveSlackUsers(input.users.resolver, {
            request: input.users.request,
            teamId: input.users.teamId,
            userIds: priorMessages.flatMap((prior) => (prior.user ? [prior.user] : [])),
          });
    const threadContext = seedsHistory ? undefined : formatSlackThreadContext(priorMessages, users);
    const history =
      input.result.history ??
      (seedsHistory ? slackThreadSessionHistory(priorMessages, users) : undefined);
    const fileParts = await collectInboundFileParts({
      botUserId: input.botUserId,
      fetchThreadWindow: (latest, size) => fetchSlackThreadWindow(thread, latest, size),
      // A DM can mention the app too, but every DM message brings its own files.
      isMentioned: input.kind === "app_mention",
      mention: message,
      thread,
      policy: input.uploadPolicy,
    });
    const inboundContext: SlackInboundContext = {
      botUserId: input.botUserId,
      channelId: message.channelId,
      displayName: message.author?.displayName,
      email: message.author?.email,
      fullName: message.author?.fullName,
      isMentioned: input.isMentioned,
      teamId: message.teamId,
      threadTs: message.threadTs,
      userId: message.author?.userId ?? "",
      userName: message.author?.userName,
    };
    const attributedMessage = formatSlackInboundMessage(inboundContext, message);
    const turnMessage = buildSlackTurnMessage(
      threadContext === undefined ? attributedMessage : `${threadContext}\n\n${attributedMessage}`,
      fileParts,
    );

    const channelContext = input.result.context ?? [];
    const title = input.isPrivateConversation
      ? PRIVATE_SLACK_RUN_TITLE
      : (input.result.title ?? message.markdown);
    // The envelope stays model-visible; pending input matches what the person typed.
    // With typed answers off, empty text keeps the envelope itself from answering.
    const typedText = input.resolvesTypedInput ? slackTypedText(message.text, input.botUserId) : "";
    const sendOptions: SlackSendOptions = attachInputText(
      {
        auth: input.result.auth,
        title,
        ...(channelContext.length > 0 && { context: channelContext }),
        ...(history !== undefined && { history }),
      },
      fileParts.length === 0 ? typedText : undefined,
    );

    await input.sessionOperations.send(turnMessage, sendOptions);
  } catch (error) {
    logError(log, `${input.kind} delivery failed`, error, { channelId: message.channelId });
  }
}

function slackTypedText(text: string, botUserId: string | undefined): string {
  if (botUserId === undefined) return text;
  return text.replace(new RegExp(`<@${botUserId}(?:\\|[^>]*)?>`, "gu"), "").trim();
}

/** Whether a stop for a code channel cancelled a turn; an idle session settles the cancel `ignored`. */
async function cancelledARunningTurn(
  from: ChannelFrom<SlackChannelState>,
  channelId: string,
): Promise<boolean> {
  try {
    const delivery = await from(slackCodeChannelContinuationToken(channelId)).cancel();
    const { outcome } = await delivery.result({ signal: AbortSignal.timeout(10_000) });
    return outcome !== "ignored";
  } catch (error) {
    if (error instanceof SessionNotActiveError) return false;
    throw error;
  }
}

/** In a code channel, the next turn replies in the thread of the latest message delivered. */
function followReplyThread(state: SlackChannelState, payload: ChannelDelivery<unknown>): void {
  if (payload.message === undefined || state.codeChannel !== true) return;
  const stamped = payload.state as Partial<SlackChannelState> | undefined;
  state.pendingReplyThreadTs = stamped?.replyThreadTs ?? null;
}

/** The latest message delivered is the one the next turn answers. */
function followTriggeringMessage(
  state: SlackChannelState,
  payload: ChannelDelivery<unknown>,
): void {
  if (payload.message === undefined) return;
  const stamped = (payload.state as Partial<SlackChannelState> | undefined)?.triggeringMessageTs;
  if (typeof stamped === "string") state.triggeringMessageTs = stamped;
}

/**
 * Records the Slack user behind a delivery's principal. Slack-authenticated
 * callers carry their user id; custom auth relies on the message author or
 * clicking user stamped on the payload.
 */
function recordSlackPrincipal(
  state: SlackChannelState,
  caller: SessionAuthContext | null,
  payload: ChannelDelivery<SlackChannelState>,
): void {
  if (caller === null) return;
  const stamped = payload.state?.triggeringUserId;
  const slackUserId =
    slackUserIdFromAuthContext(caller) ?? (typeof stamped === "string" ? stamped : undefined);
  if (slackUserId === undefined) return;
  state.slackUsersByPrincipal = {
    ...state.slackUsersByPrincipal,
    [caller.principalId]: slackUserId,
  };
}
