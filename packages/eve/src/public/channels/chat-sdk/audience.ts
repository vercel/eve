import type { SerializedThread } from "#compiled/chat/index.js";
import type { ChannelAudience } from "#shared/channel-audience.js";
import type {
  ChatSdkChannelState,
  ChatSdkInstrumentationMetadata,
} from "#public/channels/chat-sdk/chatSdkChannel.js";
import type { AudienceInput } from "#shared/conversation-context.js";

export function chatSdkInstrumentationMetadata(
  state: ChatSdkChannelState,
): ChatSdkInstrumentationMetadata {
  return {
    adapterName: state.thread?.adapterName ?? null,
    channelId: state.thread?.channelId ?? null,
    isDM: state.thread?.isDM ?? null,
    threadId: state.thread?.id ?? null,
  };
}

export function chatSdkAudience(thread: SerializedThread | null): ChannelAudience {
  if (thread?.isDM === true) return "private";
  if (thread?.channelVisibility === "workspace") return "public";
  if (thread?.channelVisibility === "private" || thread?.channelVisibility === "external") {
    return "private";
  }
  return "unknown";
}

export const chatSdkInstrumentation = {
  audience: (input: AudienceInput<ChatSdkChannelState>) => chatSdkAudience(input.state.thread),
  metadata: chatSdkInstrumentationMetadata,
} as const;
