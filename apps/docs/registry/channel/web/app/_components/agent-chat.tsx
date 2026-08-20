"use client";

import type { UserContent } from "ai";
import { type EveAgentPendingSubmission, useEveAgent } from "eve/react";
import { AlertCircleIcon, SquareIcon } from "lucide-react";
import { useState } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  PromptInput,
  PromptInputButton,
  PromptInputFooter,
  type PromptInputMessage,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { cn } from "@/lib/utils";
import { AgentMessage } from "./agent-message";

const AGENT_NAME = "eve-agent";

type AgentStatus = ReturnType<typeof useEveAgent>["status"];
type ActiveTurnPolicy = "queue" | "steer";

export function AgentChat() {
  const [activeTurnPolicy, setActiveTurnPolicy] = useState<ActiveTurnPolicy>("queue");
  const [cancellationError, setCancellationError] = useState<string>();
  const [isCancelling, setIsCancelling] = useState(false);
  const agent = useEveAgent();
  const isBusy = agent.status === "submitted" || agent.status === "streaming";
  const isEmpty = agent.data.messages.length === 0;
  const errorMessage = cancellationError ?? agent.error?.message;

  const requestCancellation = () => {
    if (!isBusy || isCancelling) return;
    setCancellationError(undefined);
    setIsCancelling(true);
    void agent
      .cancel()
      .catch((error: unknown) => setCancellationError(toErrorMessage(error)))
      .finally(() => setIsCancelling(false));
  };

  const handleSubmit = async (message: PromptInputMessage) => {
    const text = message.text.trim();
    if (text.length === 0 && message.files.length === 0) return;

    setCancellationError(undefined);

    const options = isBusy ? { turnPolicy: activeTurnPolicy } : undefined;

    if (message.files.length === 0) {
      await agent.send(text, options);
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

    await agent.send(parts, options);
  };

  const composer = (
    <PromptInput onSubmit={handleSubmit}>
      <PromptInputTextarea placeholder="Send a message…" />
      <PromptInputFooter>
        <PromptInputTools>
          {isBusy ? (
            <>
              <PromptInputSelect
                onValueChange={(value) => setActiveTurnPolicy(value as ActiveTurnPolicy)}
                value={activeTurnPolicy}
              >
                <PromptInputSelectTrigger aria-label="Message delivery">
                  <PromptInputSelectValue />
                </PromptInputSelectTrigger>
                <PromptInputSelectContent>
                  <PromptInputSelectItem value="queue">Queue</PromptInputSelectItem>
                  <PromptInputSelectItem value="steer">Steer</PromptInputSelectItem>
                </PromptInputSelectContent>
              </PromptInputSelect>
              <PromptInputButton
                disabled={isCancelling}
                onClick={requestCancellation}
                tooltip="Stop the current turn"
              >
                <SquareIcon />
                {isCancelling ? "Stopping…" : "Stop"}
              </PromptInputButton>
            </>
          ) : null}
        </PromptInputTools>
        <PromptInputSubmit
          aria-label={isBusy ? (activeTurnPolicy === "queue" ? "Queue message" : "Steer") : "Send"}
          disabled={isCancelling}
        />
      </PromptInputFooter>
    </PromptInput>
  );

  return (
    <main className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
      {isEmpty ? null : (
        <header className="flex h-14 shrink-0 items-center justify-center gap-3 pl-4 pr-2">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-muted-foreground text-sm">{AGENT_NAME}</span>
            <StatusDot status={agent.status} />
          </span>
        </header>
      )}

      {errorMessage ? (
        <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pt-2 sm:px-6">
          <div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm">
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
            {agent.data.messages.map((message, index) => (
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
            ))}
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
        <PendingSubmissions submissions={agent.pendingSubmissions} />
        <div className="w-full">{composer}</div>
      </div>
    </main>
  );
}

function PendingSubmissions({
  submissions,
}: {
  readonly submissions: readonly EveAgentPendingSubmission[];
}) {
  if (submissions.length === 0) return null;

  return (
    <section className="mb-2 w-full rounded-xl border bg-muted/30 px-3 py-2.5">
      <h2 className="mb-1.5 font-medium text-muted-foreground text-xs">Up next</h2>
      <ol className="space-y-1.5">
        {submissions.map((submission) => (
          <li className="flex min-w-0 items-center gap-2 text-sm" key={submission.id}>
            <span className="min-w-0 flex-1 truncate">{submission.message}</span>
            <span
              className={cn(
                "shrink-0 rounded-full px-2 py-0.5 text-xs",
                submission.status === "failed"
                  ? "bg-destructive/10 text-destructive"
                  : submission.turnPolicy === "steer"
                    ? "bg-amber-500/10 text-amber-700 dark:text-amber-300"
                    : "bg-muted text-muted-foreground",
              )}
            >
              {submission.status === "submitting"
                ? "Sending"
                : submission.status === "steering"
                  ? "Steering"
                  : submission.status === "queued"
                    ? "Queued"
                    : "Failed"}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to cancel the response.";
}

function StatusDot({ status }: { readonly status: AgentStatus }) {
  const isLive = status === "submitted" || status === "streaming";
  const tone =
    status === "error"
      ? "bg-destructive"
      : isLive
        ? "bg-emerald-500"
        : status === "ready"
          ? "bg-muted-foreground"
          : "bg-muted-foreground/50";

  return (
    <span className="relative flex size-1">
      {isLive ? (
        <span
          className={cn(
            "absolute inline-flex size-full animate-ping rounded-full opacity-75",
            tone,
          )}
        />
      ) : null}
      <span className={cn("relative inline-flex size-1 rounded-full transition-colors", tone)} />
    </span>
  );
}
