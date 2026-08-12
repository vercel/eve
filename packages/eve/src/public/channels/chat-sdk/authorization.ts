import { createLogger } from "#internal/logging.js";
import {
  authorizationDisplayName,
  renderAuthorizationCompleted,
  renderAuthorizationRequired,
} from "#public/channels/authorization-rendering.js";
import type { ChatSdkChannelEvents } from "#public/channels/chat-sdk/chatSdkChannel.js";

const log = createLogger("chat-sdk.authorization");

export const defaultAuthorizationEvents = {
  async "authorization.required"(event, channel, _ctx) {
    const thread = channel.thread;
    if (!thread) return;

    const displayName = authorizationDisplayName(event.name, event.authorization?.displayName);
    const challenge = renderAuthorizationRequired({
      authorization: event.authorization,
      description: event.description,
      linkStyle: "markdown",
      name: event.name,
    });

    if (thread.isDM) {
      await thread.post({ markdown: challenge });
      return;
    }

    await thread.post({ markdown: `Authorization required for ${displayName}.` });
    const author = channel.state.thread?.currentMessage?.author;
    if (!author) {
      log.warn("cannot deliver connection authorization challenge privately without an author", {
        name: event.name,
      });
      return;
    }

    try {
      const delivered = await thread.postEphemeral(
        author,
        { markdown: challenge },
        { fallbackToDM: true },
      );
      if (!delivered) {
        log.warn("adapter cannot deliver connection authorization challenge privately", {
          name: event.name,
        });
      }
    } catch (error) {
      // The public status still explains why the session is blocked when an
      // adapter cannot deliver a private challenge.
      log.warn("failed to deliver connection authorization challenge privately", {
        error,
        name: event.name,
      });
    }
  },

  async "authorization.completed"(event, channel, _ctx) {
    if (!channel.thread) return;
    await channel.thread.post({ markdown: renderAuthorizationCompleted(event) });
  },
} satisfies Pick<ChatSdkChannelEvents, "authorization.required" | "authorization.completed">;
