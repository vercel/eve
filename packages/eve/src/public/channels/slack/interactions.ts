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
  SlackInteractionContext,
  SlackInteractionUser,
  SlackShortcut,
  SlackShortcutContext,
  SlackSlashCommand,
  SlackSlashCommandContext,
} from "#public/channels/slack/slackChannel.js";
import type { ChannelFrom, ChannelResolveSession } from "#channel/channel-operations.js";
import { bindSlackSessionOperations } from "#public/channels/slack/session-operations.js";
import { parseInputResponse } from "#shared/input.js";

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

  // `team` is Required but can be `null` for org-installed apps.
  // `user` is Required and always carries `id`.
  const team = rawBody.team as { id: string } | null;
  const userBlock = rawBody.user as {
    id: string;
    team_id?: string;
    username?: string;
    name?: string;
  };
  const teamId = userBlock.team_id ?? team?.id;
  const user: SlackInteractionUser = {
    id: userBlock.id,
    username: userBlock.username,
    name: userBlock.name,
  };

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
    installationTeamId: readInstallationTeamId(rawBody),
    threadTs,
    teamId,
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
    installationTeamId: readInstallationTeamId(body.raw),
    threadTs: body.threadTs,
    teamId: body.user?.teamId ?? body.teamId,
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

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readInstallationTeamId(value: unknown): string | undefined {
  if (!isObjectRecord(value)) return undefined;
  const view = isObjectRecord(value.view) ? value.view : undefined;
  const team = isObjectRecord(value.team) ? value.team : undefined;
  const user = isObjectRecord(value.user) ? value.user : undefined;
  // Slack Connect modal submissions put the installation workspace on the
  // nested view, so it must win over the workspace that submitted the view.
  const candidates = [
    view?.app_installed_team_id,
    value.app_installed_team_id,
    team?.id,
    user?.team_id,
    view?.team_id,
  ];
  return candidates.find(
    (candidate): candidate is string => typeof candidate === "string" && candidate.length > 0,
  );
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

  if (payload.kind === "view_submission") {
    return handleViewSubmission(payload, ctx, deps);
  }

  if (payload.kind === "slash_command") {
    dispatchSlashCommand(parseSlashCommandPayload(payload), ctx, deps);
    return new Response(null, { status: 200 });
  }

  if (payload.kind === "unsupported") {
    const shortcut = parseShortcutPayload(payload.raw);
    if (shortcut !== null) {
      dispatchShortcut(shortcut, readInstallationTeamId(payload.raw), ctx, deps);
      return new Response(null, { status: 200 });
    }
    log.warn("unsupported Slack interaction payload ignored", { type: payload.type });
    return ack;
  }

  if (payload.kind !== "block_actions") {
    log.warn("unsupported Slack interaction payload ignored", { type: payload.kind });
    return ack;
  }

  const interaction = parseBlockActionsPayload(payload);
  if (!interaction) return ack;

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

  const onInteraction = deps.config.onInteraction;
  if (onInteraction) {
    const customActions = interaction.actions.filter((a) => !isHitlAction(a.actionId));
    if (customActions.length > 0) {
      const actionUser = customActions[0]!.user;
      const { thread, slack } = buildSlackBinding({
        botToken: deps.config.credentials?.botToken,
        channelId: interaction.channelId,
        threadTs: interaction.threadTs,
        installationTeamId: interaction.installationTeamId,
        teamId: interaction.teamId,
      });
      const slackCtx: SlackInteractionContext = {
        ...bindSlackSessionOperations({
          address: continuationToken,
          defaultAuth: buildSlackAuthContext({
            channelId: interaction.channelId,
            teamId: interaction.teamId,
            threadTs: interaction.threadTs,
            userId: actionUser.id,
            userName: actionUser.username ?? actionUser.name,
          }),
          from: ctx.from,
          resolveSession: ctx.resolveSession,
          state: {
            channelId: interaction.channelId,
            installationTeamId: interaction.installationTeamId ?? null,
            teamId: interaction.teamId ?? null,
            threadTs: interaction.threadTs,
            triggeringUserId: actionUser.id,
          },
        }),
        thread,
        slack,
      };
      for (const action of customActions) {
        ctx.waitUntil(
          Promise.resolve(onInteraction(action, slackCtx)).catch((error: unknown) => {
            log.error("custom interaction handler failed", { error });
          }),
        );
      }
    }
  }

  return ack;
}

/** Normalizes the chat adapter's Slack slash-command payload. */
function parseSlashCommandPayload(
  payload: Extract<ReturnType<typeof parseSlackWebhookBody>, { kind: "slash_command" }>,
): SlackSlashCommand {
  return {
    command: payload.command,
    text: payload.text,
    user: { id: payload.userId, username: payload.userName },
    teamId: payload.teamId,
    channelId: payload.channelId,
    channelName: payload.channelName,
    enterpriseId: payload.enterpriseId,
    isEnterpriseInstall: payload.isEnterpriseInstall,
    triggerId: payload.triggerId,
    responseUrl: payload.responseUrl,
  };
}

/** Normalizes Slack's two shortcut payload variants. */
export function parseShortcutPayload(raw: unknown): SlackShortcut | null {
  if (!isObjectRecord(raw)) return null;
  const type = raw.type;
  if (type !== "message_action" && type !== "shortcut") return null;

  const callbackId = readRequiredString(raw.callback_id);
  const triggerId = readRequiredString(raw.trigger_id);
  const userBlock = isObjectRecord(raw.user) ? raw.user : undefined;
  const userId = readRequiredString(userBlock?.id);
  if (callbackId === null || triggerId === null || userId === null) return null;

  const teamBlock = isObjectRecord(raw.team) ? raw.team : undefined;
  const teamId = readOptionalString(userBlock?.team_id) ?? readOptionalString(teamBlock?.id);
  const user: SlackInteractionUser = {
    id: userId,
    username: readOptionalString(userBlock?.username),
    name: readOptionalString(userBlock?.name),
  };

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

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function dispatchSlashCommand(
  command: SlackSlashCommand,
  ctx: { readonly waitUntil: (task: Promise<unknown>) => void },
  deps: InteractionHandlerDeps,
): void {
  const onSlashCommand = deps.config.onSlashCommand;
  if (onSlashCommand === undefined) {
    log.warn("Slack slash command ignored because onSlashCommand is not configured", {
      command: command.command,
    });
    return;
  }

  const commandCtx: SlackSlashCommandContext = {
    slack: buildSlackWorkspaceHandle({
      botToken: deps.config.credentials?.botToken,
      installationTeamId: command.teamId,
      teamId: command.teamId,
    }),
  };
  dispatchInteractionHook(
    () => onSlashCommand(command, commandCtx),
    ctx,
    "slash command handler failed",
  );
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
  if (payload.callbackId !== HITL_FREEFORM_MODAL_CALLBACK_ID) return ack;

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
  const installationTeamId = metadata.installationTeamId ?? readInstallationTeamId(payload.raw);
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
