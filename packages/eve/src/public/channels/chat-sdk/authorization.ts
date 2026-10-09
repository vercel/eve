import type { Thread } from "#compiled/chat/index.js";
import { createLogger, logError } from "#internal/logging.js";
import { isNotImplemented } from "#public/channels/chat-sdk/notImplemented.js";
import type { ChatSdkChannelEvents } from "#public/channels/chat-sdk/chatSdkChannel.js";
import type { SignInPrompt, SignInSettlement } from "#channel/interaction-prompts.js";

const log = createLogger("chat-sdk.authorization");

type SignInChannel = Parameters<NonNullable<ChatSdkChannelEvents["interaction.opened"]>>[1];

/** Shows a sign-in on a Chat SDK thread; outside a DM its challenge goes only to the person. */
export async function showChatSdkSignIn(
  event: SignInPrompt,
  channel: SignInChannel,
): Promise<void> {
  if (!channel.thread || event.responseId !== undefined) return;
  const pending = channel.state.pendingAuthMessageIds ?? {};
  if (pending[event.name] !== undefined) return;

  const displayName = authorizationDisplayName(event.name, event.authorization?.displayName);
  const prompt = authorizationPrompt({
    displayName,
    instructions: event.authorization?.instructions,
    url: event.authorization?.url,
    userCode: event.authorization?.userCode,
  });
  // Outside a DM the challenge is a credential: it goes only to the person signing in,
  // and the thread sees a link-free status the completion handler can edit.
  let message = prompt;
  if (!channel.thread.isDM) {
    const userId =
      event.principalId === undefined
        ? undefined
        : channel.state.usersByPrincipal?.[event.principalId];
    message =
      typeof userId === "string" && (await postPrivately(channel.thread, userId, prompt))
        ? `Authorization required for ${displayName}. I sent you the sign-in details privately.`
        : `Authorization required for ${displayName}. Continue in a direct message with this agent.`;
  }
  const posted = await channel.thread.post({ markdown: message });
  if (posted.id) {
    channel.state.pendingAuthMessageIds = { ...pending, [event.name]: posted.id };
  }
}

/** Edits a sign-in's status once it ends. */
export async function settleChatSdkSignIn(
  event: SignInSettlement,
  channel: SignInChannel,
): Promise<void> {
  if (!channel.thread || event.responseId !== undefined) return;
  const pending = channel.state.pendingAuthMessageIds ?? {};
  const messageId = pending[event.name];
  if (messageId === undefined) return;

  const message = authorizationCompleted({
    displayName: authorizationDisplayName(event.name, event.authorization?.displayName),
    outcome: event.outcome,
    reason: event.reason,
  });
  try {
    await editMessage(channel.thread, messageId, message);
  } catch (error) {
    if (!isNotImplemented(error)) throw error;
    channel.state.editSupported = false;
    await channel.thread.post({ markdown: message });
  }
  const next = { ...pending };
  delete next[event.name];
  channel.state.pendingAuthMessageIds = next;
  if (event.outcome === "authorized")
    await safeStartTyping(channel.thread, "Connected. Resuming...");
}

/**
 * Shows `markdown` to `userId` alone: natively where the adapter can, else in a
 * DM. False when the adapter can do neither or the send fails.
 */
async function postPrivately(thread: Thread, userId: string, markdown: string): Promise<boolean> {
  try {
    return (await thread.postEphemeral(userId, { markdown }, { fallbackToDM: true })) !== null;
  } catch (error) {
    if (!isNotImplemented(error)) {
      logError(log, "failed to deliver sign-in privately", error, { threadId: thread.id });
    }
    return false;
  }
}

async function safeStartTyping(thread: Thread, status: string): Promise<void> {
  try {
    await thread.startTyping(status);
  } catch (error) {
    if (!isNotImplemented(error)) throw error;
  }
}

async function editMessage(thread: Thread, messageId: string, markdown: string): Promise<void> {
  await thread.adapter.editMessage(thread.id, messageId, { markdown });
}

function authorizationDisplayName(name: string, displayName: string | undefined): string {
  if (displayName !== undefined) return displayName;
  if (name.length === 0) return name;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function authorizationPrompt(input: {
  readonly displayName: string;
  readonly instructions?: string;
  readonly url?: string;
  readonly userCode?: string;
}): string {
  return [
    `Authorization required for ${input.displayName}.`,
    input.instructions,
    input.userCode === undefined ? undefined : `Code: ${input.userCode}`,
    input.url,
  ]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join("\n\n");
}

function authorizationCompleted(input: {
  readonly displayName: string;
  readonly outcome: "authorized" | "declined" | "failed" | "timed-out";
  readonly reason?: string;
}): string {
  if (input.outcome === "authorized") return `${input.displayName} connected.`;
  const reason = input.reason === undefined ? "" : ` (${input.reason})`;
  const outcome = input.outcome === "timed-out" ? "timed out" : input.outcome;
  return `${input.displayName} authorization ${outcome}${reason}.`;
}
