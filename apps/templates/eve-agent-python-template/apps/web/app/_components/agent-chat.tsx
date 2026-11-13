"use client";

import { ClientError } from "eve/client";
import { activeTurn, failure, interaction, turns } from "eve/events";
import { useEveAgent } from "eve/react";
import { AlertCircleIcon, BrainIcon, SquareIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

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
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { cn } from "@/lib/utils";

import { AgentMessage } from "./agent-message";
import type { AgentAnswer } from "./agent-message";

const AGENT_NAME = "eve Agent with Python";

type EveAgent = ReturnType<typeof useEveAgent>;

/** The session id in a `/s/[sessionId]` URL, when rendering in the browser. */
function getSessionIdFromLocation(): string | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  const match = /^\/s\/([^/]+)$/.exec(window.location.pathname);
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
}

/** Whether to show the thinking indicator, and the empty assistant message it replaces. */
interface PendingAssistant {
  readonly hiddenMessageId: string | undefined;
  readonly showThinking: boolean;
}

/** Display state derived from the agent on each render. */
interface ChatView {
  readonly activeSessionId: string | undefined;
  /** A running or paused turn that the Stop control can cancel. */
  readonly canCancel: boolean;
  readonly errorMessage: string | undefined;
  /** The empty assistant message hidden while the thinking indicator stands in for it. */
  readonly hiddenMessageId: string | undefined;
  readonly isBusy: boolean;
  readonly isResuming: boolean;
  readonly showConversationLayout: boolean;
  readonly showPendingThinking: boolean;
}

/**
 * The web chat: a centered composer for a new chat, then a conversation view
 * whose URL (`/s/[sessionId]`) resumes the durable session on reload.
 *
 * @param props - The component props.
 * @returns The chat page.
 */
export function AgentChat({
  sessionId: sessionIdProp,
  sessionless = false,
}: {
  /** Session to resume, from the `/s/[sessionId]` route. */
  readonly sessionId?: string;
  /** Show the conversation layout before the first message (`/s`). */
  readonly sessionless?: boolean;
}) {
  // Read once: the store only uses its initial session config. Falling back to the
  // URL covers Back navigation to a `/s/<id>` entry whose page tree is `/` or `/s`.
  const [sessionId] = useState(() => sessionIdProp ?? getSessionIdFromLocation());
  const [actionError, setActionError] = useState<string>();
  const [hasInputText, setHasInputText] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const agent = useEveAgent({
    initialSession:
      sessionId === undefined ? undefined : { sessionId, streamIndex: 0 },
    resume: sessionId !== undefined,
    onSessionChange(session) {
      if (session === undefined) {
        return;
      }
      // Fires on every stream event; only touch history when the URL changes.
      const path = `/s/${encodeURIComponent(session.sessionId)}`;
      if (window.location.pathname !== path) {
        window.history.replaceState(null, "", path);
      }
    },
  });
  useSignInRedirect(agent.error);

  const view = getChatView(agent, {
    actionError,
    sessionId,
    sessionless,
  });

  const requestCancellation = async () => {
    setActionError(undefined);
    try {
      await agent.cancel();
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : "Unable to cancel the response."
      );
    }
  };

  const sendText = async (value: string) => {
    const text = value.trim();
    if (text.length === 0 || view.isResuming) {
      return;
    }

    setActionError(undefined);
    try {
      await agent.send(
        text,
        view.isBusy ? { turnPolicy: "steer" as const } : undefined
      );
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : "Unable to send your message."
      );
      // PromptInput clears the box on submit; put the text back for a retry
      // unless the visitor has started typing something else.
      const textarea = textareaRef.current;
      if (textarea !== null && textarea.value === "") {
        textarea.value = value;
        setHasInputText(text.length > 0);
      }
    }
  };

  const handleSubmit = async (message: PromptInputMessage) => {
    if (message.text.trim().length > 0) {
      setHasInputText(false);
    }
    await sendText(message.text);
  };

  const composer = (
    <PromptInput maxFiles={0} onSubmit={handleSubmit}>
      <PromptInputTextarea
        disabled={view.isResuming}
        onChange={(event) => {
          setHasInputText(event.currentTarget.value.trim().length > 0);
        }}
        placeholder="Send a message…"
        ref={textareaRef}
      />
      <ComposerAction
        hasInputText={hasInputText}
        isBusy={view.canCancel}
        isResuming={view.isResuming}
        onCancel={() => {
          void requestCancellation();
        }}
      />
    </PromptInput>
  );

  return (
    <main className="bg-background text-foreground relative flex h-[calc(100dvh-var(--header-height))] flex-col overflow-hidden">
      {view.showConversationLayout ? (
        <ChatConversation
          agent={agent}
          isInitialSession={sessionId !== undefined}
          onAnswers={async (answers) => {
            setActionError(undefined);
            try {
              await agent.respond(answers);
            } catch (error) {
              setActionError(
                error instanceof Error
                  ? error.message
                  : "Unable to send your response."
              );
              // Rethrow so the question or approval re-enables for a retry.
              throw error;
            }
          }}
          view={view}
        />
      ) : null}
      <div
        className={cn(
          "mx-auto w-full px-4 sm:px-6",
          view.showConversationLayout
            ? "from-background via-background absolute bottom-0 left-1/2 z-20 max-w-3xl -translate-x-1/2 bg-gradient-to-t to-transparent pt-4 pb-6"
            : "flex max-w-xl flex-1 flex-col items-center justify-center gap-8 pb-16"
        )}
      >
        {view.showConversationLayout ? null : (
          <div className="flex flex-col items-center gap-3 text-center">
            <h1 className="text-4xl font-medium tracking-tighter sm:text-5xl">
              {AGENT_NAME}
            </h1>
            <p className="text-muted-foreground max-w-md text-base text-balance">
              Manage tasks, crunch numbers, and analyze text with an agent
              whose tools run in Python.
            </p>
          </div>
        )}
        <div className="w-full">{composer}</div>
      </div>
      {view.showConversationLayout ? null : (
        <footer className="text-muted-foreground/70 pb-4 text-center text-xs">
          Powered by{" "}
          <a
            className="hover:text-foreground transition-colors"
            href="https://eve.dev/docs/guides/frontend/nextjs"
            rel="noreferrer"
            target="_blank"
          >
            eve
          </a>
          ,{" "}
          <a
            className="hover:text-foreground transition-colors"
            href="https://nextjs.org"
            rel="noreferrer"
            target="_blank"
          >
            Next.js
          </a>
          , and{" "}
          <a
            className="hover:text-foreground transition-colors"
            href="https://vercel.com/docs/frameworks/backend/fastapi"
            rel="noreferrer"
            target="_blank"
          >
            FastAPI
          </a>
        </footer>
      )}
    </main>
  );
}

/**
 * Sends the visitor to `/login` when the agent rejects them and the web app
 * confirms they lack access (the access cookie expired or the password
 * changed), returning them to this chat afterwards. When the web app still
 * grants access, the chat stays put and shows the agent's error instead.
 *
 * @param error - The agent client's current error.
 */
function useSignInRedirect(error: Error | undefined) {
  const isUnauthenticated =
    error instanceof ClientError && error.status === 401;
  useEffect(() => {
    if (!isUnauthenticated) {
      return;
    }
    let isCurrent = true;
    const redirectIfLocked = async () => {
      if (!(await isLockedOut()) || !isCurrent) {
        return;
      }
      const here = window.location.pathname + window.location.search;
      window.location.assign(`/login?next=${encodeURIComponent(here)}`);
    };
    void redirectIfLocked();
    return () => {
      isCurrent = false;
    };
  }, [isUnauthenticated]);
}

/**
 * Asks the web app whether this browser still has access. The password gate
 * in `proxy.ts` answers `401` for `/api/*` requests without a valid cookie.
 *
 * @returns Whether the browser is locked out; `false` when the check fails.
 */
async function isLockedOut(): Promise<boolean> {
  try {
    const response = await fetch("/api/auth/status", { cache: "no-store" });
    return response.status === 401;
  } catch {
    return false;
  }
}

/**
 * Derives what the chat should show from the agent's state.
 *
 * @param agent - The `useEveAgent` result.
 * @param options - Chat state held outside the agent.
 * @returns The derived {@link ChatView}.
 */
function getChatView(
  agent: EveAgent,
  {
    actionError,
    sessionId,
    sessionless,
  }: {
    /** The last failed send, cancellation, or response, if any. */
    readonly actionError: string | undefined;
    /** Session being resumed, if any. */
    readonly sessionId: string | undefined;
    /** Whether to show the conversation layout before any messages. */
    readonly sessionless: boolean;
  }
): ChatView {
  const isBusy = agent.status === "busy";
  const isResuming = agent.status === "resuming";
  const canCancel = activeTurn(agent.view) !== undefined;
  const pending = getPendingAssistant(agent, isBusy);
  const turnFailure =
    isBusy || isResuming ? undefined : getLatestTurnFailure(agent.view);
  const errorMessage = actionError ?? agent.error?.message ?? turnFailure;
  const hasConversationContent =
    sessionless || agent.messages.length > 0 || errorMessage !== undefined;

  return {
    activeSessionId: sessionId ?? agent.session?.sessionId,
    canCancel,
    errorMessage,
    hiddenMessageId: pending.hiddenMessageId,
    isBusy,
    isResuming,
    showConversationLayout: isResuming || hasConversationContent,
    showPendingThinking: pending.showThinking,
  };
}

/**
 * Decides whether to show the thinking indicator, and which empty assistant
 * message (one with no visible response, tool, or interaction parts) it replaces.
 *
 * @param agent - The `useEveAgent` result.
 * @param isBusy - Whether a turn is submitted or streaming.
 * @returns Whether to show the indicator, and the message ID it hides.
 */
function getPendingAssistant(
  agent: EveAgent,
  isBusy: boolean
): PendingAssistant {
  const lastMessage = agent.messages.at(-1);
  if (!isBusy) {
    return { hiddenMessageId: undefined, showThinking: false };
  }
  if (lastMessage?.role !== "assistant") {
    return { hiddenMessageId: undefined, showThinking: true };
  }
  const isEmptyShell = lastMessage.parts.every(
    (part) =>
      part.type !== "text" &&
      part.type !== "reasoning" &&
      part.type !== "tool" &&
      part.type !== "interaction"
  );
  return {
    hiddenMessageId: isEmptyShell ? lastMessage.id : undefined,
    showThinking: isEmptyShell,
  };
}

/**
 * The scrolling message list, with the thinking indicator and any error.
 *
 * @param props - The component props.
 * @returns The conversation.
 */
function ChatConversation({
  agent,
  isInitialSession,
  onAnswers,
  view,
}: {
  /** The `useEveAgent` result. */
  readonly agent: EveAgent;
  /** Whether the page opened on an existing session. */
  readonly isInitialSession: boolean;
  /** Submits answers to questions and approvals. */
  readonly onAnswers: (
    responses: readonly AgentAnswer[]
  ) => Promise<void>;
  /** The derived {@link ChatView}. */
  readonly view: ChatView;
}) {
  const { messages } = agent;
  const canRespond = (interactionId: string) =>
    !view.isResuming && interaction(agent.view, interactionId)?.status === "open";
  const scrollKey =
    messages.length > 0 && view.activeSessionId !== undefined
      ? `eve:web-chat-scroll:${view.activeSessionId}`
      : undefined;

  return (
    <Conversation
      className="min-h-0 flex-1"
      initial={isInitialSession ? false : undefined}
      resize={view.activeSessionId === undefined ? "smooth" : "instant"}
      scrollRestorationKey={scrollKey}
    >
      <ConversationTopFade />
      <ConversationContent className="mx-auto w-full max-w-3xl gap-6 px-4 pt-8 pb-36 sm:px-6">
        {messages.map((message) =>
          message.id === view.hiddenMessageId ? null : (
            <AgentMessage
              canRespond={canRespond}
              isStreaming={
                agent.status === "busy" &&
                message.id === messages.at(-1)?.id
              }
              key={message.id}
              message={message}
              onAnswers={onAnswers}
            />
          )
        )}
        {view.showPendingThinking ? <PendingThinking /> : null}
        {view.errorMessage === undefined ? null : (
          <ErrorMessage message={view.errorMessage} />
        )}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}

/**
 * The composer's action button: send, or stop while a turn runs and the composer is empty.
 *
 * @param props - The component props.
 * @returns The send or stop button.
 */
function ComposerAction({
  hasInputText,
  isBusy,
  isResuming,
  onCancel,
}: {
  /** Whether the textarea has text. */
  readonly hasInputText: boolean;
  /** Whether a turn is running. */
  readonly isBusy: boolean;
  /** Whether the session is still catching up. */
  readonly isResuming: boolean;
  /** Cancels the running turn. */
  readonly onCancel: () => void;
}) {
  const canSubmit = hasInputText;

  if (!isBusy || canSubmit) {
    return <PromptInputSubmit disabled={isResuming || !canSubmit} />;
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

/**
 * An assistant-style message reporting a failed request or turn.
 *
 * @param props - The component props.
 * @returns The error message.
 */
function ErrorMessage({
  message,
}: {
  /** The error to show. */
  readonly message: string;
}) {
  return (
    <Message className="max-w-full" from="assistant">
      <MessageContent>
        <div
          className="border-destructive/30 bg-destructive/5 flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-sm"
          role="alert"
        >
          <AlertCircleIcon className="text-destructive mt-0.5 size-4 shrink-0" />
          <div>
            <p className="font-medium">Request failed</p>
            <p className="text-muted-foreground mt-0.5">{message}</p>
          </div>
        </div>
      </MessageContent>
    </Message>
  );
}

/**
 * Placeholder shown until the assistant's first output arrives.
 *
 * @returns The thinking indicator.
 */
function PendingThinking() {
  return (
    <Message aria-live="polite" from="assistant">
      <MessageContent>
        <div className="text-muted-foreground mb-4 flex w-full items-center gap-2 text-sm">
          <BrainIcon className="size-4" />
          <Shimmer duration={1}>Thinking</Shimmer>
        </div>
      </MessageContent>
    </Message>
  );
}

/**
 * Finds the latest turn failure, ignoring failures a later turn or message superseded.
 *
 * @param view - The agent's committed session view.
 * @returns A user-facing failure message, or `undefined` when the latest turn did not fail.
 */
function getLatestTurnFailure(view: EveAgent["view"]): string | undefined {
  const latestTurn = turns(view).at(-1);
  const turnFailure = failure(view, latestTurn?.turnId);
  if (turnFailure !== undefined) {
    return turnFailure.code === "MODEL_CALL_FAILED"
      ? "The model is temporarily unavailable. Please try again."
      : turnFailure.message;
  }
  return undefined;
}
