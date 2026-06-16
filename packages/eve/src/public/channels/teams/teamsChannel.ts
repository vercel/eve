import type { TeamsInstrumentationMetadata } from "#public/channels/teams/index.js";
import type { SessionHandle } from "#channel/session.js";
import type { SessionAuthContext } from "#channel/types.js";
import type { SessionContext } from "#public/definitions/callback-context.js";
import type { ChannelSessionOps } from "#public/definitions/defineChannel.js";

import { createLogger, logError } from "#internal/logging.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import {
  buildTeamsTurnMessage,
  collectTeamsFileParts,
  createTeamsFetchFile,
  normalizeTeamsFilesPolicy,
  type TeamsFilesConfig,
  type TeamsFilesPolicy,
} from "#public/channels/teams/attachments.js";
import {
  callTeamsConnectorApi,
  normalizeTeamsPostInput,
  replyToTeamsActivity,
  sendTeamsActivity,
  teamsContinuationToken,
  triggerTeamsTypingIndicator,
  updateTeamsActivity,
  type TeamsApiOptions,
  type TeamsApiResponse,
  type TeamsChannelAccount,
  type TeamsCredentials,
  type TeamsMention,
  type TeamsMessageBody,
  type TeamsOutboundActivity,
  type TeamsPostedActivity,
} from "#public/channels/teams/api.js";
import {
  defaultEvents,
  defaultOnMessage,
  teamsMentionUser,
} from "#public/channels/teams/defaults.js";
import {
  deriveTeamsInputResponses,
  isTeamsInputResponseActivity,
  teamsInvokeResponse,
} from "#public/channels/teams/hitl.js";
import {
  formatTeamsContextBlock,
  parseTeamsActivity,
  teamsThreadRootActivityId,
  type TeamsActivity,
  type TeamsInboundContext,
  type TeamsInvokeActivity,
  type TeamsMessageActivity,
} from "#public/channels/teams/inbound.js";
import { verifyTeamsRequest, type TeamsWebhookVerifier } from "#public/channels/teams/verify.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";
import {
  defineChannel,
  POST,
  type Channel,
  type SendFn,
} from "#public/definitions/defineChannel.js";

const log = createLogger("teams.channel");

type EventData<T extends HandleMessageStreamEvent["type"]> =
  Extract<HandleMessageStreamEvent, { type: T }> extends { data: infer D } ? D : undefined;

/** Pre-dispatch Teams context passed to inbound message and invoke hooks. */
export interface TeamsContext {
  readonly teams: TeamsHandle;
  readonly thread: TeamsThread;
}

/** Channel-owned Teams context returned by `context()`. */
export interface TeamsChannelContext extends TeamsContext {
  readonly adaptiveCardVersion: string;
  state: TeamsChannelState;
}

/** Event-handler Teams context, including session operations. */
export interface TeamsEventContext extends TeamsChannelContext, ChannelSessionOps {}

/** JSON-serializable Teams channel state. */
export interface TeamsChannelState {
  /** Bot account captured from the inbound activity recipient. */
  bot: TeamsChannelAccount | null;
  channelId: string | null;
  conversationId: string | null;
  /** Teams conversation type (`personal`, `groupChat`, `channel`, or platform value). */
  conversationType: string | null;
  /** Activity id used for thread replies in channel/group contexts. */
  replyToActivityId: string | null;
  serviceUrl: string | null;
  teamId: string | null;
  tenantId: string | null;
  /** User account that triggered the latest turn/session. */
  triggeringUser: TeamsChannelAccount | null;
  /** Activity id for the default connection-auth card, when posted. */
  pendingAuthActivityId?: string | null;
}

/** Teams channel credentials. */
export interface TeamsChannelCredentials extends TeamsCredentials {
  /** Custom inbound webhook verifier. When supplied, replaces Bot Connector JWT validation. */
  readonly webhookVerifier?: TeamsWebhookVerifier;
}

/**
 * Target accepted by `receive(teams, { target })` for proactive sessions.
 * `serviceUrl` and `conversationId` are required. Mutually exclusive:
 * `replyToActivityId` threads onto an existing activity, `initialMessage` posts
 * a new root that anchors non-personal threads.
 */
export interface TeamsReceiveTarget {
  /** Teams team/channel id, for channel conversations. */
  readonly channelId?: string;
  readonly conversationId: string;
  /** Teams conversation type (`personal`, `groupChat`, `channel`, or platform value). */
  readonly conversationType?: string;
  /** Root message posted before the session message. */
  readonly initialMessage?: string | TeamsMessageBody;
  /** Existing activity id to thread replies onto. */
  readonly replyToActivityId?: string;
  readonly serviceUrl: string;
  /** Teams team id, when targeting a team channel. */
  readonly teamId?: string;
  /** Teams tenant id, when known. */
  readonly tenantId?: string;
}

/** Result of an inbound Teams message hook. Return `null` to acknowledge without dispatching. */
export type TeamsInboundResult = {
  readonly auth: SessionAuthContext | null;
  readonly context?: readonly string[];
} | null;

/** Sync or async {@link TeamsInboundResult}. */
export type TeamsInboundResultOrPromise = TeamsInboundResult | Promise<TeamsInboundResult>;

/** Result of a non-HITL Teams invoke hook. A `Response` returns verbatim, a plain object is JSON-encoded as the body, and `null`/`undefined` yields a 200 OK. */
export type TeamsInvokeResult = Record<string, unknown> | Response | null | undefined;

/** Sync or async {@link TeamsInvokeResult}. */
export type TeamsInvokeResultOrPromise = TeamsInvokeResult | Promise<TeamsInvokeResult>;

type TeamsEventHandler<T extends HandleMessageStreamEvent["type"]> = (
  data: EventData<T>,
  channel: TeamsEventContext,
  ctx: SessionContext,
) => void | Promise<void>;

type TeamsSessionFailedHandler = (
  data: EventData<"session.failed">,
  channel: TeamsEventContext,
) => void | Promise<void>;

/** Event handlers supported by `teamsChannel({ events })`. */
export interface TeamsChannelEvents {
  readonly "turn.started"?: TeamsEventHandler<"turn.started">;
  readonly "actions.requested"?: TeamsEventHandler<"actions.requested">;
  readonly "action.result"?: TeamsEventHandler<"action.result">;
  readonly "message.completed"?: TeamsEventHandler<"message.completed">;
  readonly "message.appended"?: TeamsEventHandler<"message.appended">;
  readonly "input.requested"?: TeamsEventHandler<"input.requested">;
  readonly "turn.failed"?: TeamsEventHandler<"turn.failed">;
  readonly "turn.completed"?: TeamsEventHandler<"turn.completed">;
  readonly "session.failed"?: TeamsSessionFailedHandler;
  readonly "session.completed"?: TeamsEventHandler<"session.completed">;
  readonly "session.waiting"?: TeamsEventHandler<"session.waiting">;
  readonly "authorization.required"?: TeamsEventHandler<"authorization.required">;
  readonly "authorization.completed"?: TeamsEventHandler<"authorization.completed">;
}

/** Configuration for {@link teamsChannel}. */
export interface TeamsChannelConfig {
  /** Adaptive Card schema version emitted for HITL input and connection-auth cards. Defaults to `"1.5"`. */
  readonly adaptiveCardVersion?: string;
  /** Shared Connector API options (fetch override, login base URL). Credentials come from {@link credentials}. */
  readonly api?: Omit<TeamsApiOptions, "credentials">;
  /** Bot Connector credentials (app id/password, tenant id, custom token provider, or a webhook verifier). Falls back to `MICROSOFT_APP_*`/`TEAMS_APP_*` env vars when omitted. */
  readonly credentials?: TeamsChannelCredentials;
  /** Overrides merged over the built-in event handlers (typing, replies, HITL cards, auth cards, terminal errors). */
  readonly events?: TeamsChannelEvents;
  /** Inbound attachment handling. File ingestion is off unless `enabled: true`. */
  readonly files?: TeamsFilesConfig;
  /** Override the default webhook route path (`/eve/v1/teams`). */
  readonly route?: string;

  /** Inbound message hook. Defaults to user-scoped auth and mention-gated dispatch outside personal chats. */
  onMessage?(ctx: TeamsContext, message: TeamsMessageActivity): TeamsInboundResultOrPromise;

  /** Handler for non-HITL Teams invoke activities. Return a body, a Response, or `null`/`undefined` for a 200 OK. */
  onInvoke?(ctx: TeamsContext, activity: TeamsInvokeActivity): TeamsInvokeResultOrPromise;
}

/** Low-level Teams handle exposed to hooks and event handlers. */
export interface TeamsHandle {
  readonly channelId: string | undefined;
  readonly conversationId: string;
  readonly conversationType: string | undefined;
  readonly replyToActivityId: string | undefined;
  readonly serviceUrl: string;
  readonly teamId: string | undefined;
  readonly tenantId: string | undefined;

  /** Raw Bot Connector API escape hatch. */
  request(
    path: string,
    body: TeamsOutboundActivity | JsonObject,
    options?: TeamsRequestOptions,
  ): Promise<TeamsApiResponse>;
  /** Sends a Bot Framework activity to the current conversation. */
  sendActivity(
    activity: TeamsMessageBody | TeamsOutboundActivity | string,
  ): Promise<TeamsPostedActivity>;
  /** Sends a Bot Framework reply to the current thread anchor. Throws if no anchor is set (e.g. personal chats); use {@link sendActivity} there. */
  replyToActivity(
    activity: TeamsMessageBody | TeamsOutboundActivity | string,
  ): Promise<TeamsPostedActivity>;
  updateActivity(
    activityId: string,
    activity: TeamsMessageBody | TeamsOutboundActivity | string,
  ): Promise<TeamsPostedActivity>;
  /** Triggers Teams' typing indicator. The thread helper ignores failures. */
  startTyping(): Promise<void>;
}

/** Conversation-scoped Teams operations. */
export interface TeamsThread {
  /** Builds a Teams mention entity and matching text for one user. */
  mentionUser(user: { readonly id: string; readonly name?: string }): TeamsMention;
  post(message: string | TeamsMessageBody): Promise<TeamsPostedActivity>;
  /** Starts Teams' typing indicator. Ignores failures. */
  startTyping(): Promise<void>;
  update(activityId: string, message: string | TeamsMessageBody): Promise<TeamsPostedActivity>;
}

/** Options for {@link TeamsHandle.request}. */
export interface TeamsRequestOptions {
  /** HTTP verb for the raw Connector call. Defaults to `POST`. */
  readonly method?: "DELETE" | "GET" | "POST" | "PUT";
}

/** Concrete return type of {@link teamsChannel}. */
export interface TeamsChannel extends Channel<
  TeamsChannelState,
  TeamsReceiveTarget,
  TeamsInstrumentationMetadata
> {}

/** Teams channel factory for Bot Framework Activities and proactive messages. */
export function teamsChannel(config: TeamsChannelConfig = {}): TeamsChannel {
  const filesPolicy = normalizeTeamsFilesPolicy(config.files);
  const onMessage = config.onMessage ?? defaultOnMessage;
  const mergedEvents: TeamsChannelEvents = { ...defaultEvents, ...config.events };

  return defineChannel<
    TeamsChannelState,
    TeamsChannelContext,
    TeamsReceiveTarget,
    TeamsInstrumentationMetadata
  >({
    kindHint: "teams",
    state: initialTeamsState(),
    fetchFile: createTeamsFetchFile(filesPolicy),
    metadata: (state) => ({
      channelId: state.channelId,
      conversationType: state.conversationType,
      teamId: state.teamId,
    }),

    context(state, session) {
      return rebuildTeamsContext(state, session, config);
    },

    routes: [
      POST<TeamsChannelState>(config.route ?? "/eve/v1/teams", async (req, { send, waitUntil }) => {
        const body = await verifyInbound(req, config.credentials);
        if (body === null) return new Response("unauthorized", { status: 401 });

        let raw: JsonObject;
        try {
          raw = parseJsonObject(JSON.parse(body) as unknown);
        } catch (error) {
          log.warn("inbound Teams body is not valid JSON", { error });
          return teamsOk();
        }

        const activity = parseTeamsActivity(raw);
        if (activity === null) return teamsOk();

        if (activity.type === "message") {
          waitUntil(
            dispatchMessage({
              activity,
              config,
              filesPolicy,
              onMessage,
              send,
            }),
          );
          return teamsOk();
        }

        if (activity.type === "invoke") {
          return handleInvoke({
            activity,
            config,
            send,
            waitUntil,
          });
        }

        return teamsOk();
      }),
    ],

    async receive(input, { send }) {
      const receiveTarget = input.target as Partial<TeamsReceiveTarget>;
      const serviceUrl = readString(receiveTarget.serviceUrl);
      const conversationId = readString(receiveTarget.conversationId);
      if (!serviceUrl || !conversationId) {
        throw new Error(
          "teamsChannel().receive requires target.serviceUrl and target.conversationId.",
        );
      }

      const conversationType = readString(receiveTarget.conversationType) ?? null;
      let replyToActivityId = readString(receiveTarget.replyToActivityId) ?? null;
      const initialMessage = receiveTarget.initialMessage;
      if (initialMessage !== undefined && replyToActivityId !== null) {
        throw new Error(
          "teamsChannel().receive: `replyToActivityId` and `initialMessage` are mutually exclusive.",
        );
      }

      const state: TeamsChannelState = {
        ...initialTeamsState(),
        channelId: readString(receiveTarget.channelId) ?? null,
        conversationId,
        conversationType,
        replyToActivityId,
        serviceUrl,
        teamId: readString(receiveTarget.teamId) ?? null,
        tenantId: readString(receiveTarget.tenantId) ?? null,
      };

      if (initialMessage !== undefined) {
        const ctx = buildTeamsBinding({ config, state });
        const posted = await ctx.thread.post(initialMessage);
        if (conversationType !== "personal" && posted.id) {
          replyToActivityId = posted.id;
          state.replyToActivityId = posted.id;
        }
      }

      return send(input.message, {
        auth: input.auth,
        continuationToken: teamsContinuationToken({
          conversationId,
          replyToActivityId,
          tenantId: state.tenantId,
        }),
        state,
      });
    },

    events: mergedEvents,
  });
}

function rebuildTeamsContext(
  state: TeamsChannelState,
  session: SessionHandle,
  config: TeamsChannelConfig,
): TeamsChannelContext {
  const binding = buildTeamsBinding({ config, session, state });
  return {
    ...binding,
    adaptiveCardVersion: config.adaptiveCardVersion ?? "1.5",
    state,
  };
}

function buildTeamsBinding(input: {
  readonly config: TeamsChannelConfig;
  readonly session?: SessionHandle;
  readonly state: TeamsChannelState;
}): TeamsContext {
  const teams = buildTeamsHandle(input);
  return {
    teams,
    thread: {
      mentionUser: teamsMentionUser,
      post(message) {
        return teams.sendActivity(message);
      },
      async startTyping() {
        try {
          await teams.startTyping();
        } catch (error) {
          logError(log, "Teams typing indicator failed — swallowed", error);
        }
      },
      update(activityId, message) {
        return teams.updateActivity(activityId, message);
      },
    },
  };
}

function buildTeamsHandle(input: {
  readonly config: TeamsChannelConfig;
  readonly session?: SessionHandle;
  readonly state: TeamsChannelState;
}): TeamsHandle {
  const state = input.state;
  const api = input.config.api;
  const credentials = input.config.credentials;

  function requireAddress(): { readonly conversationId: string; readonly serviceUrl: string } {
    const conversationId = state.conversationId ?? "";
    const serviceUrl = state.serviceUrl ?? "";
    if (!conversationId || !serviceUrl) {
      throw new Error("teamsChannel: missing serviceUrl or conversationId for outbound message.");
    }
    return { conversationId, serviceUrl };
  }

  function anchor(posted: TeamsPostedActivity): void {
    if (!posted.id || state.replyToActivityId || state.conversationType === "personal") return;
    state.replyToActivityId = posted.id;
    const conversationId = state.conversationId;
    if (conversationId) {
      input.session?.setContinuationToken(
        teamsContinuationToken({
          conversationId,
          replyToActivityId: posted.id,
          tenantId: state.tenantId,
        }),
      );
    }
  }

  async function send(activity: TeamsMessageBody | TeamsOutboundActivity | string) {
    const address = requireAddress();
    const body = buildOutboundActivity(state, activity);
    const posted =
      state.replyToActivityId !== null
        ? await replyToTeamsActivity({
            ...api,
            body,
            credentials,
            activityId: state.replyToActivityId,
            conversationId: address.conversationId,
            serviceUrl: address.serviceUrl,
          })
        : await sendTeamsActivity({
            ...api,
            body,
            credentials,
            conversationId: address.conversationId,
            serviceUrl: address.serviceUrl,
          });
    anchor(posted);
    return posted;
  }

  return {
    channelId: state.channelId ?? undefined,
    conversationId: state.conversationId ?? "",
    conversationType: state.conversationType ?? undefined,
    replyToActivityId: state.replyToActivityId ?? undefined,
    serviceUrl: state.serviceUrl ?? "",
    teamId: state.teamId ?? undefined,
    tenantId: state.tenantId ?? undefined,
    request(path, body, options) {
      const address = requireAddress();
      return callTeamsConnectorApi({
        ...api,
        body,
        credentials,
        method: options?.method,
        path,
        serviceUrl: address.serviceUrl,
      });
    },
    sendActivity: send,
    replyToActivity(activity) {
      const address = requireAddress();
      const activityId = state.replyToActivityId ?? "";
      if (!activityId) throw new Error("teamsChannel: missing reply activity id.");
      return replyToTeamsActivity({
        ...api,
        body: buildOutboundActivity(state, activity),
        credentials,
        activityId,
        conversationId: address.conversationId,
        serviceUrl: address.serviceUrl,
      });
    },
    updateActivity(activityId, activity) {
      const address = requireAddress();
      return updateTeamsActivity({
        ...api,
        body: buildOutboundActivity(state, activity),
        credentials,
        activityId,
        conversationId: address.conversationId,
        serviceUrl: address.serviceUrl,
      });
    },
    async startTyping() {
      const address = requireAddress();
      await triggerTeamsTypingIndicator({
        ...api,
        credentials,
        conversationId: address.conversationId,
        serviceUrl: address.serviceUrl,
      });
    },
  };
}

async function verifyInbound(
  req: Request,
  credentials: TeamsChannelCredentials | undefined,
): Promise<string | null> {
  try {
    return await verifyTeamsRequest(req, {
      appId: credentials?.webhookVerifier ? undefined : credentials?.appId,
      webhookVerifier: credentials?.webhookVerifier,
    });
  } catch (error) {
    log.warn("teams inbound verification failed", { error });
    return null;
  }
}

async function dispatchMessage(input: {
  readonly activity: TeamsMessageActivity;
  readonly config: TeamsChannelConfig;
  readonly filesPolicy: TeamsFilesPolicy;
  readonly onMessage: NonNullable<TeamsChannelConfig["onMessage"]>;
  readonly send: SendFn<TeamsChannelState>;
}): Promise<void> {
  const state = stateFromActivity(input.activity);
  const ctx = buildTeamsBinding({ config: input.config, state });

  let result: TeamsInboundResult;
  try {
    result = await input.onMessage(ctx, input.activity);
  } catch (error) {
    log.error("Teams message handler failed", { error });
    return;
  }
  if (result === null || result === undefined) return;

  const fileParts = collectTeamsFileParts(input.activity.attachments, input.filesPolicy);
  const turnMessage = buildTeamsTurnMessage(input.activity.text, fileParts);
  const inboundContext: TeamsInboundContext = {
    activityId: input.activity.id,
    channelId: input.activity.teamsChannelId,
    conversationId: input.activity.conversation.id,
    conversationType: input.activity.conversationType,
    scope: input.activity.scope,
    teamId: input.activity.teamId,
    tenantId: input.activity.tenantId,
    userId: input.activity.from.id,
    userName: input.activity.from.name,
  };
  const channelContext = result.context ?? [];

  try {
    await input.send(
      {
        message: turnMessage,
        context: [formatTeamsContextBlock(inboundContext), ...channelContext],
      },
      {
        auth: result.auth,
        continuationToken: stateToken(state),
        state,
      },
    );
  } catch (error) {
    log.error("Teams message delivery failed", { error });
  }
}

async function handleInvoke(input: {
  readonly activity: TeamsInvokeActivity;
  readonly config: TeamsChannelConfig;
  readonly send: SendFn<TeamsChannelState>;
  readonly waitUntil: (task: Promise<unknown>) => void;
}): Promise<Response> {
  if (isTeamsInputResponseActivity(input.activity)) {
    input.waitUntil(
      dispatchInputResponses({
        activity: input.activity,
        send: input.send,
      }),
    );
    return Response.json(teamsInvokeResponse());
  }

  if (input.config.onInvoke === undefined) return teamsOk();
  const ctx = buildTeamsBinding({ config: input.config, state: stateFromActivity(input.activity) });
  const result = await input.config.onInvoke(ctx, input.activity);
  if (result instanceof Response) return result;
  if (result && typeof result === "object") return Response.json(result);
  return teamsOk();
}

async function dispatchInputResponses(input: {
  readonly activity: TeamsInvokeActivity | TeamsMessageActivity;
  readonly send: SendFn<TeamsChannelState>;
}): Promise<void> {
  const inputResponses = deriveTeamsInputResponses(input.activity as TeamsActivity);
  if (inputResponses.length === 0) return;
  const state = stateFromActivity(input.activity);
  try {
    await input.send(
      { inputResponses },
      {
        auth: null,
        continuationToken: stateToken(state),
        state,
      },
    );
  } catch (error) {
    log.error("Teams input response delivery failed", { error });
  }
}

function stateFromActivity(
  activity: TeamsMessageActivity | TeamsInvokeActivity,
): TeamsChannelState {
  return {
    bot: activity.recipient,
    channelId: activity.teamsChannelId ?? null,
    conversationId: activity.conversation.id,
    conversationType: activity.conversationType ?? activity.scope,
    pendingAuthActivityId: null,
    replyToActivityId: teamsThreadRootActivityId(activity),
    serviceUrl: activity.serviceUrl,
    teamId: activity.teamId ?? null,
    tenantId: activity.tenantId ?? null,
    triggeringUser: activity.from,
  };
}

function initialTeamsState(): TeamsChannelState {
  return {
    bot: null,
    channelId: null,
    conversationId: null,
    conversationType: null,
    pendingAuthActivityId: null,
    replyToActivityId: null,
    serviceUrl: null,
    teamId: null,
    tenantId: null,
    triggeringUser: null,
  };
}

function stateToken(state: TeamsChannelState): string {
  const conversationId = state.conversationId ?? "";
  if (!conversationId) throw new Error("teamsChannel: missing conversation id.");
  return teamsContinuationToken({
    conversationId,
    replyToActivityId: state.replyToActivityId,
    tenantId: state.tenantId,
  });
}

function buildOutboundActivity(
  state: TeamsChannelState,
  message: TeamsMessageBody | TeamsOutboundActivity | string,
): TeamsOutboundActivity {
  if (typeof message !== "string" && "type" in message && message.type === "typing") {
    return message;
  }

  const body = normalizeTeamsPostInput(message);
  const channelData = mergeChannelData(state, body.channelData);
  return {
    ...body,
    channelData,
    conversation: state.conversationId ? { id: state.conversationId } : undefined,
    from: state.bot ?? undefined,
    replyToId: state.replyToActivityId ?? undefined,
    type: "message",
  };
}

function mergeChannelData(
  state: TeamsChannelState,
  channelData: JsonObject | undefined,
): JsonObject | undefined {
  const merged: Record<string, unknown> = { ...channelData };
  if (state.tenantId) merged.tenant = { id: state.tenantId };
  if (state.teamId) merged.team = { id: state.teamId };
  if (state.channelId) merged.channel = { id: state.channelId };
  return Object.keys(merged).length > 0 ? parseJsonObject(merged) : undefined;
}

function teamsOk(): Response {
  return new Response("ok", { status: 200 });
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
