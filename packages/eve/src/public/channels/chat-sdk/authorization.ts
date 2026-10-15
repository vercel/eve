import { postedIn, signInChallengeText, type SignInSurface } from "#channel/sign-in.js";
import type { Thread } from "#compiled/chat/index.js";
import { createLogger, logError } from "#internal/logging.js";
import { isNotImplemented } from "#public/channels/chat-sdk/notImplemented.js";
import type { ChatSdkChannelEvents } from "#public/channels/chat-sdk/chatSdkChannel.js";

const log = createLogger("chat-sdk.authorization");

type SignInChannel = Parameters<
  NonNullable<ChatSdkChannelEvents["interaction.opened"]>
>[1]["channel"];

/** A Chat SDK thread as a sign-in shows on it: a DM is private; elsewhere the challenge goes to the person alone. */
export function chatSdkSignIns(channel: SignInChannel): SignInSurface | undefined {
  const { thread } = channel;
  if (!thread) return undefined;
  const post = async (markdown: string) => (await thread.post({ markdown })).id || undefined;
  return {
    private: thread.isDM,
    postChallenge: (signIn) => post(signInChallengeText(signIn)),
    async deliverPrivately(signIn) {
      const userId =
        signIn.principalId === undefined
          ? undefined
          : channel.state.usersByPrincipal?.[signIn.principalId];
      return (
        typeof userId === "string" && postPrivately(thread, userId, signInChallengeText(signIn))
      );
    },
    post,
    async edit(messageId, markdown) {
      try {
        await thread.adapter.editMessage(thread.id, messageId, { markdown });
      } catch (error) {
        if (!isNotImplemented(error)) throw error;
        channel.state.editSupported = false;
        await thread.post({ markdown });
      }
    },
    async typing(status) {
      try {
        await thread.startTyping(status);
      } catch (error) {
        if (!isNotImplemented(error)) throw error;
      }
    },
    posted: postedIn(channel.state, "pendingAuthMessageIds"),
  };
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
