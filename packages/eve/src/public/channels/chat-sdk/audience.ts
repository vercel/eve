import type { SerializedThread } from "#compiled/chat/index.js";
import { normalizeChannelAudience, type ChannelAudience } from "#shared/channel-audience.js";
import type {
  ChatSdkChannelState,
  ChatSdkInstrumentationMetadata,
} from "#public/channels/chat-sdk/chatSdkChannel.js";

export function chatSdkInstrumentationMetadata(
  state: ChatSdkChannelState,
): ChatSdkInstrumentationMetadata {
  return {
    adapterName: state.thread?.adapterName ?? null,
    audience: chatSdkAudience(state.thread, state.audience),
    channelId: state.thread?.channelId ?? null,
    isDM: state.thread?.isDM ?? null,
    threadId: state.thread?.id ?? null,
  };
}

export function combineChatSdkAudienceEvidence(
  defaultAudience: ChannelAudience | undefined,
  operationAudience: ChannelAudience | undefined,
): ChannelAudience {
  const defaultValue = normalizeChannelAudience(defaultAudience);
  const operationValue = normalizeChannelAudience(operationAudience);
  if (defaultValue === "private" || operationValue === "private") return "private";
  return operationAudience === undefined ? defaultValue : operationValue;
}

function chatSdkAudience(
  thread: SerializedThread | null,
  explicitAudience: ChannelAudience | undefined,
): ChannelAudience {
  if (thread?.isDM === true) return "private";
  if (thread?.channelVisibility === "private" || thread?.channelVisibility === "external") {
    return "private";
  }
  if (explicitAudience !== undefined) return normalizeChannelAudience(explicitAudience);
  if (thread?.channelVisibility === "workspace") return "public";
  return "unknown";
}
