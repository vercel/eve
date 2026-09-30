"use client";

import type { ConversationInput } from "eve/react";
import { ArrowRightIcon, ExternalLinkIcon } from "lucide-react";
import { useState } from "react";
import {
  Question,
  QuestionInput,
  QuestionOption,
  QuestionOptions,
  QuestionPrompt,
  type QuestionResponse,
  QuestionSubmit,
  type QuestionValue,
} from "@/components/ai-elements/question";
import { Button } from "@/components/ui/button";
import { formatJson, inputAnswer, type PendingRequest } from "./conversation-view";

export type AgentInputResponse = {
  readonly optionId?: string;
  readonly requestId: string;
  readonly text?: string;
};

/**
 * A run of requests waiting on the person, in the order they arrived. Each answer sends on its
 * own; an answered approval stays here until its whole batch is answered and the agent picks it up.
 */
export function RequestGroup({
  canRespond,
  onRespond,
  requests,
}: {
  readonly canRespond: boolean;
  readonly onRespond: (response: AgentInputResponse) => Promise<void>;
  readonly requests: readonly PendingRequest[];
}) {
  return (
    <section aria-label="Waiting for you" className="divide-y rounded-xl border">
      {requests.map((request) => (
        <div className="space-y-2 p-4" key={request.key}>
          <p className="text-muted-foreground text-xs">{requestLabel(request)}</p>
          {request.kind === "auth" ? (
            <SignIn part={request.part} />
          ) : request.input.status === "open" ? (
            <InputRequest canRespond={canRespond} input={request.input} onRespond={onRespond} />
          ) : (
            <p className="text-sm">
              {request.input.request.prompt}{" "}
              <span className="text-muted-foreground">
                → {inputAnswer(request.input) ?? "sent"}
              </span>
            </p>
          )}
        </div>
      ))}
    </section>
  );
}

function requestLabel(request: PendingRequest): string {
  if (request.kind === "auth") return "Sign-in";
  const { request: asked } = request.input;
  const kind =
    asked.kind === "tool-approval"
      ? `Approval for ${asked.action.toolName}`
      : asked.kind === "question"
        ? "Question"
        : "Session limit";
  return request.from === undefined ? kind : `${kind} · from ${request.from}`;
}

function InputRequest({
  canRespond,
  input,
  onRespond,
}: {
  readonly canRespond: boolean;
  readonly input: ConversationInput;
  readonly onRespond: (response: AgentInputResponse) => Promise<void>;
}) {
  const { request } = input;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const disabled = !canRespond || pending;

  const send = async (response: Omit<AgentInputResponse, "requestId">) => {
    setPending(true);
    setError(undefined);
    try {
      await onRespond({ ...response, requestId: request.requestId });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Couldn't send the answer.");
      setPending(false);
    }
  };

  const body =
    request.kind === "question" && request.display !== "confirmation" ? (
      <QuestionRequest disabled={disabled} onSend={send} request={request} />
    ) : (
      <>
        <p className="font-medium text-sm">{request.prompt}</p>
        {request.kind === "tool-approval" ? (
          <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/60 p-2 font-mono text-[11px] leading-4">
            {formatJson(request.action.input)}
          </pre>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {(request.options ?? []).map((option) => (
            <Button
              disabled={disabled}
              key={option.id}
              onClick={() => void send({ optionId: option.id })}
              size="sm"
              type="button"
              variant={option.style === "primary" ? "default" : "outline"}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </>
    );

  return (
    <>
      {body}
      {error ? <p className="text-destructive text-xs">{error}</p> : null}
    </>
  );
}

/** Answered with an option or, when the question allows it, in the person's own words. */
function QuestionRequest({
  disabled,
  onSend,
  request,
}: {
  readonly disabled: boolean;
  readonly onSend: (response: Omit<AgentInputResponse, "requestId">) => Promise<void>;
  readonly request: ConversationInput["request"];
}) {
  const options = request.options ?? [];
  const acceptsFreeform = request.allowFreeform === true || options.length === 0;
  const [value, setValue] = useState<QuestionValue>({ selectedValues: [], text: "" });

  return (
    <Question
      className="space-y-3 rounded-none border-0 bg-transparent p-0"
      disabled={disabled}
      onSubmit={({ selectedValues, text }: QuestionResponse) =>
        onSend({ optionId: selectedValues[0], text })
      }
      onValueChange={setValue}
      value={value}
    >
      <QuestionPrompt>{request.prompt}</QuestionPrompt>
      {options.length > 0 ? (
        <QuestionOptions aria-label={request.prompt} className="flex-col items-stretch">
          {options.map((option) => (
            <QuestionOption
              className="justify-start px-3 py-2 text-left"
              key={option.id}
              onClick={() => void onSend({ optionId: option.id })}
              value={option.id}
            >
              <span className="block text-sm">{option.label}</span>
              {option.description ? (
                <span className="block text-muted-foreground text-xs">{option.description}</span>
              ) : null}
            </QuestionOption>
          ))}
        </QuestionOptions>
      ) : null}
      {acceptsFreeform ? (
        <div className="relative">
          <QuestionInput
            aria-label="Answer"
            className="min-h-14 pr-12"
            placeholder={options.length > 0 ? "Or type an answer…" : "Type an answer…"}
          />
          {value.text.trim().length > 0 ? (
            <QuestionSubmit
              aria-label="Send answer"
              className="absolute right-2 bottom-2"
              size="icon-sm"
            >
              <ArrowRightIcon />
            </QuestionSubmit>
          ) : null}
        </div>
      ) : null}
    </Question>
  );
}

function SignIn({ part }: { readonly part: Extract<PendingRequest, { kind: "auth" }>["part"] }) {
  const challenge = part.authorization;
  return (
    <>
      <p className="font-medium text-sm">Connect {part.displayName}</p>
      <p className="text-muted-foreground text-sm">{challenge?.instructions ?? part.description}</p>
      {challenge?.userCode ? (
        <code className="block w-fit rounded-md bg-muted px-2 py-1 font-mono text-sm">
          {challenge.userCode}
        </code>
      ) : null}
      {challenge?.url ? (
        <Button asChild size="sm">
          <a href={challenge.url} rel="noreferrer" target="_blank">
            <ExternalLinkIcon className="size-4" />
            Sign in
          </a>
        </Button>
      ) : null}
    </>
  );
}
