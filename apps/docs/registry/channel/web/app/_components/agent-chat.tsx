"use client";

import type { UserContent } from "ai";
import type { StickToBottomContext } from "use-stick-to-bottom";
import { useEveAgent } from "eve/react";
import { AlertCircleIcon, SquareIcon } from "lucide-react";
import { usePathname } from "next/navigation";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
  ConversationTopFade,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent } from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputButton,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { cn } from "@/lib/utils";
import { chatMessageReducer, type ChatMessageData } from "@/lib/chat-message-reducer";
import { getActiveChatTurn } from "@/lib/chat-turn-state";
import { AgentMessage, type AgentInputResponse } from "./agent-message";
import { useChatWorkspace } from "./chat-workspace";
import { useServerStatus } from "./server-status";

interface AgentChatProps {
  readonly sessionId?: string;
  readonly sessionless?: boolean;
}

export function AgentChat(props: AgentChatProps) {
  const { newChatVersion } = useChatWorkspace();
  const pathname = usePathname();
  const sessionId = pathname.startsWith("/s/") ? decodeURIComponent(pathname.slice(3)) : undefined;
  const [assignedSession, setAssignedSession] = useState<{ id: string; key: string }>();
  // Assigning a URL to the first send must preserve its already-connected store.
  const conversationKey =
    sessionId && sessionId === assignedSession?.id
      ? assignedSession.key
      : (sessionId ?? `new-${newChatVersion}`);
  const onSessionAssigned = useCallback(
    (id: string) => setAssignedSession({ id, key: conversationKey }),
    [conversationKey],
  );
  return (
    <AgentConversation
      key={conversationKey}
      {...props}
      sessionId={sessionId}
      onSessionAssigned={onSessionAssigned}
    />
  );
}

function AgentConversation({
  sessionId,
  sessionless = false,
  onSessionAssigned,
}: AgentChatProps & { readonly onSessionAssigned: (id: string) => void }) {
  const {
    cache,
    preparedSession,
    sessionCreatedAt,
    model,
    onSessionCreated,
    refreshHistory,
    onSessionEvent,
  } = useChatWorkspace();
  const isDisconnected = useServerStatus() === "unavailable";
  const [saved] = useState(() =>
    sessionId
      ? (cache.get(sessionId) ??
        (preparedSession?.session.sessionId === sessionId ? preparedSession : undefined))
      : undefined,
  );
  const knownSessionId = useRef(sessionId);
  const conversationRef = useRef<StickToBottomContext>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const [cancellationError, setCancellationError] = useState<string>();
  const [hasInputText, setHasInputText] = useState(false);
  const [reducer] = useState(chatMessageReducer);
  const agent = useEveAgent<ChatMessageData>({
    reducer,
    initialEvents: saved?.events,
    initialSession: saved?.session ?? (sessionId ? { sessionId, streamIndex: 0 } : undefined),
    resume: sessionId !== undefined,
    onSessionChange(session) {
      if (!session || session.sessionId === knownSessionId.current) return;
      knownSessionId.current = session.sessionId;
      onSessionAssigned(session.sessionId);
      onSessionCreated();
      // Next synchronizes usePathname and Back/Forward for native history updates.
      window.history.replaceState(null, "", `/s/${encodeURIComponent(session.sessionId)}`);
    },
    onEvent(event) {
      if (knownSessionId.current) onSessionEvent(knownSessionId.current, event);
    },
    onFinish(snapshot) {
      if (snapshot.session) cache.set({ events: snapshot.events, session: snapshot.session });
      void refreshHistory();
    },
  });
  useLayoutEffect(() => {
    if (agent.session && agent.status !== "resuming")
      cache.set({ events: agent.events, session: agent.session });
  }, [cache, agent.events, agent.session, agent.status]);
  const [restoredMessages] = useState(agent.data.messages);
  const onInputResponses = useCallback(
    (inputResponses: readonly AgentInputResponse[]) => {
      setCancellationError(undefined);
      return agent.respond(inputResponses);
    },
    [agent.respond],
  );

  const activeTurnId = getActiveChatTurn(agent.events);
  const isBusy =
    agent.status === "submitted" || (agent.status === "streaming" && activeTurnId !== undefined);
  const isResuming = agent.status === "resuming";
  const messages = isResuming ? restoredMessages : agent.data.messages;
  const isEmpty = messages.length === 0;
  const lastMessage = messages.at(-1);
  const isPendingAssistantShell =
    lastMessage?.role === "assistant" &&
    lastMessage.parts.every((part) => part.type === "step-start");
  const showPendingThinking =
    isBusy &&
    (agent.status === "submitted" || lastMessage?.role !== "assistant" || isPendingAssistantShell);
  const turnFailure = isBusy || isResuming ? undefined : getLatestTurnFailure(agent.events);
  const errorMessage = cancellationError ?? agent.error?.message ?? turnFailure;
  const hasConversationContent = sessionless || !isEmpty || errorMessage !== undefined;
  const showConversationLayout = sessionId !== undefined || isResuming || hasConversationContent;
  const activeSessionId = sessionId ?? agent.session?.sessionId;

  useLayoutEffect(() => {
    const composer = composerRef.current;
    const section = sectionRef.current;
    if (!showConversationLayout || !composer || !section) return;
    const updateHeight = () => {
      section.style.setProperty("--composer-height", `${composer.offsetHeight}px`);
    };
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(composer);
    return () => observer.disconnect();
  }, [showConversationLayout]);

  const requestCancellation = () => {
    setCancellationError(undefined);
    void agent.cancel().catch((error: unknown) => {
      setCancellationError(toErrorMessage(error));
    });
  };

  const handleSubmit = async (message: PromptInputMessage) => {
    const text = message.text.trim();
    if ((text.length === 0 && message.files.length === 0) || isResuming || isDisconnected) return;
    setHasInputText(false);

    // Sending returns to the live conversation after scrolling up or inspecting a tool.
    void conversationRef.current?.scrollToBottom({
      animation: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
    });
    setCancellationError(undefined);
    // The SDK can retain its stream reader while children run. Its send API
    // still requires steer in that state, even though the parent UI is idle.
    const options =
      agent.status === "submitted" || agent.status === "streaming"
        ? { turnPolicy: "steer" as const }
        : undefined;

    const parts: UserContent = [];
    if (text.length > 0) {
      parts.push({ text, type: "text" });
    }
    for (const file of message.files) {
      parts.push({
        data: file.url,
        filename: file.filename,
        mediaType: file.mediaType,
        type: "file",
      });
    }

    await agent.send(message.files.length ? parts : text, options);
  };

  const composer = (
    <PromptInput
      className="rounded-3xl border-border/60 bg-card shadow-none"
      onSubmit={handleSubmit}
    >
      <PromptInputTextarea
        disabled={isResuming || isDisconnected}
        rows={1}
        className="min-h-6 px-4 py-3"
        onChange={(event) => setHasInputText(event.currentTarget.value.trim().length > 0)}
        placeholder={isDisconnected ? "Server unavailable" : "Send a message…"}
      />
      <PromptInputFooter className="min-h-12 px-4 pb-3 pr-14">
        {!isDisconnected ? (
          <span
            className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
            title={model?.id}
          >
            <span className="truncate text-foreground/80">
              {model
                ? formatModelName(model.id)
                : model === null
                  ? "Model unavailable"
                  : "Loading model…"}
            </span>
            {model?.reasoning ? <span className="capitalize">{model.reasoning}</span> : null}
          </span>
        ) : null}
      </PromptInputFooter>
      <ComposerAction
        hasInputText={hasInputText}
        isBusy={isBusy}
        isDisabled={isResuming || isDisconnected}
        onCancel={requestCancellation}
      />
    </PromptInput>
  );

  return (
    <section
      ref={sectionRef}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col [--composer-height:144px]"
      aria-label="Chat"
      data-session-id={activeSessionId}
    >
      {showConversationLayout ? (
        <Conversation
          contextRef={conversationRef}
          className="min-h-0 flex-1"
          initial="instant"
          resize={activeSessionId === undefined ? "smooth" : "instant"}
        >
          <ConversationTopFade />
          <ConversationContent className="mx-auto w-full max-w-3xl px-4 pt-6 pb-0 sm:px-6">
            <div className="flex flex-col gap-6 pb-[calc(var(--composer-height)+4px)]">
              <ChatHeader
                createdAt={
                  sessionCreatedAt ??
                  agent.events.find((event) => event.type === "session.started")?.meta?.at
                }
              />
              {isResuming && isEmpty ? (
                <p role="status" className="text-sm text-muted-foreground">
                  Loading conversation…
                </p>
              ) : null}
              {messages.map((message, index) =>
                showPendingThinking &&
                isPendingAssistantShell &&
                message.id === lastMessage.id ? null : (
                  <AgentMessage
                    canRespond={!isBusy && !isResuming}
                    isStreaming={
                      isBusy &&
                      message.metadata?.turnId === activeTurnId &&
                      index === messages.length - 1
                    }
                    key={message.id}
                    message={message}
                    onInputResponses={onInputResponses}
                  />
                ),
              )}
              {showPendingThinking ? <PendingThinking /> : null}
              {errorMessage ? <ErrorMessage message={errorMessage} /> : null}
            </div>
          </ConversationContent>
          <ConversationScrollButton className="bottom-[calc(var(--composer-height)+8px)]" />
        </Conversation>
      ) : null}

      <div
        ref={composerRef}
        className={cn(
          "mx-auto w-full px-4 sm:px-6",
          showConversationLayout
            ? "absolute bottom-0 left-1/2 z-20 max-w-3xl -translate-x-1/2 bg-gradient-to-t from-background via-background to-transparent pt-4 pb-6"
            : "flex max-w-3xl flex-1 flex-col items-center justify-center gap-8 pb-[8vh]",
        )}
      >
        {showConversationLayout ? null : (
          <div className="flex flex-col items-center gap-3 text-center">
            <h1 className="text-3xl font-medium tracking-tight sm:text-4xl">
              What should we work on?
            </h1>
          </div>
        )}
        <div className="w-full">{composer}</div>
      </div>
    </section>
  );
}

function ComposerAction({
  hasInputText,
  isBusy,
  isDisabled,
  onCancel,
}: {
  readonly hasInputText: boolean;
  readonly isBusy: boolean;
  readonly isDisabled: boolean;
  readonly onCancel: () => void;
}) {
  const attachments = usePromptInputAttachments();
  const canSubmit = hasInputText || attachments.files.length > 0;

  if (!isBusy || canSubmit) {
    return <PromptInputSubmit disabled={isDisabled} />;
  }

  return (
    <PromptInputButton
      aria-label="Stop"
      className="absolute right-2.5 bottom-2.5"
      onClick={onCancel}
      variant="outline"
    >
      <SquareIcon className="size-3 fill-current" />
    </PromptInputButton>
  );
}

function ErrorMessage({ message }: { readonly message: string }) {
  return (
    <Message className="max-w-full" from="assistant">
      <MessageContent>
        <div
          className="flex w-full items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm"
          role="alert"
        >
          <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div>
            <p className="font-medium">Request failed</p>
            <p className="mt-0.5 text-muted-foreground">{message}</p>
          </div>
        </div>
      </MessageContent>
    </Message>
  );
}

function ChatHeader({ createdAt }: { readonly createdAt?: string }) {
  const date = createdAt ? new Date(createdAt) : undefined;
  const validDate = date && Number.isFinite(date.getTime()) ? date : undefined;
  return (
    <header className="relative flex min-h-4 items-center justify-center px-12">
      {validDate ? (
        <time
          dateTime={validDate.toISOString()}
          className="truncate text-[11px] text-muted-foreground"
        >
          {validDate.toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            year: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
        </time>
      ) : null}
    </header>
  );
}

function PendingThinking() {
  return (
    <Message aria-live="polite" from="assistant">
      <MessageContent>
        <div className="mb-4 flex w-full items-center gap-2 text-muted-foreground text-sm">
          <Shimmer duration={1} repeatDelay={2}>
            Thinking
          </Shimmer>
        </div>
      </MessageContent>
    </Message>
  );
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to cancel the response.";
}

function getLatestTurnFailure(
  events: ReturnType<typeof useEveAgent>["events"],
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];

    if (event.type === "turn.failed") {
      return event.data.code === "MODEL_CALL_FAILED"
        ? "The model is temporarily unavailable. Please try again."
        : event.data.message;
    }

    if (event.type === "turn.completed" || event.type === "turn.cancelled") {
      return undefined;
    }

    if (event.type === "message.received") {
      return undefined;
    }
  }

  return undefined;
}

function formatModelName(id: string): string {
  return id
    .split("/")
    .at(-1)!
    .split("-")
    .map((part) => (part === "gpt" ? "GPT" : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(" ")
    .replace(/^GPT (\d)/, "GPT-$1");
}
