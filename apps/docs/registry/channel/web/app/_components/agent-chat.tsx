"use client";

import type { UserContent } from "ai";
import { useEveAgent } from "eve/react";
import { AlertCircleIcon, BrainIcon } from "lucide-react";
import { useEffect, useState } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { Message, MessageContent } from "@/components/ai-elements/message";
import {
  PromptInput,
  type PromptInputMessage,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { cn } from "@/lib/utils";
import { AgentMessage } from "./agent-message";

const AGENT_NAME = "eve-agent";

export function AgentChat({ sessionId }: { readonly sessionId?: string }) {
  const [cancellationError, setCancellationError] = useState<string>();
  const [isRestoring, setIsRestoring] = useState(sessionId !== undefined);
  const agent = useEveAgent({
    initialSession:
      sessionId === undefined
        ? undefined
        : {
            sessionId,
            streamIndex: 0,
          },
    onSessionChange(session) {
      if (sessionId === undefined && session !== undefined) {
        window.history.replaceState(
          window.history.state,
          "",
          `/s/${encodeURIComponent(session.sessionId)}`,
        );
      }
    },
  });

  useEffect(() => {
    if (sessionId === undefined) return;
    let mounted = true;
    const timeout = window.setTimeout(() => {
      void agent.resume().finally(() => {
        if (mounted) setIsRestoring(false);
      });
    }, 0);
    return () => {
      mounted = false;
      window.clearTimeout(timeout);
    };
  }, [agent.resume, sessionId]);
  const isBusy = agent.status === "submitted" || agent.status === "streaming";
  const isEmpty = agent.data.messages.length === 0;
  const lastMessage = agent.data.messages.at(-1);
  const isPendingAssistantShell =
    lastMessage?.role === "assistant" &&
    lastMessage.parts.every((part) => part.type === "step-start");
  const showPendingThinking =
    isBusy &&
    (agent.status === "submitted" || lastMessage?.role !== "assistant" || isPendingAssistantShell);
  const turnFailure = isBusy ? undefined : getLatestTurnFailure(agent.events);
  const errorMessage = cancellationError ?? agent.error?.message ?? turnFailure;

  const requestCancellation = () => {
    setCancellationError(undefined);
    void agent.cancel().catch((error: unknown) => {
      setCancellationError(toErrorMessage(error));
    });
  };

  const handleSubmit = async (message: PromptInputMessage) => {
    const text = message.text.trim();
    if ((text.length === 0 && message.files.length === 0) || isBusy) return;

    setCancellationError(undefined);

    if (message.files.length === 0) {
      await agent.send(text);
      return;
    }

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

    await agent.send(parts);
  };

  const composer = (
    <PromptInput onSubmit={handleSubmit}>
      <PromptInputTextarea disabled={isBusy} placeholder="Send a message…" />
      <PromptInputSubmit onStop={requestCancellation} status={agent.status} />
    </PromptInput>
  );

  if (isRestoring && agent.events.length === 0) {
    return <ConversationSkeleton />;
  }

  return (
    <main className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      {isEmpty ? null : (
        <header className="flex h-14 shrink-0 items-center justify-center pl-4 pr-2">
          <span className="truncate text-muted-foreground text-sm">{AGENT_NAME}</span>
        </header>
      )}

      {errorMessage ? (
        <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pt-2 sm:px-6">
          <div
            className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm"
            role="alert"
          >
            <AlertCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div>
              <p className="font-medium">Request failed</p>
              <p className="mt-0.5 text-muted-foreground">{errorMessage}</p>
            </div>
          </div>
        </div>
      ) : null}

      {isEmpty ? null : (
        <Conversation className="min-h-0 flex-1">
          <ConversationContent className="mx-auto w-full max-w-3xl gap-6 px-4 py-6 sm:px-6">
            {agent.data.messages.map((message, index) =>
              showPendingThinking &&
              isPendingAssistantShell &&
              message.id === lastMessage.id ? null : (
                <AgentMessage
                  canRespond={!isBusy}
                  isStreaming={
                    agent.status === "streaming" && index === agent.data.messages.length - 1
                  }
                  key={message.id}
                  message={message}
                  onInputResponses={(inputResponses) => {
                    setCancellationError(undefined);
                    return agent.respond(inputResponses);
                  }}
                />
              ),
            )}
            {showPendingThinking ? <PendingThinking /> : null}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>
      )}

      <div
        className={cn(
          "mx-auto w-full px-4 sm:px-6",
          isEmpty
            ? "flex max-w-xl flex-1 flex-col items-center justify-center gap-8 pb-[10vh]"
            : "max-w-3xl shrink-0 pb-6",
        )}
      >
        {isEmpty ? (
          <div className="flex flex-col items-center gap-3 text-center">
            <h1 className="font-medium text-5xl tracking-tighter">{AGENT_NAME}</h1>
          </div>
        ) : null}
        <div className="w-full">{composer}</div>
      </div>
    </main>
  );
}

function ConversationSkeleton() {
  return (
    <main
      aria-busy="true"
      aria-label="Loading conversation"
      className="flex h-dvh flex-col overflow-hidden bg-background text-foreground"
    >
      <header className="flex h-14 shrink-0 items-center justify-center px-4">
        <div className="h-3 w-24 animate-pulse rounded-full bg-muted" />
      </header>
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="mx-auto flex w-full max-w-3xl animate-pulse flex-col gap-8 px-4 py-6 sm:px-6">
          <div className="ml-auto h-12 w-2/5 rounded-2xl bg-muted" />
          <div className="space-y-3">
            <div className="h-4 w-4/5 rounded-full bg-muted" />
            <div className="h-4 w-3/5 rounded-full bg-muted" />
          </div>
          <div className="ml-auto h-12 w-1/3 rounded-2xl bg-muted" />
          <div className="space-y-3">
            <div className="h-4 w-5/6 rounded-full bg-muted" />
            <div className="h-4 w-2/3 rounded-full bg-muted" />
            <div className="h-4 w-1/2 rounded-full bg-muted" />
          </div>
        </div>
      </div>
      <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-6 sm:px-6">
        <div className="relative h-24 animate-pulse rounded-2xl border bg-card shadow-sm">
          <div className="absolute top-5 left-4 h-4 w-36 rounded-full bg-muted" />
          <div className="absolute right-2.5 bottom-2.5 size-8 rounded-full bg-muted" />
        </div>
      </div>
    </main>
  );
}

function PendingThinking() {
  return (
    <Message aria-live="polite" from="assistant">
      <MessageContent>
        <div className="mb-4 flex w-full items-center gap-2 text-muted-foreground text-sm">
          <BrainIcon className="size-4" />
          <Shimmer duration={1}>Thinking</Shimmer>
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
