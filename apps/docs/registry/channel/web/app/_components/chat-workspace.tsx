"use client";

import { createLocalSessionHistory } from "@/lib/local-session-history";

import { Client, type MessageStreamEvent } from "eve/client";
import { usePathname, useRouter } from "next/navigation";
import {
  createContext,
  startTransition,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createChatSessionCache, type SavedChatSession } from "@/lib/chat-session-cache";
import { applySessionActivity, sortSessions, type SessionHistory } from "@/lib/session-history";
import { SidebarProvider } from "@/components/ui/sidebar";
import { ChatWorkspaceLayout } from "./chat-workspace-layout";
import { SessionSidebar } from "./session-sidebar";
import { mergeSessionHistory } from "@/lib/merge-session-history";
import { ServerStatusProvider, useServerStatus } from "./server-status";

interface ChatModel {
  readonly id: string;
  readonly reasoning?: string;
}

interface WorkspaceContext {
  readonly draftOwner?: string;
  readonly cache: ReturnType<typeof createChatSessionCache>;
  readonly preparedSession?: SavedChatSession;
  readonly sessionCreatedAt?: string;
  readonly model: ChatModel | null | undefined;
  readonly newChatVersion: number;
  readonly startNewChat: () => void;
  readonly onSessionCreated: () => void;
  readonly refreshHistory: () => Promise<void>;
  readonly onSessionEvent: (id: string, event: MessageStreamEvent) => void;
}

const ChatWorkspaceContext = createContext<WorkspaceContext | null>(null);

export function useChatWorkspace() {
  const workspace = useContext(ChatWorkspaceContext);
  if (!workspace) throw new Error("Chat must be rendered inside ChatWorkspace.");
  return workspace;
}

export function ChatWorkspace({
  children,
  localWorkspace = false,
  initialOwner,
}: {
  readonly children: ReactNode;
  readonly localWorkspace?: boolean;
  readonly initialOwner?: string;
}) {
  return (
    <ServerStatusProvider>
      <Workspace localWorkspace={localWorkspace} initialOwner={initialOwner}>
        {children}
      </Workspace>
    </ServerStatusProvider>
  );
}

function Workspace({
  children,
  localWorkspace,
  initialOwner,
}: {
  readonly children: ReactNode;
  readonly localWorkspace: boolean;
  readonly initialOwner?: string;
}) {
  const status = useServerStatus();
  const [localHistory] = useState(() =>
    createLocalSessionHistory({
      getItem: (key) => localStorage.getItem(key),
      setItem: (key, value) => localStorage.setItem(key, value),
    }),
  );
  useEffect(() => {
    window.addEventListener("pagehide", localHistory.flush);
    return () => {
      window.removeEventListener("pagehide", localHistory.flush);
      localHistory.flush();
    };
  }, [localHistory]);
  const pathname = usePathname();
  const router = useRouter();
  const [history, setHistory] = useState<SessionHistory>();
  const [historyError, setHistoryError] = useState<string>();
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const moreRequest = useRef(false);
  const historyVersion = useRef(0);
  const viewerId = useRef<string | undefined>(undefined);
  const [identityVersion, setIdentityVersion] = useState(0);
  const [model, setModel] = useState<ChatModel | null>();
  const [newChatVersion, setNewChatVersion] = useState(0);
  const [cache] = useState(createChatSessionCache);
  const [preparedSession, setPreparedSession] = useState<SavedChatSession>();
  const [pendingSessionId, setPendingSessionId] = useState<string>();
  const [navigationError, setNavigationError] = useState<string>();
  const navigationVersion = useRef(0);
  const historyRequest = useRef<Promise<void> | undefined>(undefined);

  const onSessionEvent = useCallback(
    (id: string, event: MessageStreamEvent) => {
      // Text deltas do not need to reorder the sidebar on every token.
      if (!["message.received", "message.completed", "turn.started"].includes(event.type)) return;
      if (localWorkspace) {
        setHistory(localHistory.record(id, event));
        return;
      }
      setHistory((history) => {
        if (!history) return history;
        return {
          ...history,
          sessions: sortSessions(
            history.sessions.map((session) =>
              session.id === id ? { ...session, ...applySessionActivity(session, event) } : session,
            ),
          ),
        };
      });
    },
    [localHistory, localWorkspace],
  );

  const acceptViewer = useCallback(
    (id?: string) => {
      if (viewerId.current && viewerId.current !== id) {
        cache.clear();
        navigationVersion.current++;
        setPreparedSession(undefined);
        setPendingSessionId(undefined);

        setIdentityVersion((value) => value + 1);
        router.replace("/");
      }
      viewerId.current = id;
    },
    [cache, router],
  );

  const refreshHistory = useCallback(() => {
    if (localWorkspace) {
      setHistory(localHistory.load());
      return Promise.resolve();
    }
    if (!localWorkspace) return Promise.resolve();
    if (historyRequest.current) return historyRequest.current;
    const version = ++historyVersion.current;
    const request = (async () => {
      try {
        const response = await fetch("/api/sessions", {
          cache: "no-store",
          signal: AbortSignal.timeout(30_000),
        });
        if (version !== historyVersion.current) return;
        if (response.status === 401 || response.status === 403) {
          acceptViewer(undefined);
          setHistory(undefined);
          throw new Error(
            response.status === 401 ? "Sign in to view your chats." : "Access denied.",
          );
        }
        if (!response.ok) throw new Error("Session history is unavailable.");
        const incoming: SessionHistory = await response.json();
        if (version !== historyVersion.current) return;
        acceptViewer(incoming.viewer.id);
        setHistory((current) => mergeSessionHistory(current, incoming));
        setHistoryError(undefined);
      } catch (error) {
        if (version === historyVersion.current)
          setHistoryError(error instanceof Error ? error.message : "Unable to load chats.");
      } finally {
        historyRequest.current = undefined;
      }
    })();
    historyRequest.current = request;
    return request;
  }, [acceptViewer, localWorkspace, localHistory]);

  const loadMoreHistory = useCallback(async () => {
    if (!history?.nextCursor || moreRequest.current || historyRequest.current) return;
    const version = historyVersion.current;
    moreRequest.current = true;
    setIsLoadingMore(true);
    try {
      const response = await fetch(
        `/api/sessions?cursor=${encodeURIComponent(history.nextCursor)}`,
        {
          cache: "no-store",
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (version !== historyVersion.current) return;
      if (response.status === 401 || response.status === 403) {
        acceptViewer(undefined);
        setHistory(undefined);
        throw new Error("Sign in to view your chats.");
      }
      if (!response.ok) throw new Error("Unable to load more chats.");
      const incoming: SessionHistory = await response.json();
      if (version !== historyVersion.current) return;
      acceptViewer(incoming.viewer.id);
      setHistory((current) => mergeSessionHistory(current, incoming));
      setHistoryError(undefined);
    } catch (error) {
      if (version === historyVersion.current)
        setHistoryError(error instanceof Error ? error.message : "Unable to load more chats.");
    } finally {
      moreRequest.current = false;
      setIsLoadingMore(false);
    }
  }, [history?.nextCursor, acceptViewer]);

  useEffect(() => {
    void refreshHistory();
    const controller = new AbortController();
    void fetch("/eve/v1/info", {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Model unavailable");
        const info = await response.json();
        setModel(
          typeof info.agent?.model?.id === "string"
            ? {
                id: info.agent.model.id,
                reasoning:
                  typeof info.agent.model.reasoning === "string"
                    ? info.agent.model.reasoning
                    : undefined,
              }
            : null,
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) setModel(null);
      });
    const onFocus = () => {
      void refreshHistory();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      controller.abort();
      window.removeEventListener("focus", onFocus);
    };
  }, [refreshHistory, status]);

  const startNewChat = useCallback(() => {
    navigationVersion.current += 1;
    setPendingSessionId(undefined);
    setNavigationError(undefined);
    setPreparedSession(undefined);
    setNewChatVersion((version) => version + 1);
  }, []);
  useEffect(() => {
    const cancelNavigation = () => {
      navigationVersion.current += 1;
      setPendingSessionId(undefined);
      setNavigationError(undefined);
    };
    window.addEventListener("popstate", cancelNavigation);
    return () => {
      navigationVersion.current += 1;
      window.removeEventListener("popstate", cancelNavigation);
    };
  }, []);
  useEffect(() => {
    setPendingSessionId(undefined);
  }, [pathname]);

  const loadSession = useCallback(
    (id: string) =>
      cache.load(id, () =>
        new Client({ host: window.location.origin }).sessions.attach(id).snapshot({
          signal: AbortSignal.timeout(15_000),
        }),
      ),
    [cache],
  );
  const prefetchSession = useCallback(
    (id: string) => {
      void loadSession(id).catch(() => {});
    },
    [loadSession],
  );
  const selectSession = useCallback(
    async (id: string) => {
      const version = ++navigationVersion.current;
      setNavigationError(undefined);
      if (window.location.pathname === `/s/${encodeURIComponent(id)}`) {
        setPendingSessionId(undefined);
        return true;
      }
      setPendingSessionId(id);
      try {
        const snapshot = await loadSession(id);
        if (version !== navigationVersion.current) return false;
        startTransition(() => {
          // Keep one prepared snapshot even when its history exceeds the cache limit.
          setPreparedSession(snapshot);
          router.push(`/s/${encodeURIComponent(id)}`, { scroll: false });
        });
        return true;
      } catch {
        if (version === navigationVersion.current) {
          setPendingSessionId(undefined);
          setNavigationError("Unable to open this chat. Select it again to retry.");
        }
        return false;
      }
    },
    [loadSession, router],
  );
  const onSessionCreated = useCallback(() => {
    void refreshHistory();
  }, [refreshHistory]);
  const activeSessionId = pathname.startsWith("/s/")
    ? decodeURIComponent(pathname.slice(3))
    : undefined;
  const sessionCreatedAt = history?.sessions.find(
    (session) => session.id === activeSessionId,
  )?.createdAt;
  const draftOwner = initialOwner ?? history?.viewer.id ?? (localWorkspace ? "local" : "browser");
  const context = useMemo(
    () => ({
      draftOwner,
      cache,
      preparedSession,
      sessionCreatedAt,
      model,
      newChatVersion,
      startNewChat,
      onSessionCreated,
      refreshHistory,
      onSessionEvent,
    }),
    [
      draftOwner,
      cache,
      preparedSession,
      sessionCreatedAt,
      model,
      newChatVersion,
      startNewChat,
      onSessionCreated,
      refreshHistory,
      onSessionEvent,
    ],
  );

  return (
    <ChatWorkspaceContext.Provider key={identityVersion} value={context}>
      <main className="relative flex h-dvh overflow-hidden bg-background text-foreground">
        <SidebarProvider className="min-h-0 h-full">
          <ChatWorkspaceLayout
            sidebar={
              <SessionSidebar
                historyEnabled={localWorkspace}
                activeSessionId={activeSessionId}
                error={historyError}
                history={history}
                isLoadingMore={isLoadingMore}
                onLoadMore={loadMoreHistory}
                onRetry={refreshHistory}
                onNewChat={startNewChat}
                pendingSessionId={pendingSessionId}
                navigationError={navigationError}
                onPrefetchSession={prefetchSession}
                onSelectSession={selectSession}
              />
            }
          >
            {children}
          </ChatWorkspaceLayout>
        </SidebarProvider>
      </main>
    </ChatWorkspaceContext.Provider>
  );
}
