"use client";

import { Client } from "eve/client";
import type {
  AuthorizationRequiredStreamEvent,
  ClientSession,
  ClientSessionState,
  EveAgentStoreSnapshot,
  EveMessageData,
  MessageStreamEvent,
  RespondTurnOptions,
  SendTurnInput,
  SendTurnOptions,
} from "eve/client";
import type { EveMessage } from "eve/react";
import { defaultMessageReducer, useEveAgent } from "eve/react";
import {
  AlertCircleIcon,
  ChevronDownIcon,
  ExternalLinkIcon,
  LockIcon,
  PlugIcon,
  XIcon,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useChatShell, type EnabledConnections } from "@/app/_components/chat-shell-context";
import {
  ChatConversation,
  ChatConversationContent,
  ChatScrollButton,
} from "@/components/chat/conversation";
import { IntegrationsMenu } from "@/components/chat/integrations-menu";
import { AgentMessage } from "@/components/chat/message";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { isChatTurnSettledEvent } from "@/lib/chat/events";
import { getChatMessageLengthError } from "@/lib/chat/limits";
import {
  appendClientChatEvent,
  checkClientSendLimit,
  clearClientChatPendingMessage,
  createClientChat,
  markClientChatPendingMessage,
  saveClientChatSession,
  saveClientChatSnapshot,
  skipClientChatAuthorization,
} from "@/lib/chat/persistence-client";
import type { ActiveChat, SetupStatus, Viewer } from "@/lib/chat/types";
import { cn } from "@/lib/utils";

type AgentSnapshot = EveAgentStoreSnapshot<EveMessageData>;

export type DraftHandlers = {
  readonly clearDraft: () => void;
  readonly restoreDraft: (value: string) => void;
};

export type AgentChatController = {
  readonly reset: () => void;
  readonly sendMessage: (text: string, draftHandlers: DraftHandlers) => Promise<void>;
  readonly stop: () => void;
};

export type AgentChatControllerStatus = {
  readonly disabledReason?: string;
  readonly isBusy: boolean;
  readonly isDisabled: boolean;
  readonly isEmpty: boolean;
};

const IDLE_CONTROLLER_STATUS: AgentChatControllerStatus = {
  isBusy: false,
  isDisabled: false,
  isEmpty: true,
};

const THINKING_EXIT_DURATION_MS = 180;

function advanceBrowserSession({
  baseStreamIndex,
  events,
  sessionId,
}: {
  readonly baseStreamIndex: number;
  readonly events: readonly MessageStreamEvent[];
  readonly sessionId: string;
}): ClientSessionState | undefined {
  const boundary = findBoundaryEvent(events);

  if (boundary?.type === "session.waiting") {
    return {
      sessionId,
      streamIndex: baseStreamIndex + events.length,
    };
  }

  const lastEvent = events.at(-1);

  if (lastEvent?.type === "authorization.required") {
    return {
      sessionId,
      streamIndex: baseStreamIndex + events.length,
    };
  }

  return undefined;
}

function findBoundaryEvent(events: readonly MessageStreamEvent[]) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];

    if (event && isChatTurnSettledEvent(event)) {
      return event;
    }
  }
}

function attachClientSession(session: ClientSessionState | undefined): ClientSession | null {
  if (!session) return null;
  return new Client({ host: "" }).sessions.attach(session.sessionId, {
    streamIndex: session.streamIndex,
  });
}

function reduceEventsToMessageData(events: readonly MessageStreamEvent[]): EveMessageData {
  const reducer = defaultMessageReducer();
  let data = reducer.initial();

  for (const event of events) {
    data = reducer.reduce(data, event);
  }

  return data;
}

function hasOpenChatTurn(events: readonly MessageStreamEvent[]) {
  let open = false;

  for (const event of events) {
    if (event.type === "turn.started") {
      open = true;
    } else if (isChatTurnSettledEvent(event)) {
      open = false;
    }
  }

  return open;
}

function namespaceStreamEvent(
  event: MessageStreamEvent,
  namespace: string | undefined,
): MessageStreamEvent {
  if (!namespace) {
    return event;
  }

  if (!("data" in event) || typeof event.data !== "object" || !event.data) {
    return event;
  }

  const turnId =
    "turnId" in event.data && typeof event.data.turnId === "string" ? event.data.turnId : undefined;

  if (!turnId) {
    return event;
  }

  const prefix = `${namespace}:`;

  if (turnId.startsWith(prefix)) {
    return event;
  }

  return {
    ...event,
    data: {
      ...event.data,
      turnId: `${prefix}${turnId}`,
    },
  } as MessageStreamEvent;
}

function isSnapshotForCurrentSession(
  snapshotSession: ClientSessionState | undefined,
  currentSession: ClientSessionState | undefined,
) {
  if (!snapshotSession) {
    return true;
  }

  return snapshotSession.sessionId === currentSession?.sessionId;
}

function isAbortError(error: unknown) {
  return error instanceof Error && error.name === "AbortError";
}

function isStreamDisconnectError(error: unknown) {
  if (isAbortError(error)) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const code = "code" in error && typeof error.code === "string" ? error.code : undefined;

  return (
    error.name === "AbortError" ||
    error.message === "terminated" ||
    code === "UND_ERR_SOCKET" ||
    /abort|cancel|disconnect|premature close|socket|terminated/i.test(error.message)
  );
}

async function readResponseError(response: Response) {
  return formatResponseError(response.status, await response.text());
}

function formatResponseError(status: number, body: string) {
  if (body.length > 0) {
    try {
      const parsed = JSON.parse(body) as { readonly error?: unknown };

      if (typeof parsed.error === "string") {
        return parsed.error;
      }
    } catch {}

    return body;
  }

  return `Server returned ${status}.`;
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function AgentChatSession({
  activeChat,
  chatId,
  emptyComposer,
  onActiveChatUpdated,
  onPendingUserMessageSettled,
  onControllerChange,
  pendingUserMessage,
}: {
  readonly activeChat: ActiveChat | null;
  readonly chatId?: string | null;
  readonly emptyComposer?: ReactNode;
  readonly onActiveChatUpdated?: (activeChat: ActiveChat) => void;
  readonly onPendingUserMessageSettled?: (message?: string) => void;
  readonly onControllerChange: (
    controller: AgentChatController | null,
    status: AgentChatControllerStatus,
  ) => void;
  readonly pendingUserMessage?: string | null;
}) {
  const {
    activeChatId: shellActiveChatId,
    enabledConnections,
    requestSignIn,
    setActiveChatId: setShellActiveChatId,
    setupStatus,
    touchChat,
    viewer,
  } = useChatShell();
  const [activeChatId, setActiveChatId] = useState(activeChat?.id ?? chatId ?? null);
  const [currentTitle, setCurrentTitle] = useState(activeChat?.title ?? "New chat");
  const [clientError, setClientError] = useState<string | null>(null);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [resumedEvents, setResumedEvents] = useState<MessageStreamEvent[]>([]);
  const [isResuming, setIsResuming] = useState(false);
  const [isFinalizingTurn, setIsFinalizingTurn] = useState(false);
  const [streamEvents, setStreamEvents] = useState<MessageStreamEvent[]>([]);
  const [localEvents, setLocalEvents] = useState<MessageStreamEvent[]>([]);
  const {
    clearMessage: clearLocalPendingUserMessage,
    message: localPendingUserMessage,
    messageRef: localPendingUserMessageRef,
    setMessage: setLocalPendingUserMessage,
  } = usePendingUserMessage();
  const [skippingAuthorizationKey, setSkippingAuthorizationKey] = useState<string | null>(null);
  const activeChatIdRef = useRef(activeChat?.id ?? chatId ?? null);
  const eventIndexRef = useRef(activeChat?.events.length ?? 0);
  const eventIndexChatIdRef = useRef(activeChat?.id ?? chatId ?? null);
  const knownInitialEventsRef = useRef<readonly MessageStreamEvent[]>(activeChat?.events ?? []);
  const currentTitleRef = useRef(activeChat?.title ?? "New chat");
  const resumeStartedRef = useRef(false);
  const resumedEventsRef = useRef<MessageStreamEvent[]>([]);
  const streamEventsRef = useRef<MessageStreamEvent[]>([]);
  const localEventsRef = useRef<MessageStreamEvent[]>([]);
  const persistedSessionRef = useRef<ClientSession | null>(
    attachClientSession(activeChat?.session),
  );
  const isSetupReady = setupStatus.appReady;
  const storageMode = setupStatus.storageMode;
  const router = useRouter();

  const startFinalizingTurn = useCallback(() => {
    setIsFinalizingTurn(true);
  }, []);

  const stopFinalizingTurn = useCallback(() => {
    setIsFinalizingTurn(false);
  }, []);

  const finishFinalizingTurn = useCallback(() => {
    setIsFinalizingTurn(false);
  }, []);

  const persistSnapshot = useCallback(
    async (snapshot: AgentSnapshot) => {
      const chatId = activeChatIdRef.current;

      if (!viewer || !chatId) {
        stopFinalizingTurn();
        return;
      }

      setClientError(null);

      try {
        if (!isSnapshotForCurrentSession(snapshot.session, persistedSessionRef.current?.state)) {
          stopFinalizingTurn();
          return;
        }

        const snapshotEvents =
          streamEventsRef.current.length > 0
            ? mergeStreamEventLogs(knownInitialEventsRef.current, streamEventsRef.current)
            : preserveKnownInitialEvents(snapshot.events, knownInitialEventsRef.current);
        const events = mergeLocalEvents(snapshotEvents, localEventsRef.current);

        const session = advanceSessionWithLocalEvents(snapshot.session, localEventsRef.current);

        await saveClientChatSnapshot(storageMode, {
          chatId,
          events,
          session,
        });
        eventIndexRef.current = events.length;
        knownInitialEventsRef.current = events;
        streamEventsRef.current = [];
        setStreamEvents([]);
        touchChat({
          id: chatId,
          title: currentTitleRef.current,
          updatedAt: new Date().toISOString(),
        });
        onActiveChatUpdated?.({
          events,
          id: chatId,
          pendingUserMessage: null,
          session,
          title: currentTitleRef.current,
        });
        onPendingUserMessageSettled?.();
      } catch (error) {
        setClientError(error instanceof Error ? error.message : "Failed to save chat.");
      } finally {
        finishFinalizingTurn();
      }
    },
    [
      finishFinalizingTurn,
      onActiveChatUpdated,
      onPendingUserMessageSettled,
      stopFinalizingTurn,
      touchChat,
      storageMode,
      viewer,
    ],
  );

  const persistStreamEvent = useCallback(
    (event: MessageStreamEvent) => {
      const displayEvent = namespaceStreamEvent(
        event,
        persistedSessionRef.current?.state?.sessionId,
      );
      const nextStreamEvents = appendUniqueStreamEvent(streamEventsRef.current, displayEvent);

      if (nextStreamEvents !== streamEventsRef.current) {
        streamEventsRef.current = nextStreamEvents;
        setStreamEvents(nextStreamEvents);
      }

      if (displayEvent.type === "authorization.required") {
        stopFinalizingTurn();
      }

      const chatId = activeChatIdRef.current;

      if (!viewer || !chatId) {
        return;
      }

      const eventIndex = eventIndexRef.current;
      eventIndexRef.current += 1;

      void appendClientChatEvent(storageMode, {
        chatId,
        event: displayEvent,
        eventIndex,
      }).catch((error) => {
        setClientError(error instanceof Error ? error.message : "Failed to save stream progress.");
      });
    },
    [stopFinalizingTurn, storageMode, viewer],
  );

  const persistSessionState = useCallback(
    async (session: ClientSessionState) => {
      const chatId = activeChatIdRef.current;

      if (!viewer || !chatId || !session.sessionId) {
        return;
      }

      try {
        await saveClientChatSession(storageMode, {
          chatId,
          session,
        });
      } catch (error) {
        setClientError(error instanceof Error ? error.message : "Failed to save session state.");
      }
    },
    [storageMode, viewer],
  );

  const agent = useEveAgent({
    initialEvents: activeChat?.events ?? [],
    initialSession: activeChat?.session,
    onEvent: persistStreamEvent,
    onSessionChange(session) {
      persistedSessionRef.current = attachClientSession(session);
      if (session) void persistSessionState(session);
    },
    onFinish: (snapshot) => {
      void persistSnapshot(snapshot);
    },
  });

  const hasResumeOverlay = isResuming || (resumedEvents.length > 0 && streamEvents.length === 0);
  const resumedEventLog = useMemo(
    () => [...(activeChat?.events ?? []), ...resumedEvents],
    [activeChat?.events, resumedEvents],
  );
  const agentEventLog = useMemo(
    () => mergeStreamEventLogs(activeChat?.events ?? [], streamEvents),
    [activeChat?.events, streamEvents],
  );
  const baseDisplayEvents = hasResumeOverlay ? resumedEventLog : agentEventLog;
  const displayEvents = useMemo(
    () => mergeLocalEvents(baseDisplayEvents, localEvents),
    [baseDisplayEvents, localEvents],
  );
  const displayData = useMemo(() => reduceEventsToMessageData(displayEvents), [displayEvents]);
  const displayMessages = displayData.messages;
  const displayChatId = chatId ?? activeChatId ?? "new";
  const hasLocalPendingUserMessage = Boolean(localPendingUserMessage);
  const pendingAuthorizations = getPendingAuthorizations(displayEvents);
  const isWaitingForAuthorization = pendingAuthorizations.length > 0;
  const hasOpenTurn = useMemo(() => hasOpenChatTurn(displayEvents), [displayEvents]);
  const isBusy =
    isResuming ||
    hasLocalPendingUserMessage ||
    (!isWaitingForAuthorization &&
      (hasOpenTurn || agent.status === "submitted" || agent.status === "streaming"));
  const isTurnBlocked = isBusy || isFinalizingTurn;
  const pendingMessage = pendingUserMessage
    ? createPendingUserMessage(displayChatId, pendingUserMessage)
    : null;
  const localPendingMessage = localPendingUserMessage
    ? createPendingUserMessage(displayChatId, localPendingUserMessage, "local-pending-user-message")
    : null;
  const disabledReason = isWaitingForAuthorization
    ? getConnectionAuthorizationDisabledReason(pendingAuthorizations)
    : isFinalizingTurn
      ? "Finishing response."
      : undefined;
  const visibleMessages = appendPendingUserMessages(displayMessages, [
    pendingMessage,
    localPendingMessage,
  ]);
  const isEmpty = visibleMessages.length === 0 && !isTurnBlocked && !isWaitingForAuthorization;
  const isChatRoute = Boolean(shellActiveChatId || chatId);
  const showThinking =
    !isWaitingForAuthorization &&
    (Boolean(pendingMessage || localPendingMessage) || hasOpenTurn || isTurnBlocked);
  const thinkingPresence = useThinkingPresence(showThinking);
  const displayError = clientError ?? agent.error?.message ?? null;
  const toastError = displayError && dismissedError !== displayError ? displayError : null;

  const resetSession = useCallback(() => {
    persistedSessionRef.current = null;
    agent.reset();
    setActiveChatId(null);
    activeChatIdRef.current = null;
    eventIndexRef.current = 0;
    eventIndexChatIdRef.current = null;
    knownInitialEventsRef.current = [];
    setCurrentTitle("New chat");
    currentTitleRef.current = "New chat";
    resumeStartedRef.current = false;
    resumedEventsRef.current = [];
    streamEventsRef.current = [];
    localEventsRef.current = [];
    setResumedEvents([]);
    setStreamEvents([]);
    setLocalEvents([]);
    stopFinalizingTurn();
    clearLocalPendingUserMessage();
    setIsResuming(false);
    setClientError(null);
  }, [agent, clearLocalPendingUserMessage, stopFinalizingTurn]);

  const prepareSend = useCallback(
    async (firstMessage: string) => {
      const limit = await checkClientSendLimit(storageMode, { message: firstMessage });

      if (!limit.allowed) {
        setClientError(`${limit.message} Retry in ${limit.retryAfter}s.`);
        return false;
      }

      if (!activeChatIdRef.current) {
        const created = await createClientChat(storageMode, {
          pendingUserMessage: firstMessage,
        });

        touchChat(created);
        setActiveChatId(created.id);
        setShellActiveChatId(created.id);
        activeChatIdRef.current = created.id;
        eventIndexChatIdRef.current = created.id;
        eventIndexRef.current = 0;
        knownInitialEventsRef.current = [];
        setCurrentTitle(created.title);
        currentTitleRef.current = created.title;
        router.replace(`/chat/${created.id}`, { scroll: false });
      }

      return true;
    },
    [router, setShellActiveChatId, storageMode, touchChat],
  );

  const sendMessage = useCallback(
    async (text: string, draftHandlers: DraftHandlers) => {
      const message = text.trim();

      if (!message || isTurnBlocked || localPendingUserMessageRef.current) {
        return;
      }

      const lengthError = getChatMessageLengthError(message);

      if (lengthError) {
        setClientError(lengthError);
        return;
      }

      if (isWaitingForAuthorization) {
        draftHandlers.restoreDraft(message);
        setClientError(disabledReason ?? "Connect the requested service before continuing.");
        return;
      }

      const showLocalPendingMessage = () => {
        setLocalPendingUserMessage(message);
        draftHandlers.clearDraft();
      };
      const restoreAfterFailedSend = (errorMessage?: string) => {
        clearLocalPendingUserMessage();
        draftHandlers.restoreDraft(message);

        if (errorMessage) {
          setClientError(errorMessage);
        }
      };
      let ready = false;

      setClientError(null);

      if (!isSetupReady) {
        setClientError("Finish setup before chatting.");
        return;
      }

      if (!viewer) {
        requestSignIn(message);
        return;
      }

      resumedEventsRef.current = [];
      setResumedEvents([]);
      setIsResuming(false);
      showLocalPendingMessage();
      onPendingUserMessageSettled?.(message);

      try {
        ready = await prepareSend(message);
      } catch (error) {
        restoreAfterFailedSend(error instanceof Error ? error.message : "Failed to prepare chat.");
        return;
      }

      if (!ready) {
        const chatId = activeChatIdRef.current;

        if (chatId) {
          void clearClientChatPendingMessage(storageMode, chatId);
        }
        restoreAfterFailedSend();
        return;
      }

      const chatId = activeChatIdRef.current;

      if (!chatId) {
        restoreAfterFailedSend("Chat is still getting ready.");
        return;
      }

      try {
        const updated = await markClientChatPendingMessage(storageMode, {
          chatId,
          message,
        });
        touchChat(updated);
      } catch (error) {
        restoreAfterFailedSend(
          error instanceof Error ? error.message : "Failed to save pending message.",
        );
        return;
      }

      try {
        startFinalizingTurn();
        await agent.send(message, {
          clientContext: createConnectionClientContext(
            enabledConnections,
            setupStatus.connectionsAvailable,
          ),
        });
      } catch (error) {
        if (isAbortError(error)) {
          return;
        }

        stopFinalizingTurn();
        void clearClientChatPendingMessage(storageMode, chatId);
        restoreAfterFailedSend(error instanceof Error ? error.message : "Failed to send message.");
      }
    },
    [
      agent,
      clearLocalPendingUserMessage,
      disabledReason,
      enabledConnections,
      isSetupReady,
      isTurnBlocked,
      isWaitingForAuthorization,
      prepareSend,
      requestSignIn,
      setLocalPendingUserMessage,
      setupStatus.connectionsAvailable,
      startFinalizingTurn,
      storageMode,
      stopFinalizingTurn,
      onPendingUserMessageSettled,
      touchChat,
      viewer,
    ],
  );

  const handleInputResponses = useCallback(
    async (
      responses: readonly {
        readonly optionId?: string;
        readonly requestId: string;
        readonly text?: string;
      }[],
    ) => {
      if (isTurnBlocked) {
        return;
      }

      if (!viewer) {
        requestSignIn();
        return;
      }

      if (!activeChatIdRef.current) {
        setClientError("Start a chat before responding.");
        return;
      }

      const limit = await checkClientSendLimit(storageMode);

      if (!limit.allowed) {
        setClientError(`${limit.message} Retry in ${limit.retryAfter}s.`);
        return;
      }

      try {
        startFinalizingTurn();
        await agent.respond(responses);
      } catch (error) {
        stopFinalizingTurn();
        setClientError(error instanceof Error ? error.message : "Failed to send response.");
      }
    },
    [
      agent,
      isTurnBlocked,
      requestSignIn,
      startFinalizingTurn,
      stopFinalizingTurn,
      storageMode,
      viewer,
    ],
  );

  const handleSkipAuthorization = useCallback(
    async (authorization: PendingConnectionAuthorization) => {
      const chatId = activeChatIdRef.current;

      if (!viewer) {
        requestSignIn();
        return;
      }

      if (!chatId) {
        setClientError("Start a chat before skipping authorization.");
        return;
      }

      const persistedSession = persistedSessionRef.current;
      const sessionId = persistedSession?.state?.sessionId;

      if (!persistedSession || !sessionId) {
        setClientError("Session is not ready to skip authorization.");
        return;
      }

      const events = createAuthorizationDeclinedEvents(authorization, sessionId);
      const previousSession = persistedSession.state;
      const nextSession = undefined;

      agent.reset();
      persistedSessionRef.current = null;

      const nextLocalEvents = mergeLocalEvents(localEventsRef.current, events);

      localEventsRef.current = nextLocalEvents;
      setLocalEvents(nextLocalEvents);
      setSkippingAuthorizationKey(authorization.key);
      setClientError(null);

      try {
        const result = await skipClientChatAuthorization(storageMode, {
          chatId,
          events,
          session: nextSession,
        });
        const skippedEvents = mergeLocalEvents(displayEvents, events);

        eventIndexRef.current = Math.max(
          eventIndexRef.current,
          result.eventIndex + result.eventCount,
        );
        knownInitialEventsRef.current = skippedEvents;
        const nextStreamEvents = events.reduce<MessageStreamEvent[]>(
          (mergedEvents, event) => appendUniqueStreamEvent(mergedEvents, event),
          streamEventsRef.current,
        );

        streamEventsRef.current = nextStreamEvents;
        setStreamEvents(nextStreamEvents);
        localEventsRef.current = [];
        setLocalEvents([]);
        touchChat(result.chat);
        onActiveChatUpdated?.({
          events: skippedEvents,
          id: chatId,
          pendingUserMessage: null,
          session: nextSession,
          title: currentTitleRef.current,
        });
        onPendingUserMessageSettled?.();
      } catch (error) {
        if (previousSession) {
          persistedSessionRef.current = attachClientSession(previousSession);
        }

        const eventKeys = new Set(events.map(getLocalEventKey).filter(Boolean));
        const revertedEvents = localEventsRef.current.filter((localEvent) => {
          const key = getLocalEventKey(localEvent);

          return !key || !eventKeys.has(key);
        });

        localEventsRef.current = revertedEvents;
        setLocalEvents(revertedEvents);
        setClientError(error instanceof Error ? error.message : "Failed to skip authorization.");
      } finally {
        setSkippingAuthorizationKey(null);
      }
    },
    [
      agent,
      displayEvents,
      onActiveChatUpdated,
      onPendingUserMessageSettled,
      requestSignIn,
      storageMode,
      touchChat,
      viewer,
    ],
  );

  useEffect(() => {
    activeChatIdRef.current = activeChatId;
  }, [activeChatId]);

  useEffect(() => {
    const nextChatId = activeChat?.id ?? chatId ?? null;
    const nextTitle = activeChat?.title ?? "New chat";
    const nextEventIndex = activeChat?.events.length ?? 0;

    setActiveChatId(nextChatId);
    activeChatIdRef.current = nextChatId;
    if (eventIndexChatIdRef.current !== nextChatId) {
      eventIndexChatIdRef.current = nextChatId;
      eventIndexRef.current = nextEventIndex;
      knownInitialEventsRef.current = activeChat?.events ?? [];
      streamEventsRef.current = [];
      localEventsRef.current = [];
      setStreamEvents([]);
      setLocalEvents([]);
      stopFinalizingTurn();
      clearLocalPendingUserMessage();
    } else if (!isTurnBlocked) {
      eventIndexRef.current = Math.max(eventIndexRef.current, nextEventIndex);
      if (activeChat) {
        knownInitialEventsRef.current = activeChat.events;
      }
    }
    setCurrentTitle(nextTitle);
    currentTitleRef.current = nextTitle;
  }, [
    activeChat?.events.length,
    activeChat?.id,
    activeChat?.title,
    chatId,
    clearLocalPendingUserMessage,
    isTurnBlocked,
    stopFinalizingTurn,
  ]);

  useEffect(() => {
    if (
      !viewer ||
      !activeChat?.session?.sessionId ||
      resumeStartedRef.current ||
      agent.status !== "ready"
    ) {
      return;
    }

    const abortController = new AbortController();
    const existingEvents = activeChat.events;
    const pendingMessageText = pendingUserMessage ?? null;
    const shouldResumeOpenTurn = hasOpenChatTurn(existingEvents);

    if (!pendingMessageText && !shouldResumeOpenTurn) {
      return;
    }

    const startIndex = existingEvents.length;
    const session = attachClientSession(activeChat.session);
    if (!session) return;
    let cancelled = false;
    let completed = false;

    resumeStartedRef.current = true;
    resumedEventsRef.current = [];
    setResumedEvents([]);
    setIsResuming(true);
    setClientError(null);

    void (async () => {
      try {
        for await (const event of session.stream({
          signal: abortController.signal,
          startIndex,
        })) {
          if (cancelled) {
            return;
          }

          const displayEvent = namespaceStreamEvent(event, activeChat.session?.sessionId);
          const nextEvents = [...resumedEventsRef.current, displayEvent];
          resumedEventsRef.current = nextEvents;
          setResumedEvents(nextEvents);

          await appendClientChatEvent(storageMode, {
            chatId: activeChat.id,
            event: displayEvent,
            eventIndex: startIndex + nextEvents.length - 1,
          });

          if (isChatTurnSettledEvent(event)) {
            break;
          }
        }

        if (cancelled) {
          return;
        }

        const newEvents = resumedEventsRef.current;
        const allEvents = [...existingEvents, ...newEvents];

        if (!newEvents.some(isChatTurnSettledEvent)) {
          setClientError("Stream disconnected before the response completed.");
          return;
        }

        await saveClientChatSnapshot(storageMode, {
          chatId: activeChat.id,
          events: allEvents,
          session: session.state,
        });
        eventIndexRef.current = allEvents.length;
        knownInitialEventsRef.current = allEvents;
        resumedEventsRef.current = [];
        setResumedEvents([]);
        touchChat({
          id: activeChat.id,
          title: currentTitleRef.current,
          updatedAt: new Date().toISOString(),
        });
        onActiveChatUpdated?.({
          events: allEvents,
          id: activeChat.id,
          pendingUserMessage: null,
          session: session.state,
          title: currentTitleRef.current,
        });

        onPendingUserMessageSettled?.();
        completed = true;
      } catch (error) {
        if (!cancelled && !isAbortError(error)) {
          setClientError(error instanceof Error ? error.message : "Failed to resume stream.");
        }
      } finally {
        if (!cancelled) {
          setIsResuming(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (!completed) {
        resumeStartedRef.current = false;
      }
      abortController.abort();
    };
  }, [
    activeChat?.events,
    activeChat?.id,
    activeChat?.session,
    agent.status,
    onActiveChatUpdated,
    onPendingUserMessageSettled,
    pendingUserMessage,
    persistSessionState,
    storageMode,
    touchChat,
    viewer,
  ]);

  useEffect(() => {
    currentTitleRef.current = currentTitle;
  }, [currentTitle]);

  useEffect(() => {
    setDismissedError(null);
  }, [displayError]);

  useEffect(() => {
    if (localPendingUserMessage && hasLatestUserMessage(displayMessages, localPendingUserMessage)) {
      clearLocalPendingUserMessage();
    }
  }, [clearLocalPendingUserMessage, displayMessages, localPendingUserMessage]);

  useEffect(() => {
    onControllerChange(
      {
        reset: resetSession,
        sendMessage,
        stop: () => void agent.cancel(),
      },
      {
        disabledReason,
        isBusy,
        isDisabled: !isSetupReady || isWaitingForAuthorization || isFinalizingTurn,
        isEmpty,
      },
    );
  }, [
    agent.cancel,
    disabledReason,
    isBusy,
    isFinalizingTurn,
    isEmpty,
    isSetupReady,
    isWaitingForAuthorization,
    onControllerChange,
    resetSession,
    sendMessage,
  ]);

  useEffect(() => {
    return () => {
      onControllerChange(null, IDLE_CONTROLLER_STATUS);
    };
  }, [onControllerChange]);

  return (
    <>
      {toastError ? (
        <ErrorToast message={toastError} onDismiss={() => setDismissedError(toastError)} />
      ) : null}

      {isEmpty && !activeChatId && !isChatRoute && emptyComposer ? (
        <EmptyChatBody composer={emptyComposer} />
      ) : (
        <>
          {isChatRoute ? <SessionHeader /> : null}
          {isEmpty ? (
            <BlankChatBody />
          ) : (
            <ChatConversation>
              <ChatConversationContent>
                {visibleMessages.map((message, index) => (
                  <AgentMessage
                    canRespond={
                      !isTurnBlocked &&
                      !isWaitingForAuthorization &&
                      Boolean(viewer) &&
                      isSetupReady
                    }
                    isStreaming={
                      agent.status === "streaming" && index === visibleMessages.length - 1
                    }
                    key={message.id}
                    message={message}
                    onInputResponses={handleInputResponses}
                  />
                ))}
                {pendingAuthorizations.map((authorization) => (
                  <ConnectionAuthorizationPrompt
                    authorization={authorization}
                    isSkipping={skippingAuthorizationKey === authorization.key}
                    key={authorization.key}
                    onSkip={handleSkipAuthorization}
                  />
                ))}
                {thinkingPresence.shouldRender ? (
                  <ThinkingMessage isVisible={thinkingPresence.isVisible} />
                ) : null}
              </ChatConversationContent>
              <ChatScrollButton />
            </ChatConversation>
          )}
        </>
      )}
    </>
  );
}

type PendingConnectionAuthorization = {
  readonly description: string;
  readonly displayName: string;
  readonly expiresAt?: string;
  readonly instructions?: string;
  readonly key: string;
  readonly name: string;
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
  readonly url?: string;
  readonly authorization?: AuthorizationRequiredStreamEvent["data"]["authorization"];
};

function getPendingAuthorizations(events: readonly MessageStreamEvent[]) {
  const pending = new Map<string, PendingConnectionAuthorization>();

  for (const event of events) {
    if (event.type === "authorization.required") {
      const authorization = toPendingAuthorization(event);
      pending.set(authorization.name, authorization);
      continue;
    }

    if (event.type === "authorization.completed") {
      pending.delete(event.data.name);
    }
  }

  return [...pending.values()];
}

function getConnectionAuthorizationDisabledReason(
  authorizations: readonly PendingConnectionAuthorization[],
) {
  const displayName = authorizations[0]?.displayName ?? "the requested service";

  return `Connect ${displayName} to continue this turn, or skip it.`;
}

function toPendingAuthorization(
  event: AuthorizationRequiredStreamEvent,
): PendingConnectionAuthorization {
  const challenge = event.data.authorization;
  const displayName = challenge?.displayName ?? event.data.name;

  return {
    authorization: challenge,
    description:
      challenge?.instructions ??
      event.data.description ??
      `Connect ${displayName} to let eve continue.`,
    displayName,
    expiresAt: challenge?.expiresAt,
    instructions: challenge?.instructions,
    key: `${event.data.turnId}:${event.data.name}`,
    name: event.data.name,
    sequence: event.data.sequence,
    stepIndex: event.data.stepIndex,
    turnId: event.data.turnId,
    url: challenge?.url,
  };
}

function ConnectionAuthorizationPrompt({
  authorization,
  isSkipping,
  onSkip,
}: {
  readonly authorization: PendingConnectionAuthorization;
  readonly isSkipping: boolean;
  readonly onSkip: (authorization: PendingConnectionAuthorization) => Promise<void>;
}) {
  return (
    <article aria-live="polite" className="flex w-full justify-start px-3">
      <div className="w-full max-w-md rounded-lg border border-border/70 bg-muted/20 p-3 text-sm shadow-sm">
        <div className="flex gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground">
            <PlugIcon className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-medium text-foreground">Connect {authorization.displayName}</p>
            <p className="mt-1 text-muted-foreground">{authorization.description}</p>
            <div className="mt-2.5 flex items-center gap-2">
              {authorization.url ? (
                <Button asChild size="xs" type="button">
                  <a href={authorization.url} rel="noreferrer" target="_blank">
                    Connect
                    <ExternalLinkIcon className="size-3" />
                  </a>
                </Button>
              ) : null}
              <Button
                disabled={isSkipping}
                onClick={() => {
                  void onSkip(authorization);
                }}
                size="xs"
                type="button"
                variant="outline"
              >
                {isSkipping ? "Skipping..." : "Skip"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}

function createAuthorizationDeclinedEvents(
  authorization: PendingConnectionAuthorization,
  sessionId: string,
): readonly MessageStreamEvent[] {
  return [
    {
      data: {
        authorization: authorization.authorization,
        name: authorization.name,
        outcome: "declined",
        reason: "skipped",
        sequence: authorization.sequence,
        stepIndex: authorization.stepIndex,
        turnId: authorization.turnId,
      },
      meta: createLocalEventMeta(),
      type: "authorization.completed",
    },
    createSessionWaitingEvent(sessionId),
  ];
}

function createSessionWaitingEvent(sessionId: string): MessageStreamEvent {
  return {
    data: {
      continuationToken: sessionId,
      wait: "next-user-message",
    },
    meta: createLocalEventMeta(),
    type: "session.waiting",
  };
}

function createLocalEventMeta() {
  return {
    at: new Date().toISOString(),
    id: `local_${crypto.randomUUID()}`,
  };
}

function advanceSessionWithLocalEvents(
  session: ClientSessionState | undefined,
  events: readonly MessageStreamEvent[],
) {
  if (events.length === 0 || !session) {
    return session;
  }

  return advanceBrowserSession({
    baseStreamIndex: session.streamIndex,
    events,
    sessionId: session.sessionId,
  });
}

function mergeLocalEvents(
  events: readonly MessageStreamEvent[],
  localEvents: readonly MessageStreamEvent[],
): MessageStreamEvent[] {
  const merged = [...events];

  if (localEvents.length === 0) {
    return merged;
  }

  const keys = new Set(events.map(getLocalEventKey).filter(Boolean));

  for (const event of localEvents) {
    const key = getLocalEventKey(event);

    if (!key || keys.has(key)) {
      continue;
    }

    keys.add(key);
    merged.push(event);
  }

  return merged;
}

function mergeStreamEventLogs(
  events: readonly MessageStreamEvent[],
  streamedEvents: readonly MessageStreamEvent[],
): MessageStreamEvent[] {
  if (streamedEvents.length === 0) {
    return events as MessageStreamEvent[];
  }

  let merged: MessageStreamEvent[] = [...events];

  for (const event of streamedEvents) {
    const next = appendUniqueStreamEvent(merged, event);

    if (next !== merged) {
      merged = next;
    }
  }

  return merged;
}

function appendUniqueStreamEvent(
  events: readonly MessageStreamEvent[],
  event: MessageStreamEvent,
): MessageStreamEvent[] {
  if (events.some((existingEvent) => areSameStreamEvent(existingEvent, event))) {
    return events as MessageStreamEvent[];
  }

  return [...events, event];
}

function preserveKnownInitialEvents(
  snapshotEvents: readonly MessageStreamEvent[],
  knownEvents: readonly MessageStreamEvent[],
) {
  if (knownEvents.length === 0) {
    return snapshotEvents;
  }

  if (snapshotEvents.length === 0) {
    return knownEvents;
  }

  const sharedPrefixLength = countSharedEventPrefix(snapshotEvents, knownEvents);

  if (sharedPrefixLength === knownEvents.length) {
    return snapshotEvents;
  }

  if (sharedPrefixLength === snapshotEvents.length) {
    return knownEvents;
  }

  if (sharedPrefixLength > 0) {
    return [...knownEvents, ...snapshotEvents.slice(sharedPrefixLength)];
  }

  return [...knownEvents, ...snapshotEvents];
}

function countSharedEventPrefix(
  events: readonly MessageStreamEvent[],
  knownEvents: readonly MessageStreamEvent[],
) {
  const count = Math.min(events.length, knownEvents.length);

  for (let index = 0; index < count; index += 1) {
    if (!areSameStreamEvent(knownEvents[index]!, events[index])) {
      return index;
    }
  }

  return count;
}

function areSameStreamEvent(left: MessageStreamEvent, right: MessageStreamEvent | undefined) {
  return right !== undefined && areEqualJsonValues(left, right);
}

function areEqualJsonValues(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }

  if (typeof left !== typeof right || left === null || right === null) {
    return false;
  }

  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }

    return left.every((item, index) => areEqualJsonValues(item, right[index]));
  }

  if (typeof left !== "object" || typeof right !== "object") {
    return false;
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);

  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  return leftKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(rightRecord, key) &&
      areEqualJsonValues(leftRecord[key], rightRecord[key]),
  );
}

function getLocalEventKey(event: MessageStreamEvent) {
  if (event.type === "authorization.completed") {
    return `${event.type}:${event.data.turnId}:${event.data.name}:${event.data.outcome}:${event.data.reason ?? ""}`;
  }

  if (event.type === "session.waiting") {
    return `${event.type}:${event.meta?.at ?? "local"}`;
  }

  return null;
}

function appendPendingUserMessages(
  messages: readonly EveMessageData["messages"][number][],
  pendingMessages: readonly (EveMessage | null)[],
) {
  let nextMessages = messages;

  for (const pendingMessage of pendingMessages) {
    const pendingText = pendingMessage ? getMessageText(pendingMessage) : null;

    if (!pendingMessage || !pendingText || hasLatestUserMessage(nextMessages, pendingText)) {
      continue;
    }

    nextMessages = [...nextMessages, pendingMessage];
  }

  return nextMessages;
}

function createPendingUserMessage(
  chatId: string,
  text: string,
  idSuffix = "pending-user-message",
): EveMessage {
  return {
    id: `${chatId}:${idSuffix}`,
    metadata: {
      optimistic: true,
      status: "submitted",
    },
    parts: [
      {
        state: "done",
        text,
        type: "text",
      },
    ],
    role: "user",
  };
}

function usePendingUserMessage() {
  const [message, setMessageState] = useState<string | null>(null);
  const messageRef = useRef<string | null>(null);

  const setMessage = useCallback((nextMessage: string | null) => {
    messageRef.current = nextMessage;
    setMessageState(nextMessage);
  }, []);

  const clearMessage = useCallback(() => {
    setMessage(null);
  }, [setMessage]);

  return { clearMessage, message, messageRef, setMessage };
}

const CONNECTION_LABELS = {
  linear: "Linear",
  notion: "Notion",
  sentry: "Sentry",
} satisfies Record<keyof EnabledConnections, string>;

function createConnectionClientContext(
  enabledConnections: EnabledConnections,
  connectionsAvailable: boolean,
) {
  if (!connectionsAvailable) {
    return "No external connections are configured. Do not search or call connection tools.";
  }

  const entries = Object.entries(CONNECTION_LABELS) as [keyof EnabledConnections, string][];
  const enabled = entries
    .filter(([connection]) => enabledConnections[connection])
    .map(([, label]) => label);
  const disabled = entries
    .filter(([connection]) => !enabledConnections[connection])
    .map(([, label]) => label);

  if (enabled.length > 0) {
    const disabledContext =
      disabled.length > 0
        ? ` Do not use disabled connections unless the user enables them first: ${disabled.join(", ")}.`
        : "";

    return `The user has enabled these external connections for this turn: ${enabled.join(", ")}. Use an enabled connection when it is relevant to the user's request.${disabledContext}`;
  }

  return "The user has disabled all external connections for this turn. Do not search or call connection tools unless the user enables a connection first.";
}

function useThinkingPresence(active: boolean) {
  const [shouldRender, setShouldRender] = useState(active);
  const [isVisible, setIsVisible] = useState(active);

  useEffect(() => {
    if (active) {
      setShouldRender(true);

      const frame = window.requestAnimationFrame(() => {
        setIsVisible(true);
      });

      return () => {
        window.cancelAnimationFrame(frame);
      };
    }

    setIsVisible(false);

    const timeout = window.setTimeout(() => {
      setShouldRender(false);
    }, THINKING_EXIT_DURATION_MS);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [active]);

  return { isVisible, shouldRender };
}

function ThinkingMessage({ isVisible }: { readonly isVisible: boolean }) {
  return (
    <article
      aria-live={isVisible ? "polite" : "off"}
      className={[
        "flex w-full justify-start overflow-hidden transition-[opacity,transform,max-height] duration-200 ease-out",
        isVisible ? "max-h-8 translate-y-0 opacity-100" : "max-h-0 -translate-y-1 opacity-0",
      ].join(" ")}
      role="status"
    >
      <div className="px-3 text-[15px] font-medium leading-6 text-muted-foreground">
        <span className="shimmer-text">Thinking...</span>
      </div>
    </article>
  );
}

function SessionHeader() {
  return <div className="h-12 shrink-0" />;
}

function BlankChatBody() {
  return <div className="min-h-0 flex-1" />;
}

export function EmptyChatBody({ composer }: { readonly composer?: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col pt-14 md:pt-8">
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <div className="w-full max-w-2xl space-y-8 sm:space-y-10 md:space-y-12">
          <h1 className="flex justify-center">
            <img
              alt="eve"
              className="size-16 select-none invert sm:size-20 md:size-24 dark:invert-0"
              draggable={false}
              src="/eve.svg"
            />
          </h1>
          {composer}
        </div>
      </div>
    </div>
  );
}

export function ErrorToast({
  message,
  onDismiss,
}: {
  readonly message: string;
  readonly onDismiss: () => void;
}) {
  return (
    <div
      aria-live="assertive"
      className="fixed top-3 right-3 z-50 flex w-[calc(100vw-1.5rem)] max-w-sm items-start gap-3 rounded-md border border-destructive/30 bg-background/95 p-3 text-sm shadow-lg backdrop-blur sm:top-4 sm:right-4"
      role="alert"
    >
      <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">Request failed</p>
        <p className="mt-0.5 text-muted-foreground">{message}</p>
      </div>
      <Button
        aria-label="Dismiss error"
        className="-mt-1 -mr-1 text-muted-foreground hover:text-foreground"
        onClick={onDismiss}
        size="icon-xs"
        type="button"
        variant="ghost"
      >
        <XIcon className="size-3.5" />
      </Button>
    </div>
  );
}

export function ComposerFooterControls({ setupStatus }: { readonly setupStatus: SetupStatus }) {
  const { enabledConnections, setConnectionEnabled } = useChatShell();

  return (
    <div className="flex min-w-0 max-w-full items-center gap-1.5 overflow-hidden">
      <ComposerHint setupStatus={setupStatus} />
      {setupStatus.connectionsAvailable ? (
        <IntegrationsMenu
          enabledConnections={enabledConnections}
          onConnectionEnabledChange={setConnectionEnabled}
          setupStatus={setupStatus}
        />
      ) : null}
    </div>
  );
}

function ComposerHint({ setupStatus }: { readonly setupStatus: SetupStatus }) {
  if (!setupStatus.appReady) {
    const reason = getSetupRequiredReason(setupStatus);

    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="inline-flex h-8 min-w-0 max-w-full items-center gap-1 rounded-md px-2 text-[15px] text-muted-foreground/50"
            tabIndex={0}
          >
            <LockIcon className="size-3.5 shrink-0" />
            <span className="truncate">Setup required</span>
            <ChevronDownIcon className="size-3.5 shrink-0" />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{reason}</TooltipContent>
      </Tooltip>
    );
  }

  return null;
}

function getSetupRequiredReason(setupStatus: SetupStatus) {
  return setupStatus.missing.length
    ? `Finish setup. Missing: ${setupStatus.missing.join(", ")}.`
    : "Finish setup before chatting.";
}

function hasLatestUserMessage(
  messages: readonly EveMessageData["messages"][number][],
  text: string,
) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (message?.role !== "user") {
      continue;
    }

    return getMessageText(message) === text.trim();
  }

  return false;
}

function getMessageText(message: EveMessageData["messages"][number]) {
  const text = message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();

  return text || null;
}
