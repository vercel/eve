import {
  readSlackConversation,
  type SlackConversation,
  type SlackConversationInput,
  type SlackUnavailable,
} from "./slack-api.js";
import type { SlackTurn } from "./turn.js";

/**
 * Reads with the bot token, and retries a public channel the bot isn't in with the caller's user
 * token when the mount allows it.
 */
export async function executeRead(
  input: SlackConversationInput,
  turn: SlackTurn,
): Promise<SlackConversation | SlackUnavailable> {
  const options = {
    workspace: turn.teamId ?? "default",
    authorize: (channelId: string) => turn.authorize({ tool: "read_conversation", channelId }),
  };
  const conversation = await readSlackConversation(turn.request, input, options);
  if (!("unavailable" in conversation) || conversation.reason !== "not_in_channel") {
    return conversation;
  }
  const userRequest = await turn.userRequest();
  if (!userRequest) return conversation;
  return readSlackConversation(userRequest, input, { ...options, userToken: true });
}
