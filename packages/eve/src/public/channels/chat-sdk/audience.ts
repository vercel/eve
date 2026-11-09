import type { SerializedThread } from "#compiled/chat/index.js";
import type { ChannelAudience } from "#shared/channel-audience.js";
import type {
  ChatSdkChannelState,
  ChatSdkInstrumentationMetadata,
} from "#public/channels/chat-sdk/chatSdkChannel.js";
import type {
  AudienceContext,
  ConversationSpace,
  ConversationSpaceContext,
} from "#shared/conversation-context.js";

function chatSdkInstrumentationMetadata(
  state: ChatSdkChannelState,
): ChatSdkInstrumentationMetadata {
  return {
    adapterName: state.thread?.adapterName ?? null,
    channelId: state.thread?.channelId ?? null,
    isDM: state.thread?.isDM ?? null,
    threadId: state.thread?.id ?? null,
  };
}

function chatSdkAudience(thread: SerializedThread | null): ChannelAudience {
  if (thread?.isDM === true) return "private";
  if (thread?.channelVisibility === "workspace") return "public";
  if (thread?.channelVisibility === "private" || thread?.channelVisibility === "external") {
    return "private";
  }
  return "unknown";
}

/**
 * Messaging apps whose only shared conversations are group chats with a fixed
 * set of members, not channels people join.
 */
const GROUP_CHAT_ADAPTERS = new Set(["imessage", "linq", "whatsapp"]);

/** The Chat SDK channel a thread is in, namespaced by its adapter. */
function chatSdkSpace(thread: SerializedThread | null): ConversationSpace | undefined {
  if (!thread?.channelId) return undefined;
  const prefix = `${thread.adapterName}:`;
  const id = thread.channelId.startsWith(prefix) ? thread.channelId : prefix + thread.channelId;
  if (thread.isDM) return { id, type: "direct" };
  return { id, type: GROUP_CHAT_ADAPTERS.has(thread.adapterName) ? "group" : "channel" };
}

export const chatSdkInstrumentation = {
  audience: (input: AudienceContext<ChatSdkChannelState>) => chatSdkAudience(input.state.thread),
  space: (input: ConversationSpaceContext<ChatSdkChannelState>) =>
    input.state.spaceUnknown === true ? undefined : chatSdkSpace(input.state.thread),
  metadata: chatSdkInstrumentationMetadata,
} as const;
