/**
 * Slack interactivity wire handling. It decodes and authorizes framework HITL
 * responses, opens freeform modals inline before Slack's trigger expires, and
 * forwards user-owned actions, shortcuts, and slash commands to their authored hooks.
 */

import {
  parseSlackWebhookBody,
  type SlackBlockActionsPayload,
  type SlackViewSubmissionPayload,
} from "#compiled/@chat-adapter/slack/webhook.js";

import { createLogger } from "#internal/logging.js";
import {
  buildSlackBinding,
  buildSlackWorkspaceHandle,
  resolveSlackBotToken,
  slackContinuationToken,
} from "#public/channels/slack/api.js";
import { buildSlackAuthContext } from "#public/channels/slack/auth.js";
import {
  buildFreeformModalView,
  deriveHitlResponse,
  freeformRequestIdFromActionId,
  HITL_FREEFORM_MODAL_ACTION_ID,
  HITL_FREEFORM_MODAL_BLOCK_ID,
  HITL_FREEFORM_MODAL_CALLBACK_ID,
  isFreeformAction,
  isHitlAction,
  type HitlFreeformModalMetadata,
} from "#public/channels/slack/hitl.js";
import { readSlackTextObject } from "#public/channels/slack/inbound-content.js";
import {
  updateAnsweredFreeformCard,
  updateAnsweredHitlCard,
} from "#public/channels/slack/interaction-cards.js";
import {
  approvalResponderStatePatch,
  authorizeInputResponse,
} from "#public/channels/slack/input-response.js";
import type {
  SlackChannelConfig,
  SlackChannelState,
  SlackInputResponseSubmission,
  SlackInteractionAction,
  SlackMessageInteractionContext,
  SlackShortcut,
  SlackShortcutContext,
} from "#public/channels/slack/slackChannel.js";
import type { ChannelFrom, ChannelResolveSession } from "#channel/channel-operations.js";
import { bindSlackSessionOperations } from "#public/channels/slack/session-operations.js";
import { dispatchSlashCommand } from "#public/channels/slack/slash-command.js";
import { parseInputResponse } from "#shared/input.js";
import { handleAuthoredInteraction } from "#public/channels/slack/interaction-handler.js";
import {
  isObjectRecord,
  readOptionalString,
  readSlackInteractionIdentity,
  readSlackInstallationTeamId,
} from "#public/channels/slack/interaction-identity.js";

const log = createLogger("slack.interactions");

/**
 * Decoded view of a Slack `block_actions` payload. Returned by
 * {@link parseBlockActionsPayload} and read by the handler.
 */
interface ParsedBlockActionsPayload {
  readonly actions: SlackInteractionAction[];
  readonly channelId: string;
  readonly installationTeamId: string | undefined;
  readonly threadTs: string;
  readonly teamId: string | undefined;
  /**
   * The full block list off the clicked message. Preserved on the
   * answered-card update so the original prompt stays visible after the
   * interactive controls are stripped.
   */
  readonly messageBlocks: readonly unknown[];
}

/**
 * Decodes a Slack `block_actions` payload into a {@link ParsedBlockActionsPayload}.
 * Returns `null` for payloads that don't carry the channel/thread
 * metadata the handler needs.
 */
export function parseBlockActionsPayload(
  body: Record<string, unknown> | SlackBlockActionsPayload,
): ParsedBlockActionsPayload | null {
  if (isSharedBlockActionsPayload(body)) {
    return parseSharedBlockActionsPayload(body);
  }

  const rawBody = body as Record<string, unknown>;
  const actions = rawBody.actions;
  if (!Array.isArray(actions)) return null;

  // `channel` and `message` are Optional on block_actions payloads — only
  // present when the action was triggered from a message in a channel.
  const channel = (rawBody.channel as { id: string } | undefined)?.id;
  const message = rawBody.message as
    | { ts: string; thread_ts?: string; blocks?: unknown[] }
    | undefined;
  const threadTs = message?.thread_ts ?? message?.ts;
  if (!channel || !threadTs) return null;

  const identity = readSlackInteractionIdentity(rawBody);
  const user = identity.user;
  if (user === undefined) return null;
  const messageBlocks = message?.blocks ?? [];

  return {
    actions: actions.map((a: Record<string, unknown>) => ({
      actionId: String(a.action_id ?? ""),
      value: a.value != null ? String(a.value) : undefined,
      blockId: a.block_id != null ? String(a.block_id) : undefined,
      selectedOptionValue: extractSelectedOptionValue(a),
      messageTs: message?.ts,
      label: extractActionLabel(a),
      user,
    })),
    channelId: channel,
    installationTeamId: identity.installationTeamId,
    threadTs,
    teamId: identity.teamId,
    messageBlocks,
  };
}

function isSharedBlockActionsPayload(
  body: Record<string, unknown> | SlackBlockActionsPayload,
): body is SlackBlockActionsPayload {
  return body.kind === "block_actions" && Array.isArray(body.actions);
}

function parseSharedBlockActionsPayload(
  body: SlackBlockActionsPayload,
): ParsedBlockActionsPayload | null {
  if (!body.channelId || !body.threadTs) return null;

  const identity = readSlackInteractionIdentity(body.raw);
  return {
    actions: body.actions.map((action) => ({
      actionId: action.actionId,
      value: action.value,
      blockId: action.blockId,
      selectedOptionValue: action.selectedOptionValue,
      messageTs: body.messageTs,
      label: action.label,
      user: {
        id: action.user?.id ?? body.userId,
        username: action.user?.username,
        name: action.user?.name,
      },
    })),
    channelId: body.channelId,
    installationTeamId: identity.installationTeamId,
    threadTs: body.threadTs,
    teamId: body.user?.teamId ?? identity.teamId ?? body.teamId,
    messageBlocks: body.messageBlocks ?? [],
  };
}

function extractSelectedOptionValue(action: Record<string, unknown>): string | undefined {
  const selected = action.selected_option as { value?: unknown } | undefined;
  return typeof selected?.value === "string" ? selected.value : undefined;
}

function extractActionLabel(action: Record<string, unknown>): string | undefined {
  const selected = action.selected_option as { text?: { text?: unknown } } | undefined;
  const fromSelected = selected?.text?.text;
  if (typeof fromSelected === "string" && fromSelected.length > 0) return fromSelected;
  const buttonText = (action.text as { text?: unknown } | undefined)?.text;
  if (typeof buttonText === "string" && buttonText.length > 0) return buttonText;
  return undefined;
}

function findPromptBlock(blocks: readonly unknown[]): unknown {
  return findPromptBlocks(blocks)[0];
}

function findPromptBlocks(blocks: readonly unknown[]): unknown[] {
  const promptBlocks: unknown[] = [];
  for (const block of blocks) {
    if (typeof block !== "object" || block === null) {
      continue;
    }
    const type = (block as { type?: unknown }).type;
    if (type === "actions") {
      break;
    }
    if (type === "section" || type === "context" || type === "divider" || type === "image") {
      promptBlocks.push(block);
    }
  }
  return promptBlocks;
}

function readPromptTextFromBlocks(blocks: readonly unknown[]): string | undefined {
  const prompt = findPromptBlock(blocks) as { text?: unknown } | undefined;
  const text = readSlackTextObject(prompt?.text);
  return text.length > 0 ? text : undefined;
}

/** Channel-supplied dependencies for {@link handleInteractionPost}. */
export interface InteractionHandlerDeps {
  readonly config: SlackChannelConfig;
  readonly onInputResponse: NonNullable<SlackChannelConfig["onInputResponse"]>;
}

/**
 * Entry point for Slack's form-encoded interactivity endpoint. Routes
 * `view_submission` payloads to the freeform-answer flow, intercepts
 * "Type your answer" button clicks to open a modal, resolves
 * framework HITL clicks through `onInputResponse` to the parked session,
 * forwards other block actions to `config.onInteraction`, shortcuts to
 * `config.onShortcut`, and slash commands to `config.onSlashCommand`.
 */
export async function handleInteractionPost(
  rawBody: string,
  ctx: {
    from: ChannelFrom<SlackChannelState>;
    resolveSession: ChannelResolveSession;
    waitUntil: (task: Promise<unknown>) => void;
  },
  deps: InteractionHandlerDeps,
): Promise<Response> {
  const ack = new Response("ok", { status: 200 });

  let payload;
  try {
    payload = parseSlackWebhookBody(rawBody, {
      contentType: "application/x-www-form-urlencoded",
    });
  } catch {
    log.warn("failed to parse Slack interaction payload");
    return ack;
  }

  const authoredInteraction = (
    raw: unknown,
    type: string,
    fallbackResponse: Response = ack,
    message?: SlackMessageInteractionContext,
  ) => handleAuthoredInteraction(raw, type, ctx.waitUntil, deps.config, fallbackResponse, message);

  if (payload.kind === "view_submission") {
    return payload.callbackId === HITL_FREEFORM_MODAL_CALLBACK_ID
      ? handleViewSubmission(payload, ctx, deps)
      : authoredInteraction(payload.raw, payload.kind, new Response(null, { status: 200 }));
  }

  if (payload.kind === "slash_command") {
    dispatchSlashCommand(payload, ctx, deps.config);
    return new Response(null, { status: 200 });
  }

  if (payload.kind === "unsupported") {
    const shortcut = parseShortcutPayload(payload.raw);
    if (shortcut !== null && deps.config.onShortcut !== undefined) {
      dispatchShortcut(shortcut, readSlackInstallationTeamId(payload.raw), ctx, deps);
      return new Response(null, { status: 200 });
    }
    return authoredInteraction(payload.raw, payload.type);
  }

  if (payload.kind !== "block_actions") {
    return authoredInteraction(payload.raw, payload.kind);
  }

  const interaction = parseBlockActionsPayload(payload);
  if (!interaction) return authoredInteraction(payload.raw, payload.kind);

  const freeformAction = interaction.actions.find((a) => isFreeformAction(a.actionId));
  if (freeformAction) {
    await openFreeformModal({ payload: payload.raw, interaction, freeformAction, deps });
    return ack;
  }

  const continuationToken = slackContinuationToken(interaction.channelId, interaction.threadTs);
  const hitlActions = interaction.actions.flatMap((action) => {
    const derived = deriveHitlResponse(action);
    return derived === null ? [] : [{ action, derived }];
  });

  if (hitlActions.length > 0) {
    const user = hitlActions[0]!.action.user;
    ctx.waitUntil(
      dispatchBlockInputResponses({
        ctx,
        deps,
        interaction,
        submission: {
          type: "block_actions",
          actions: hitlActions.map(({ action }) => action),
          inputResponses: hitlActions.map(({ derived }) => derived.response),
          messageTs: hitlActions[0]!.action.messageTs,
          user,
        },
      }),
    );
  }

  // A callback containing any eve-owned action stays reserved even when it
  // also contains custom actions, since onInteraction receives the raw payload.
  if (hitlActions.length > 0) return ack;

  const customAction = interaction.actions.find((action) => !isHitlAction(action.actionId));
  if (customAction === undefined) return ack;

  const { thread, slack } = buildSlackBinding({
    botToken: deps.config.credentials?.botToken,
    channelId: interaction.channelId,
    threadTs: interaction.threadTs,
    installationTeamId: interaction.installationTeamId,
    teamId: interaction.teamId,
  });
  const message: SlackMessageInteractionContext = {
    ...bindSlackSessionOperations({
      address: continuationToken,
      defaultAuth: buildSlackAuthContext({
        channelId: interaction.channelId,
        teamId: interaction.teamId,
        threadTs: interaction.threadTs,
        userId: customAction.user.id,
        userName: customAction.user.username ?? customAction.user.name,
      }),
      from: ctx.from,
      resolveSession: ctx.resolveSession,
      state: {
        channelId: interaction.channelId,
        installationTeamId: interaction.installationTeamId ?? null,
        teamId: interaction.teamId ?? null,
        threadTs: interaction.threadTs,
        triggeringUserId: customAction.user.id,
      },
    }),
    thread,
    slack,
  };
  return authoredInteraction(payload.raw, payload.kind, ack, message);
}

/** Normalizes Slack's two shortcut payload variants. */
export function parseShortcutPayload(raw: unknown): SlackShortcut | null {
  if (!isObjectRecord(raw)) return null;
  const type = raw.type;
  if (type !== "message_action" && type !== "shortcut") return null;

  const callbackId = readRequiredString(raw.callback_id);
  const triggerId = readRequiredString(raw.trigger_id);
  if (callbackId === null || triggerId === null) return null;

  const identity = readSlackInteractionIdentity(raw);
  const teamId = identity.teamId;
  const user = identity.user;
  if (user === undefined) return null;

  if (type === "shortcut") {
    return { type, callbackId, triggerId, user, teamId };
  }

  const channelBlock = isObjectRecord(raw.channel) ? raw.channel : undefined;
  const messageBlock = isObjectRecord(raw.message) ? raw.message : undefined;
  const channelId = readRequiredString(channelBlock?.id);
  const messageTs = readRequiredString(messageBlock?.ts);
  if (channelId === null || messageTs === null || messageBlock === undefined) return null;

  return {
    type,
    callbackId,
    triggerId,
    user,
    teamId,
    channelId,
    message: {
      text: typeof messageBlock.text === "string" ? messageBlock.text : "",
      ts: messageTs,
      threadTs: readOptionalString(messageBlock.thread_ts),
      userId: readOptionalString(messageBlock.user),
    },
    responseUrl: readOptionalString(raw.response_url),
  };
}

function readRequiredString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function dispatchShortcut(
  shortcut: SlackShortcut,
  installationTeamId: string | undefined,
  ctx: { readonly waitUntil: (task: Promise<unknown>) => void },
  deps: InteractionHandlerDeps,
): void {
  const onShortcut = deps.config.onShortcut;
  if (onShortcut === undefined) {
    log.warn("Slack shortcut ignored because onShortcut is not configured", {
      type: shortcut.type,
    });
    return;
  }

  const shortcutCtx: SlackShortcutContext = buildShortcutContext({
    config: deps.config,
    installationTeamId,
    teamId: shortcut.teamId,
  });
  dispatchInteractionHook(() => onShortcut(shortcut, shortcutCtx), ctx, "shortcut handler failed");
}

function buildShortcutContext(input: {
  readonly config: SlackChannelConfig;
  readonly installationTeamId: string | undefined;
  readonly teamId: string | undefined;
}): SlackShortcutContext {
  return {
    slack: buildSlackWorkspaceHandle({
      botToken: input.config.credentials?.botToken,
      installationTeamId: input.installationTeamId,
      teamId: input.teamId,
    }),
  };
}

function dispatchInteractionHook(
  handler: () => void | Promise<void>,
  ctx: { readonly waitUntil: (task: Promise<unknown>) => void },
  failureMessage: string,
): void {
  ctx.waitUntil(
    Promise.resolve()
      .then(handler)
      .catch((error: unknown) => {
        log.error(failureMessage, { error });
      }),
  );
}

async function dispatchBlockInputResponses(input: {
  readonly ctx: {
    from: ChannelFrom<SlackChannelState>;
  };
  readonly deps: InteractionHandlerDeps;
  readonly interaction: ParsedBlockActionsPayload;
  readonly submission: Extract<SlackInputResponseSubmission, { type: "block_actions" }>;
}): Promise<void> {
  const result = await authorizeInputResponse({
    channelId: input.interaction.channelId,
    deps: input.deps,
    installationTeamId: input.interaction.installationTeamId,
    submission: input.submission,
    teamId: input.interaction.teamId,
    threadTs: input.interaction.threadTs,
  });
  if (result === null) return;

  try {
    await input.ctx
      .from(slackContinuationToken(input.interaction.channelId, input.interaction.threadTs))
      .respond(input.submission.inputResponses, {
        auth: result.auth,
        state: approvalResponderStatePatch(input.submission, result.auth),
      });
  } catch (error) {
    log.error("HITL interaction delivery failed", { error });
    return;
  }

  if (
    input.submission.actions.some((action) => deriveHitlResponse(action)?.kind === "tool-approval")
  ) {
    return;
  }

  try {
    await updateAnsweredHitlCard(input.interaction, input.deps);
  } catch (error) {
    log.error("HITL answered-card update failed", { error });
  }
}

async function openFreeformModal(input: {
  readonly payload: Record<string, unknown>;
  readonly interaction: ParsedBlockActionsPayload;
  readonly freeformAction: SlackInteractionAction;
  readonly deps: InteractionHandlerDeps;
}): Promise<void> {
  const triggerId = (input.payload as { trigger_id?: unknown }).trigger_id;
  if (typeof triggerId !== "string" || triggerId.length === 0) {
    log.warn("freeform button click missing trigger_id — cannot open modal");
    return;
  }

  const requestId =
    freeformRequestIdFromActionId(input.freeformAction.actionId) ?? input.freeformAction.value;
  if (!requestId) {
    log.warn("freeform button click missing requestId");
    return;
  }

  const messageTs = input.freeformAction.messageTs;
  if (!messageTs) {
    log.warn("freeform button click missing messageTs");
    return;
  }

  const metadata: HitlFreeformModalMetadata = {
    continuationToken: slackContinuationToken(
      input.interaction.channelId,
      input.interaction.threadTs,
    ),
    channelId: input.interaction.channelId,
    installationTeamId: input.interaction.installationTeamId,
    threadTs: input.interaction.threadTs,
    messageTs,
    requestId,
  };

  const promptText = readPromptTextFromBlocks(input.interaction.messageBlocks);
  const view = buildFreeformModalView({ metadata, prompt: promptText });
  const token = await resolveSlackBotToken(input.deps.config.credentials?.botToken, {
    teamId: input.interaction.installationTeamId,
  });

  const response = await fetch("https://slack.com/api/views.open", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ trigger_id: triggerId, view }),
  });
  if (!response.ok) {
    log.error("Slack views.open returned non-2xx", { status: response.status });
  }
}

async function handleViewSubmission(
  payload: SlackViewSubmissionPayload,
  ctx: {
    from: ChannelFrom<SlackChannelState>;
    waitUntil: (task: Promise<unknown>) => void;
  },
  deps: InteractionHandlerDeps,
): Promise<Response> {
  // Slack view submissions require an empty 200 body to close the modal.
  const ack = new Response(null, { status: 200 });
  let metadata: HitlFreeformModalMetadata;
  try {
    metadata = JSON.parse(payload.privateMetadata ?? "") as HitlFreeformModalMetadata;
  } catch {
    log.warn("freeform view_submission carries invalid private_metadata");
    return ack;
  }
  if (
    !metadata.continuationToken ||
    !metadata.requestId ||
    !metadata.messageTs ||
    !metadata.channelId ||
    !metadata.threadTs
  ) {
    return ack;
  }

  const text =
    payload.values?.find(
      (value) =>
        value.blockId === HITL_FREEFORM_MODAL_BLOCK_ID &&
        value.actionId === HITL_FREEFORM_MODAL_ACTION_ID,
    )?.value ?? "";
  if (text.length === 0) return ack;

  // `user` is Required on view_submission payloads; `team_id` is on the
  // user object in modern payloads but not guaranteed in all examples.
  const user = payload.user;
  const triggeringUserId = payload.userId;
  const teamId = user?.teamId ?? payload.teamId ?? null;
  const installationTeamId =
    metadata.installationTeamId ?? readSlackInstallationTeamId(payload.raw);
  const submission: SlackInputResponseSubmission = {
    type: "view_submission",
    inputResponses: [parseInputResponse({ requestId: metadata.requestId, text })],
    messageTs: metadata.messageTs,
    user: {
      id: triggeringUserId,
      username: user?.username,
      name: user?.name,
    },
  };

  ctx.waitUntil(
    dispatchViewInputResponse({
      ctx,
      deps,
      installationTeamId,
      metadata,
      submission,
      teamId,
      text,
    }),
  );

  return ack;
}

async function dispatchViewInputResponse(input: {
  readonly ctx: { from: ChannelFrom<SlackChannelState> };
  readonly deps: InteractionHandlerDeps;
  readonly installationTeamId: string | undefined;
  readonly metadata: HitlFreeformModalMetadata;
  readonly submission: Extract<SlackInputResponseSubmission, { type: "view_submission" }>;
  readonly teamId: string | null;
  readonly text: string;
}): Promise<void> {
  const result = await authorizeInputResponse({
    channelId: input.metadata.channelId,
    deps: input.deps,
    installationTeamId: input.installationTeamId,
    submission: input.submission,
    teamId: input.teamId,
    threadTs: input.metadata.threadTs,
  });
  if (result === null) return;

  try {
    await input.ctx
      .from(input.metadata.continuationToken)
      .respond(input.submission.inputResponses, {
        auth: result.auth,
      });
  } catch (error) {
    log.error("freeform answer delivery failed", { error });
    return;
  }

  try {
    await updateAnsweredFreeformCard({
      channelId: input.metadata.channelId,
      messageTs: input.metadata.messageTs,
      answerLabel: input.text,
      userId: input.submission.user.id,
      installationTeamId: input.installationTeamId,
      deps: input.deps,
    });
  } catch (error) {
    log.error("freeform answered-card update failed", { error });
  }
}

export type { ParsedBlockActionsPayload };
