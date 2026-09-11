import type { Adapter, Chat, SerializedThread, Thread } from "#compiled/chat/index.js";

type ChatSdkAdapters = Record<string, Adapter>;

export function serializeChatSdkReceiveTarget<TAdapters extends ChatSdkAdapters>(
  bot: Chat<TAdapters>,
  target: {
    readonly adapterName?: string;
    readonly thread?: SerializedThread;
    readonly threadId?: string;
  },
): SerializedThread {
  if (target.thread) return target.thread;
  if (!target.threadId) {
    throw new Error("chatSdkChannel().receive requires target.thread or target.threadId.");
  }
  return serializeChatSdkThread(bot, target.threadId, target.adapterName);
}

export function serializeChatSdkThread<TAdapters extends ChatSdkAdapters>(
  bot: Chat<TAdapters>,
  thread: SerializedThread | Thread | string,
  adapterName?: string,
): SerializedThread {
  if (typeof thread === "string") {
    const resolvedAdapterName = adapterName ?? inferAdapterName(thread);
    const adapter = bot.getAdapter(resolvedAdapterName);
    return {
      _type: "chat:Thread",
      adapterName: resolvedAdapterName,
      channelId: adapter.channelIdFromThreadId(thread),
      channelVisibility: adapter.getChannelVisibility?.(thread),
      id: thread,
      isDM: adapter.isDM?.(thread) ?? false,
    };
  }
  if ("_type" in thread && thread._type === "chat:Thread") return thread;
  return thread.toJSON();
}

function inferAdapterName(threadId: string): string {
  const separator = threadId.indexOf(":");
  if (separator <= 0) {
    throw new Error("chatSdkChannel string thread references require options.adapterName.");
  }
  return threadId.slice(0, separator);
}
