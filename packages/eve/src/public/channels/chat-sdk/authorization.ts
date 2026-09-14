import type { Thread } from "#compiled/chat/index.js";
import { isNotImplemented } from "#public/channels/chat-sdk/notImplemented.js";
import type { ChatSdkChannelEvents } from "#public/channels/chat-sdk/chatSdkChannel.js";

/** Built-in connection authorization handlers for Chat SDK threads. */
export function defaultAuthorizationEvents(): Pick<
  ChatSdkChannelEvents,
  "authorization.completed" | "authorization.required"
> {
  return {
    async "authorization.required"(event, channel, _ctx) {
      if (!channel.thread || event.candidateId !== undefined) return;
      const pending = channel.state.pendingAuthMessageIds ?? {};
      if (pending[event.name] !== undefined) return;

      const displayName = authorizationDisplayName(event.name, event.authorization?.displayName);
      const message = channel.thread.isDM
        ? authorizationPrompt({
            displayName,
            instructions: event.authorization?.instructions,
            url: event.authorization?.url,
            userCode: event.authorization?.userCode,
          })
        : `Authorization required for ${displayName}. Continue in a direct message with this agent.`;
      const posted = await channel.thread.post({ markdown: message });
      if (posted.id) {
        channel.state.pendingAuthMessageIds = { ...pending, [event.name]: posted.id };
      }
    },

    async "authorization.completed"(event, channel, _ctx) {
      if (!channel.thread || event.candidateId !== undefined) return;
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
    },
  };
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
