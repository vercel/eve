import { useHotkey } from "@tanstack/react-hotkeys";
import type { UserContent } from "ai";
import { ClientError } from "eve/client";
import { useEveAgent } from "eve/react";
import type {
  ConversationInput,
  ConversationState,
  UseEveAgentHelpers,
} from "eve/react";
import { AlertCircleIcon, BrainIcon, PlusIcon, SquareIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";

import { getAccessStatus } from "@/app/access";
import type { AccessStatus } from "@/app/access";
import { WEB_CHAT_AGENT } from "@/app/eve-agent";
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
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { AgentMessage } from "./agent-message";
import type { AgentInputResponse } from "./agent-message";

const DEFAULT_AGENT_NAME = "eve TanStack Agent";
const AGENT_NAME = WEB_CHAT_AGENT ?? DEFAULT_AGENT_NAME;

type EveAgent = UseEveAgentHelpers<ConversationState>;

/** Whether to show the thinking indicator, and the empty assistant message it replaces. */
interface PendingAssistant {
  readonly hiddenMessageId: string | undefined;
  readonly showThinking: boolean;
}

/** Display state derived from the agent on each render. */
interface ChatView {
  readonly activeSessionId: string | undefined;
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
 * whose URL (`/s/$sessionId`) resumes the durable session on reload.
 *
 * @param props - The component props.
 * @returns The chat page.
 */
export function AgentChat({
  sessionId,
  sessionless = false,
}: {
  /** Session to resume, from the `/s/$sessionId` route. */
  readonly sessionId?: string;
  /** Show the conversation layout before the first message (`/s`). */
  readonly sessionless?: boolean;
}) {
  const [actionError, setActionError] = useState<string>();
  const [hasInputText, setHasInputText] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const agent = useEveAgent({
    agent: WEB_CHAT_AGENT,
    initialSession:
      sessionId === undefined ? undefined : { sessionId, streamIndex: 0 },
    resume: sessionId !== undefined,
    onSessionChange(session) {
      if (sessionId === undefined && session !== undefined) {
        History.prototype.replaceState.call(
          window.history,
          window.history.state,
          "",
          `/s/${encodeURIComponent(session.sessionId)}`
        );
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

  useChatHotkeys({
    composerRef,
    isBusy: view.isBusy,
    onCancel: () => {
      void requestCancellation();
    },
  });

  const handleSubmit = async (message: PromptInputMessage) => {
    const text = message.text.trim();
    if ((text.length === 0 && message.files.length === 0) || view.isResuming) {
      return;
    }

    setHasInputText(false);
    setActionError(undefined);
    const options = view.isBusy ? { turnPolicy: "steer" as const } : undefined;
    await (message.files.length === 0
      ? agent.send(text, options)
      : agent.send(toUserContent(text, message.files), options));
  };

  const composer = (
    <PromptInput onSubmit={handleSubmit}>
      <PromptInputTextarea
        disabled={view.isResuming}
        ref={composerRef}
        onChange={(event) => {
          setHasInputText(event.currentTarget.value.trim().length > 0);
        }}
        placeholder="Send a message…"
      />
      <ComposerAction
        hasInputText={hasInputText}
        isBusy={view.isBusy}
        isResuming={view.isResuming}
        onCancel={() => {
          void requestCancellation();
        }}
      />
    </PromptInput>
  );

  return (
    <main className="bg-background text-foreground flex h-dvh flex-col overflow-hidden">
      {view.showConversationLayout ? (
        <>
          <ChatHeader canStartNewChat={view.activeSessionId !== undefined} />
          <ChatConversation
            agent={agent}
            isInitialSession={sessionId !== undefined}
            onInputResponses={async (inputResponses) => {
              setActionError(undefined);
              try {
                await agent.respond(inputResponses);
              } catch (error) {
                setActionError(
                  error instanceof Error
                    ? error.message
                    : "Unable to send your response."
                );
              }
            }}
            view={view}
          />
        </>
      ) : null}
      <div
        className={cn(
          "mx-auto w-full px-4 sm:px-6",
          view.showConversationLayout
            ? "from-background via-background fixed bottom-0 left-1/2 z-20 max-w-3xl -translate-x-1/2 bg-gradient-to-t to-transparent pt-4 pb-6"
            : "flex max-w-xl flex-1 flex-col items-center justify-center gap-8 pb-24"
        )}
      >
        {view.showConversationLayout ? null : (
          <div className="flex flex-col items-center gap-3 text-center">
            <h1 className="text-5xl font-medium tracking-tighter">
              {AGENT_NAME}
            </h1>
          </div>
        )}
        <div className="w-full">{composer}</div>
      </div>
      {view.showConversationLayout ? null : (
        <footer className="text-muted-foreground/70 pb-4 text-center text-xs">
          Powered by{" "}
          <a
            className="hover:text-foreground transition-colors"
            href="https://eve.dev/docs/guides/frontend/tanstack"
            rel="noreferrer"
            target="_blank"
          >
            eve
          </a>{" "}
          and{" "}
          <a
            className="hover:text-foreground transition-colors"
            href="https://tanstack.com/start"
            rel="noreferrer"
            target="_blank"
          >
            TanStack Start
          </a>
        </footer>
      )}
    </main>
  );
}

/**
 * Registers the chat's keyboard shortcuts: `/` or `Mod+K` focuses the composer,
 * `Escape` stops a streaming reply, and `Mod+Shift+O` starts a new chat.
 *
 * @param options - The composer and the active turn's state.
 */
function useChatHotkeys({
  composerRef,
  isBusy,
  onCancel,
}: {
  /** The composer's textarea. */
  readonly composerRef: RefObject<HTMLTextAreaElement | null>;
  /** Whether a reply is streaming, which enables `Escape`. */
  readonly isBusy: boolean;
  /** Stops the streaming reply. */
  readonly onCancel: () => void;
}) {
  const focusComposer = () => {
    composerRef.current?.focus();
  };
  useHotkey("/", focusComposer);
  useHotkey("Mod+K", focusComposer);
  useHotkey("Escape", onCancel, { enabled: isBusy });
  useHotkey("Mod+Shift+O", () => {
    window.location.assign("/s");
  });
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
    let isCurrent = true;
    const redirectIfLocked = async () => {
      if (!isUnauthenticated) {
        return;
      }
      const status = await readAccessStatus();
      if (!isCurrent || (status !== "locked" && status !== "unconfigured")) {
        return;
      }
      const here = window.location.pathname + window.location.search;
      window.location.assign(`/login?redirect=${encodeURIComponent(here)}`);
    };
    void redirectIfLocked();
    return () => {
      isCurrent = false;
    };
  }, [isUnauthenticated]);
}

/**
 * Asks the web app whether this browser has access to the chat.
 *
 * @returns The browser's access status, or `null` when the check fails.
 */
async function readAccessStatus(): Promise<AccessStatus | null> {
  try {
    return await getAccessStatus();
  } catch {
    return null;
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
    /** The last failed cancellation or response, if any. */
    readonly actionError: string | undefined;
    /** Session being resumed, if any. */
    readonly sessionId: string | undefined;
    /** Whether to show the conversation layout before any messages. */
    readonly sessionless: boolean;
  }
): ChatView {
  const isBusy = agent.status === "submitted" || agent.status === "streaming";
  const isResuming = agent.status === "resuming";
  const pending = getPendingAssistant(agent, isBusy);
  const turnFailure =
    isBusy || isResuming ? undefined : getLatestTurnFailure(agent.events);
  const errorMessage = actionError ?? agent.error?.message ?? turnFailure;
  const hasConversationContent =
    sessionless || agent.data.messages.length > 0 || errorMessage !== undefined;

  return {
    activeSessionId: sessionId ?? agent.session?.sessionId,
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
 * message (one with only `step-start` parts) it replaces.
 *
 * @param agent - The `useEveAgent` result.
 * @param isBusy - Whether a turn is submitted or streaming.
 * @returns Whether to show the indicator, and the message ID it hides.
 */
function getPendingAssistant(
  agent: EveAgent,
  isBusy: boolean
): PendingAssistant {
  const lastMessage = agent.data.messages.at(-1);
  if (!isBusy) {
    return { hiddenMessageId: undefined, showThinking: false };
  }
  if (lastMessage?.role !== "assistant") {
    return { hiddenMessageId: undefined, showThinking: true };
  }
  const isEmptyShell = lastMessage.parts.every(
    (part) => part.type === "step-start"
  );
  return {
    hiddenMessageId: isEmptyShell ? lastMessage.id : undefined,
    showThinking: agent.status === "submitted" || isEmptyShell,
  };
}

/**
 * Builds a multi-part user message from the composer's text and attachments.
 *
 * @param text - The trimmed message text, possibly empty.
 * @param files - The attached files.
 * @returns The message content parts.
 */
function toUserContent(
  text: string,
  files: PromptInputMessage["files"]
): UserContent {
  const parts: UserContent = [];
  if (text.length > 0) {
    parts.push({ text, type: "text" });
  }
  for (const file of files) {
    parts.push({
      data: file.url,
      filename: file.filename,
      mediaType: file.mediaType,
      type: "file",
    });
  }
  return parts;
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
  onInputResponses,
  view,
}: {
  /** The `useEveAgent` result. */
  readonly agent: EveAgent;
  /** Whether the page opened on an existing session. */
  readonly isInitialSession: boolean;
  /** Submits answers to questions and approvals. */
  readonly onInputResponses: (
    responses: readonly AgentInputResponse[]
  ) => Promise<void>;
  /** The derived {@link ChatView}. */
  readonly view: ChatView;
}) {
  const { messages } = agent.data;
  const canRespond = (requestId: string) =>
    !view.isResuming && agent.data.inputs[requestId]?.status === "open";
  const questionsFor = (callId: string): ConversationInput[] =>
    Object.values(agent.data.inputs).filter(
      (input) =>
        input.request.kind === "question" &&
        input.request.action.callId === callId
    );
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
      <ConversationTopFade className="top-14" />
      <ConversationContent className="mx-auto w-full max-w-3xl gap-6 px-4 pt-20 pb-36 sm:px-6">
        {messages.map((message) =>
          message.id === view.hiddenMessageId ? null : (
            <AgentMessage
              canRespond={canRespond}
              isStreaming={
                agent.status === "streaming" &&
                message.id === messages.at(-1)?.id
              }
              key={message.id}
              message={message}
              onInputResponses={onInputResponses}
              questionsFor={questionsFor}
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
  const attachments = usePromptInputAttachments();
  const canSubmit = hasInputText || attachments.files.length > 0;

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
 * The fixed header with the agent name and a "New chat" button.
 *
 * @param props - The component props.
 * @returns The header.
 */
function ChatHeader({
  canStartNewChat,
}: {
  /** Whether a session exists to leave. */
  readonly canStartNewChat: boolean;
}) {
  return (
    <header className="pointer-events-none fixed top-0 right-0 left-0 z-20 h-14">
      <div className="bg-background relative mx-auto flex h-full w-full max-w-3xl items-center justify-center px-24">
        <a
          className="text-muted-foreground hover:text-foreground pointer-events-auto truncate text-sm transition-colors"
          href="/"
        >
          {AGENT_NAME}
        </a>
        {canStartNewChat ? (
          <Button
            aria-label="Start a new chat"
            className="pointer-events-auto fixed top-3 right-6"
            onClick={() => {
              window.location.assign("/s");
            }}
            size="sm"
            type="button"
            variant="ghost"
          >
            <PlusIcon className="size-4" />
            <span className="hidden text-sm font-normal sm:inline">
              New chat
            </span>
          </Button>
        ) : null}
      </div>
    </header>
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
 * @param events - The agent's event log.
 * @returns A user-facing failure message, or `undefined` when the latest turn did not fail.
 */
function getLatestTurnFailure(events: EveAgent["events"]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];

    if (event.type === "turn.failed") {
      return event.data.code === "MODEL_CALL_FAILED"
        ? "The model is temporarily unavailable. Please try again."
        : event.data.message;
    }

    if (
      event.type === "turn.completed" ||
      event.type === "turn.cancelled" ||
      event.type === "message.received"
    ) {
      return undefined;
    }
  }

  return undefined;
}
