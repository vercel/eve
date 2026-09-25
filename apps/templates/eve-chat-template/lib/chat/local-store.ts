"use client";

import type { ClientSessionState, MessageStreamEvent } from "eve/client";
import { createFallbackTitle, DEFAULT_CHAT_TITLE } from "@/lib/chat/title";
import type { ActiveChat, ChatListItem } from "@/lib/chat/types";

const STORAGE_KEY = "eve-chat-template:chats";
const STORAGE_VERSION = 1;
const MAX_STORED_CHATS = 50;

type StoredChat = ActiveChat & {
  readonly updatedAt: string;
};

type StoredChatState = {
  readonly chats: readonly StoredChat[];
  readonly version: typeof STORAGE_VERSION;
};

export function listLocalChats(): ChatListItem[] {
  return readState().chats.map(toListItem);
}

export function getLocalChat(chatId: string): ActiveChat | null {
  const chat = readState().chats.find((item) => item.id === chatId);

  return chat ? toActiveChat(chat) : null;
}

export function createLocalChat(pendingUserMessage?: string) {
  const pendingMessage = pendingUserMessage?.trim() || null;
  const now = new Date().toISOString();
  const chat: StoredChat = {
    events: [],
    id: crypto.randomUUID(),
    pendingUserMessage: pendingMessage,
    session: undefined,
    title: pendingMessage ? createFallbackTitle(pendingMessage) : DEFAULT_CHAT_TITLE,
    updatedAt: now,
  };

  updateState((chats) => [chat, ...chats]);

  return toListItem(chat);
}

export function deleteLocalChat(chatId: string) {
  updateState((chats) => chats.filter((chat) => chat.id !== chatId));
}

export function markLocalChatPendingMessage(chatId: string, message: string) {
  const pendingMessage = message.trim();

  if (!pendingMessage) {
    throw new Error("Message cannot be empty.");
  }

  return updateChat(chatId, (chat) => ({
    ...chat,
    pendingUserMessage: pendingMessage,
    title: chat.title === DEFAULT_CHAT_TITLE ? createFallbackTitle(pendingMessage) : chat.title,
    updatedAt: new Date().toISOString(),
  }));
}

export function clearLocalChatPendingMessage(chatId: string) {
  updateChat(chatId, (chat) => ({
    ...chat,
    pendingUserMessage: null,
  }));
}

export function appendLocalChatEvent({
  chatId,
  event,
  eventIndex,
}: {
  readonly chatId: string;
  readonly event: MessageStreamEvent;
  readonly eventIndex: number;
}) {
  updateChat(chatId, (chat) => {
    const events = [...chat.events];

    if (eventIndex >= events.length) {
      events.push(event);
    } else {
      events[eventIndex] = event;
    }

    return { ...chat, events };
  });
}

export function saveLocalChatSession(chatId: string, session: ClientSessionState) {
  updateChat(chatId, (chat) => ({ ...chat, session }));
}

export function saveLocalChatSnapshot({
  chatId,
  events,
  session,
}: {
  readonly chatId: string;
  readonly events: readonly MessageStreamEvent[];
  readonly session: ClientSessionState | undefined;
}) {
  updateChat(chatId, (chat) => ({
    ...chat,
    events,
    pendingUserMessage: null,
    session,
    updatedAt: new Date().toISOString(),
  }));
}

export function skipLocalChatAuthorization({
  chatId,
  events,
  session,
}: {
  readonly chatId: string;
  readonly events: readonly MessageStreamEvent[];
  readonly session: ClientSessionState | undefined;
}) {
  const chat = updateChat(chatId, (current) => ({
    ...current,
    events: [...current.events, ...events],
    pendingUserMessage: null,
    session,
    updatedAt: new Date().toISOString(),
  }));

  return {
    chat: toListItem(chat),
    eventCount: events.length,
    eventIndex: chat.events.length - events.length,
  };
}

function updateChat(chatId: string, update: (chat: StoredChat) => StoredChat) {
  const currentChat = readState().chats.find((chat) => chat.id === chatId);

  if (!currentChat) {
    throw new Error("Chat not found.");
  }

  const updatedChat = update(currentChat);

  updateState((chats) => chats.map((chat) => (chat.id === chatId ? updatedChat : chat)));

  return updatedChat;
}

function updateState(update: (chats: readonly StoredChat[]) => readonly StoredChat[]) {
  const nextChats = [...update(readState().chats)]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_STORED_CHATS);

  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ chats: nextChats, version: STORAGE_VERSION } satisfies StoredChatState),
    );
  } catch {
    throw new Error("Browser storage is full. Delete an older chat and try again.");
  }
}

function readState(): StoredChatState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);

    if (!raw) {
      return emptyState();
    }

    const parsed = JSON.parse(raw) as Partial<StoredChatState>;

    if (parsed.version !== STORAGE_VERSION || !Array.isArray(parsed.chats)) {
      return emptyState();
    }

    const chats = parsed.chats.filter(isStoredChat);

    return { chats, version: STORAGE_VERSION };
  } catch {
    return emptyState();
  }
}

function isStoredChat(value: unknown): value is StoredChat {
  if (!value || typeof value !== "object") {
    return false;
  }

  const chat = value as Partial<StoredChat>;

  return (
    typeof chat.id === "string" &&
    typeof chat.title === "string" &&
    typeof chat.updatedAt === "string" &&
    Array.isArray(chat.events)
  );
}

function toActiveChat(chat: StoredChat): ActiveChat {
  return {
    events: chat.events,
    id: chat.id,
    pendingUserMessage: chat.pendingUserMessage ?? null,
    session: chat.session,
    title: chat.title,
  };
}

function toListItem(chat: StoredChat): ChatListItem {
  return {
    id: chat.id,
    title: chat.title,
    updatedAt: chat.updatedAt,
  };
}

function emptyState(): StoredChatState {
  return { chats: [], version: STORAGE_VERSION };
}
