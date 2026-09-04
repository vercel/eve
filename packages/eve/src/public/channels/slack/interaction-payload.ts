import type { SlackBlockActionsPayload } from "#compiled/@chat-adapter/slack/webhook.js";
import type {
  SlackInteractionAction,
  SlackInteractionUser,
} from "#public/channels/slack/slackChannel.js";
import { readSlackTextObject } from "#public/channels/slack/inbound-content.js";

/**
 * Decoded view of a Slack `block_actions` payload. Returned by
 * {@link parseBlockActionsPayload} and read by the handler.
 */
export interface ParsedBlockActionsPayload {
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

export function findPromptBlock(blocks: readonly unknown[]): unknown {
  return findPromptBlocks(blocks)[0];
}

export function findPromptBlocks(blocks: readonly unknown[]): unknown[] {
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

export function readPromptTextFromBlocks(blocks: readonly unknown[]): string | undefined {
  const prompt = findPromptBlock(blocks) as { text?: unknown } | undefined;
  const text = readSlackTextObject(prompt?.text);
  return text.length > 0 ? text : undefined;
}

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function readInstallationTeamId(value: unknown): string | undefined {
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
