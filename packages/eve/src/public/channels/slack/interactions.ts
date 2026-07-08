/**
 * Slack `block_actions` + `view_submission` wire handling.
 *
 * The route handler reads the form-encoded body, hands it here, and we:
 *
 * 1. Decode `block_actions` payloads into a typed shape the channel can
 *    work with — actions, channel/thread metadata, the clicker, and the
 *    full original block list for answered-card updates.
 * 2. Open the freeform-answer modal inline when the click was a "Type
 *    your answer" button (Slack's `trigger_id` is only valid for ~3s,
 *    so this can't run under `waitUntil`).
 * 3. Resolve `view_submission` payloads (freeform modal submissions)
 *    back into parked HITL requests via `send`.
 *
 * Anything we don't consume flows through to the user-supplied
 * `onInteraction` callback. Always returns `Response("ok")` — followup
 * work runs under `waitUntil` so the webhook ACK is immediate.
 */

import {
  parseSlackWebhookBody,
  type SlackBlockActionsPayload,
  type SlackViewSubmissionPayload,
} from "#compiled/@chat-adapter/slack/webhook.js";

import { createLogger } from "#internal/logging.js";
import {
  buildSlackBinding,
  resolveSlackBotToken,
  slackContinuationToken,
} from "#public/channels/slack/api.js";
import { buildSlackAuthContext } from "#public/channels/slack/auth.js";
import {
  buildAnsweredBlocks,
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
import {
  SLACK_CARD_SUBTEXT_MAX_LENGTH,
  truncateCardSubtext,
} from "#public/channels/slack/limits.js";
import type {
  SlackChannelConfig,
  SlackChannelState,
  SlackContext,
  SlackInteractionAction,
  SlackInteractionUser,
} from "#public/channels/slack/slackChannel.js";
import type { SendFn } from "#public/definitions/channel.js";

const log = createLogger("slack.interactions");

/**
 * Decoded view of a Slack `block_actions` payload. Returned by
 * {@link parseBlockActionsPayload} and read by the handler.
 */
interface ParsedBlockActionsPayload {
  readonly actions: SlackInteractionAction[];
  readonly channelId: string;
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
  const teamId = team?.id ?? userBlock.team_id;
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
    threadTs: body.threadTs,
    teamId: body.teamId,
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
  const prompt = findPromptBlock(blocks) as { text?: { text?: unknown } } | undefined;
  const text = prompt?.text?.text;
  return typeof text === "string" && text.length > 0 ? text : undefined;
}

function buildAnsweredHitlMessageBlocks(input: {
  readonly actionId: string;
  readonly answerLabel: string;
  readonly messageBlocks: readonly unknown[];
  readonly userId: string;
}): unknown[] {
  const actionBlockIndex = findActionBlockIndex(input.messageBlocks, input.actionId);
  if (actionBlockIndex === -1) {
    return buildAnsweredBlocks({
      promptBlocks: findPromptBlocks(input.messageBlocks),
      answerLabel: input.answerLabel,
      userId: input.userId,
    });
  }

  const actionBlock = input.messageBlocks[actionBlockIndex];
  const answeredBlocks =
    answeredBlocksFromActionBlock({
      answerLabel: input.answerLabel,
      block: actionBlock,
      userId: input.userId,
    }) ??
    buildAnsweredBlocks({
      promptBlocks: promptBlocksFromActionBlock(actionBlock),
      answerLabel: input.answerLabel,
      userId: input.userId,
    });
  return [
    ...input.messageBlocks.slice(0, actionBlockIndex),
    ...answeredBlocks,
    ...input.messageBlocks.slice(actionBlockIndex + 1),
  ];
}

function findActionBlockIndex(blocks: readonly unknown[], actionId: string): number {
  return blocks.findIndex((block) => blockContainsActionId(block, actionId));
}

function blockContainsActionId(block: unknown, actionId: string): boolean {
  if (!isObjectRecord(block)) return false;
  return (
    actionsContainActionId(block.elements, actionId) ||
    actionsContainActionId(block.actions, actionId)
  );
}

function actionsContainActionId(actions: unknown, actionId: string): boolean {
  if (!Array.isArray(actions)) return false;
  return actions.some((element) => isObjectRecord(element) && element.action_id === actionId);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function answeredBlocksFromActionBlock(input: {
  readonly answerLabel: string;
  readonly block: unknown;
  readonly userId: string;
}): unknown[] | undefined {
  if (!isObjectRecord(input.block) || input.block.type !== "card") return undefined;

  const { actions: _actions, subtext: _subtext, ...blockWithoutActions } = input.block;
  const answeredCard = {
    ...blockWithoutActions,
    subtext: {
      type: "mrkdwn",
      text: formatAnsweredCardSubtext(input),
      verbatim: false,
    },
  };
  return hasCardContent(answeredCard) ? [answeredCard] : undefined;
}

const ANSWERED_CARD_SUBTEXT_PREFIX = ":white_check_mark: *";
const ANSWERED_CARD_SUBTEXT_SUFFIX = "*";

function formatAnsweredCardSubtext(input: {
  readonly answerLabel: string;
  readonly userId: string;
}): string {
  const attribution = input.userId.length > 0 ? ` by <@${input.userId}>` : "";
  const labelBudget =
    SLACK_CARD_SUBTEXT_MAX_LENGTH -
    ANSWERED_CARD_SUBTEXT_PREFIX.length -
    ANSWERED_CARD_SUBTEXT_SUFFIX.length -
    attribution.length;
  const label = truncateWithEllipsis(input.answerLabel, labelBudget);
  return truncateCardSubtext(
    `${ANSWERED_CARD_SUBTEXT_PREFIX}${label}${ANSWERED_CARD_SUBTEXT_SUFFIX}${attribution}`,
  );
}

function truncateWithEllipsis(value: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  if (value.length <= maxLength) return value;
  const sliceLength = Math.max(0, maxLength - 3);
  return `${value.slice(0, sliceLength).trimEnd()}...`;
}

function promptBlocksFromActionBlock(block: unknown): unknown[] {
  if (!isObjectRecord(block) || block.type !== "card") return [];

  const { actions: _actions, ...blockWithoutActions } = block;
  return hasCardContent(blockWithoutActions) ? [blockWithoutActions] : [];
}

function hasCardContent(block: Record<string, unknown>): boolean {
  return block.body !== undefined || block.title !== undefined || block.hero_image !== undefined;
}

/**
 * Channel-supplied dependencies for {@link handleInteractionPost}.
 *
 * Carries the bits the handler needs that come from channel
 * construction: credentials for outbound API calls and the user's
 * `onInteraction` callback for non-HITL clicks.
 */
export interface InteractionHandlerDeps {
  readonly config: SlackChannelConfig;
}

/**
 * Entry point for Slack's form-encoded interactivity endpoint. Routes
 * `view_submission` payloads to the freeform-answer flow, intercepts
 * "Type your answer" button clicks to open a modal, resolves
 * framework HITL clicks against the parked session, and forwards
 * anything else to `config.onInteraction`.
 */
export async function handleInteractionPost(
  rawBody: string,
  ctx: {
    send: SendFn<SlackChannelState>;
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

  if (payload.kind !== "block_actions") return ack;

  const interaction = parseBlockActionsPayload(payload);
  if (!interaction) return ack;

  const freeformAction = interaction.actions.find((a) => isFreeformAction(a.actionId));
  if (freeformAction) {
    await openFreeformModal({ payload: payload.raw, interaction, freeformAction, deps });
    return ack;
  }

  const continuationToken = slackContinuationToken(interaction.channelId, interaction.threadTs);
  const inputResponses = interaction.actions
    .map(deriveHitlResponse)
    .filter((r): r is { requestId: string; optionId: string } => r !== null);

  if (inputResponses.length > 0) {
    const user = interaction.actions[0]?.user;
    if (!user) return ack;

    ctx.waitUntil(
      ctx
        .send(
          { inputResponses },
          {
            auth: buildSlackAuthContext({
              channelId: interaction.channelId,
              teamId: interaction.teamId,
              threadTs: interaction.threadTs,
              userId: user.id,
              userName: user.username ?? user.name,
            }),
            continuationToken,
            state: {
              channelId: interaction.channelId,
              threadTs: interaction.threadTs,
              teamId: interaction.teamId ?? null,
              triggeringUserId: user.id,
            },
          },
        )
        .catch((error: unknown) => {
          log.error("HITL interaction delivery failed", { error });
        }),
    );

    ctx.waitUntil(
      updateAnsweredHitlCard(interaction, deps).catch((error: unknown) => {
        log.error("HITL answered-card update failed", { error });
      }),
    );
  }

  const onInteraction = deps.config.onInteraction;
  if (onInteraction) {
    const customActions = interaction.actions.filter((a) => !isHitlAction(a.actionId));
    if (customActions.length > 0) {
      const { thread, slack } = buildSlackBinding({
        botToken: deps.config.credentials?.botToken,
        channelId: interaction.channelId,
        threadTs: interaction.threadTs,
        teamId: interaction.teamId,
      });
      const slackCtx: SlackContext = { thread, slack };
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
    threadTs: input.interaction.threadTs,
    messageTs,
    requestId,
  };

  const promptText = readPromptTextFromBlocks(input.interaction.messageBlocks);
  const view = buildFreeformModalView({ metadata, prompt: promptText });
  const token = await resolveSlackBotToken(input.deps.config.credentials?.botToken);

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
    send: SendFn<SlackChannelState>;
    waitUntil: (task: Promise<unknown>) => void;
  },
  _deps: InteractionHandlerDeps,
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

  ctx.waitUntil(
    ctx
      .send(
        { inputResponses: [{ requestId: metadata.requestId, text }] },
        {
          auth: buildSlackAuthContext({
            channelId: metadata.channelId,
            teamId,
            threadTs: metadata.threadTs,
            userId: triggeringUserId,
            userName: user?.username ?? user?.name,
          }),
          continuationToken: metadata.continuationToken,
          state: {
            channelId: metadata.channelId,
            threadTs: metadata.threadTs,
            teamId,
            triggeringUserId,
          },
        },
      )
      .catch((error: unknown) => {
        log.error("freeform answer delivery failed", { error });
      }),
  );

  ctx.waitUntil(
    updateAnsweredFreeformCard({
      channelId: metadata.channelId,
      messageTs: metadata.messageTs,
      answerLabel: text,
      userId: triggeringUserId ?? undefined,
      deps: _deps,
    }).catch((error: unknown) => {
      log.error("freeform answered-card update failed", { error });
    }),
  );

  return ack;
}

async function updateAnsweredHitlCard(
  interaction: ParsedBlockActionsPayload,
  deps: InteractionHandlerDeps,
): Promise<void> {
  const hitlAction = interaction.actions.find((a) => isHitlAction(a.actionId));
  if (!hitlAction || !hitlAction.messageTs) return;

  const answerLabel = hitlAction.label ?? hitlAction.selectedOptionValue ?? hitlAction.value;
  if (!answerLabel) return;

  const blocks = buildAnsweredHitlMessageBlocks({
    actionId: hitlAction.actionId,
    answerLabel,
    messageBlocks: interaction.messageBlocks,
    userId: hitlAction.user.id,
  });

  const token = await resolveSlackBotToken(deps.config.credentials?.botToken);
  const response = await fetch("https://slack.com/api/chat.update", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: interaction.channelId,
      ts: hitlAction.messageTs,
      blocks,
      text: `Answered: ${answerLabel}`,
    }),
  });
  if (!response.ok) {
    throw new Error(`Slack chat.update returned HTTP ${response.status}`);
  }
}

async function updateAnsweredFreeformCard(input: {
  readonly channelId: string;
  readonly messageTs: string;
  readonly answerLabel: string;
  readonly userId?: string;
  readonly deps: InteractionHandlerDeps;
}): Promise<void> {
  const blocks = buildAnsweredBlocks({
    promptBlocks: [],
    answerLabel: input.answerLabel,
    userId: input.userId,
  });
  const token = await resolveSlackBotToken(input.deps.config.credentials?.botToken);
  const response = await fetch("https://slack.com/api/chat.update", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({
      channel: input.channelId,
      ts: input.messageTs,
      blocks,
      text: `Answered: ${input.answerLabel}`,
    }),
  });
  if (!response.ok) {
    throw new Error(`Slack chat.update returned HTTP ${response.status}`);
  }
}

export type { ParsedBlockActionsPayload };
