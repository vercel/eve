"use client";

import type {
  AskedInteraction,
  ConversationInteraction,
  EveInteractionPart,
  EveMessage,
  EveMessagePart,
  EveToolPart,
} from "eve/react";
import { signInEnding } from "eve/react";
import type { FormEvent } from "react";
import {
  CheckCircleIcon,
  ExternalLinkIcon,
  FileIcon,
  ImageIcon,
  KeyRoundIcon,
  XCircleIcon,
} from "lucide-react";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning";
import {
  BashToolContent,
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@/components/ai-elements/tool";
import { Button } from "@/components/ui/button";
import {
  Questionnaire,
  QuestionnaireActions,
  QuestionnaireChoice,
  QuestionnaireChoiceDescription,
  QuestionnaireChoices,
  QuestionnaireError,
  QuestionnaireInput,
  QuestionnaireItem,
  QuestionnaireSubmit,
  QuestionnaireTitle,
} from "@/components/ui/questionnaire";
import { cn } from "@/lib/utils";

export type AgentAnswer = {
  readonly optionId?: string;
  readonly interactionId: string;
  readonly text?: string;
};

type EveFilePart = Extract<EveMessagePart, { type: "file" }>;

export function AgentMessage({
  canRespond,
  isStreaming,
  message,
  onAnswers,
  questionsFor,
}: {
  readonly canRespond: (interactionId: string) => boolean;
  readonly isStreaming: boolean;
  readonly message: EveMessage;
  readonly onAnswers: (responses: readonly AgentAnswer[]) => void | Promise<void>;
  readonly questionsFor: (callId: string) => readonly ConversationInteraction[];
}) {
  const lastTextIndex = message.parts.reduce(
    (last, part, index) => (part.type === "text" ? index : last),
    -1,
  );
  const hasAssistantText =
    message.role === "assistant" &&
    message.parts.some((part) => part.type === "text" && part.text.length > 0);

  return (
    <Message
      data-optimistic={message.metadata?.optimistic ? "true" : undefined}
      from={message.role}
    >
      <MessageContent>
        {message.parts.map((part, index) =>
          hasAssistantText && part.type === "reasoning" ? null : (
            <AgentMessagePart
              canRespond={canRespond}
              key={partKey(part, index)}
              onAnswers={onAnswers}
              part={part}
              questionsFor={questionsFor}
              showCaret={isStreaming && message.role === "assistant" && index === lastTextIndex}
            />
          ),
        )}
      </MessageContent>
    </Message>
  );
}

function AgentMessagePart({
  canRespond,
  onAnswers,
  part,
  questionsFor,
  showCaret,
}: {
  readonly canRespond: (interactionId: string) => boolean;
  readonly onAnswers: (responses: readonly AgentAnswer[]) => void | Promise<void>;
  readonly part: EveMessagePart;
  readonly questionsFor: (callId: string) => readonly ConversationInteraction[];
  readonly showCaret: boolean;
}) {
  switch (part.type) {
    case "text":
      return (
        <MessageResponse caret="block" isAnimating={showCaret}>
          {part.text}
        </MessageResponse>
      );
    case "reasoning":
      return (
        <Reasoning defaultOpen isStreaming={part.state === "streaming"}>
          <ReasoningTrigger />
          <ReasoningContent>{part.text}</ReasoningContent>
        </Reasoning>
      );
    case "file":
      return <AttachmentPart part={part} />;
    case "interaction":
      return <InteractionPrompt canRespond={canRespond} onAnswers={onAnswers} part={part} />;
    case "tool": {
      // The model waiting on or cancelling its own tasks isn't activity to show.
      if (part.kind === "control") return null;
      const questions = questionsFor(part.callId);
      if (questions.length > 0) {
        return (
          <div className="space-y-4">
            {questions.map(({ request, answer }) => (
              <QuestionRequest
                canRespond={canRespond(request.interactionId)}
                interaction={request}
                answer={answer}
                key={request.interactionId}
                onAnswers={onAnswers}
              />
            ))}
          </div>
        );
      }

      return (
        <>
          <Tool>
            <ToolHeader
              failed={part.outcome === "failed"}
              status={toolStatus(part)}
              title={part.label}
              toolName={part.name}
            />
            <ToolContent>
              {part.name === "bash" ? (
                <BashToolContent
                  errorText={part.error?.message}
                  input={part.input}
                  output={part.output}
                />
              ) : (
                <>
                  <ToolInput input={part.input} />
                  <ToolOutput errorText={part.error?.message} output={part.output} />
                </>
              )}
            </ToolContent>
          </Tool>
          {/* Kept outside the collapsed card so a pending approval is always visible. */}
          <ApprovalActions canRespond={canRespond} part={part} onAnswers={onAnswers} />
        </>
      );
    }
  }
}

function QuestionRequest({
  canRespond,
  interaction,
  answer,
  onAnswers,
}: {
  readonly canRespond: boolean;
  readonly interaction: AskedInteraction;
  readonly answer?: AgentAnswer;
  readonly onAnswers: (responses: readonly AgentAnswer[]) => void | Promise<void>;
}) {
  const options = interaction.options ?? [];
  const acceptsFreeform = interaction.allowFreeform === true || options.length === 0;
  const disabled = !canRespond || answer !== undefined;

  const submitResponse = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get(interaction.interactionId);
    if (typeof value !== "string") {
      return;
    }

    const option = options.find(({ id }) => id === value);
    void onAnswers([
      option === undefined
        ? { interactionId: interaction.interactionId, text: value.trim() }
        : { optionId: option.id, interactionId: interaction.interactionId },
    ]);
  };

  return (
    <Questionnaire
      className="gap-4 rounded-xl border bg-card p-4"
      // Validation reads disabled answers as missing, so locking a submitted form in place would
      // flag it invalid. Remounting restores the answer from the response instead.
      key={disabled ? "locked" : "open"}
      onSubmit={submitResponse}
      shortcuts="numbers"
    >
      <QuestionnaireItem name={interaction.interactionId} required>
        <QuestionnaireTitle className="text-sm font-medium">
          {interaction.prompt}
        </QuestionnaireTitle>
        <QuestionnaireChoices>
          {options.map((option) => (
            <QuestionnaireChoice
              className={cn(answer?.optionId === option.id && "data-disabled:opacity-100")}
              defaultChecked={answer?.optionId === option.id}
              disabled={disabled}
              key={option.id}
              value={option.id}
            >
              {option.label}
              {option.description ? (
                <QuestionnaireChoiceDescription>
                  {option.description}
                </QuestionnaireChoiceDescription>
              ) : null}
            </QuestionnaireChoice>
          ))}
          {acceptsFreeform ? (
            <QuestionnaireInput
              aria-label="Answer"
              className={cn(answer?.text !== undefined && "disabled:opacity-100")}
              defaultValue={answer?.text}
              disabled={disabled}
              placeholder="Type your answer…"
            />
          ) : null}
        </QuestionnaireChoices>
        <QuestionnaireError />
      </QuestionnaireItem>
      {disabled ? null : (
        <QuestionnaireActions>
          <QuestionnaireSubmit size="sm">Answer</QuestionnaireSubmit>
        </QuestionnaireActions>
      )}
    </Questionnaire>
  );
}

function AttachmentPart({ part }: { readonly part: EveFilePart }) {
  const label = part.filename ?? "Attachment";
  const detail = [part.mediaType, formatBytes(part.size)].filter(Boolean).join(" - ");
  const isImage = part.mediaType.startsWith("image/") && part.url !== undefined;
  const Icon = isImage ? ImageIcon : FileIcon;
  const body = (
    <span className="flex max-w-sm items-center gap-3 rounded-md border bg-background/60 p-2 text-sm">
      {isImage ? (
        <img alt={label} className="size-12 shrink-0 rounded-sm object-cover" src={part.url} />
      ) : (
        <span className="flex size-10 shrink-0 items-center justify-center rounded-sm bg-muted text-muted-foreground">
          <Icon className="size-4" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{label}</span>
        {detail ? <span className="block truncate text-muted-foreground">{detail}</span> : null}
      </span>
      {part.url ? <ExternalLinkIcon className="size-4 shrink-0 text-muted-foreground" /> : null}
    </span>
  );

  return part.url ? (
    <a href={part.url} rel="noreferrer" target="_blank">
      {body}
    </a>
  ) : (
    body
  );
}

/** An interaction no call carries: a sign-in, the budget prompt, or a question of its own. */
function InteractionPrompt({
  canRespond,
  onAnswers,
  part,
}: {
  readonly canRespond: (interactionId: string) => boolean;
  readonly onAnswers: (answers: readonly AgentAnswer[]) => void | Promise<void>;
  readonly part: EveInteractionPart;
}) {
  const { request } = part;
  if (request.signIn !== undefined) return <SignInPrompt part={part} />;
  if (request.kind === "question") {
    return (
      <QuestionRequest
        answer={part.answer}
        canRespond={canRespond(request.interactionId)}
        interaction={request}
        onAnswers={onAnswers}
      />
    );
  }
  return (
    <InteractionActions
      answer={part.answer}
      canRespond={canRespond}
      interaction={request}
      onAnswers={onAnswers}
    />
  );
}

function SignInPrompt({ part }: { readonly part: EveInteractionPart }) {
  const signIn = part.request.signIn;
  const name = signIn?.displayName ?? signIn?.name ?? "the service";
  const isAuthorized = part.outcome === "accepted";
  const isCompleted = part.status === "settled";
  const Icon = isAuthorized ? CheckCircleIcon : isCompleted ? XCircleIcon : KeyRoundIcon;
  const instructions = signIn?.instructions;
  const description = isCompleted
    ? isAuthorized
      ? `${name} connected.`
      : `${name} authorization ${signInEnding(part.outcome ?? "withdrawn")}${
          part.reason !== undefined ? ` (${part.reason})` : ""
        }.`
    : part.request.prompt;

  return (
    <div
      className={cn(
        "space-y-3 rounded-md border p-3",
        isAuthorized
          ? "border-emerald-500/30 bg-emerald-500/5"
          : isCompleted
            ? "border-destructive/30 bg-destructive/5"
            : "border-blue-500/30 bg-blue-500/5",
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full",
            isAuthorized
              ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
              : isCompleted
                ? "bg-destructive/10 text-destructive"
                : "bg-blue-500/10 text-blue-700 dark:text-blue-300",
          )}
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          <p className="font-medium text-sm">
            {isCompleted
              ? isAuthorized
                ? `${name} connected`
                : `${name} authorization ${signInEnding(part.outcome ?? "withdrawn")}`
              : `Connect ${name}`}
          </p>
          <p className="text-muted-foreground text-sm">{description}</p>
          {!isCompleted && instructions !== undefined && instructions !== description ? (
            <p className="text-muted-foreground text-sm">{instructions}</p>
          ) : null}
          {!isCompleted && signIn?.userCode ? (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted-foreground">Code</span>
              <code className="rounded-md bg-background px-2 py-1 font-mono">
                {signIn.userCode}
              </code>
            </div>
          ) : null}
          {!isCompleted && signIn?.url ? (
            <Button asChild size="sm">
              <a href={signIn.url} rel="noreferrer" target="_blank">
                <ExternalLinkIcon className="size-4" />
                Sign in with {name}
              </a>
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function formatBytes(size: number | undefined): string | undefined {
  if (size === undefined) {
    return undefined;
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function ApprovalActions({
  canRespond,
  onAnswers,
  part,
}: {
  readonly canRespond: (interactionId: string) => boolean;
  readonly onAnswers: (answers: readonly AgentAnswer[]) => void | Promise<void>;
  readonly part: EveToolPart;
}) {
  const interaction = part.interaction;
  if (interaction?.request.kind !== "approval") {
    return null;
  }
  // An approval can settle without an answer, such as when its turn is cancelled.
  const decision =
    interaction.status !== "settled"
      ? undefined
      : interaction.outcome === "accepted"
        ? "Approved"
        : interaction.outcome === "declined"
          ? "Denied"
          : "Cancelled";
  return (
    <InteractionActions
      answer={interaction.answer}
      canRespond={canRespond}
      decision={decision}
      interaction={interaction.request}
      onAnswers={onAnswers}
    />
  );
}

/** How a call reads in its header, from its row; nothing once it completed. */
function toolStatus(part: EveToolPart): string | undefined {
  if (part.status === "streaming") return "Pending";
  if (part.interaction?.request.kind === "approval" && part.interaction.status !== "settled")
    return "Awaiting Approval";
  if (part.status !== "settled") return "Running";
  switch (part.outcome) {
    case "completed":
      return undefined;
    case "rejected":
      return "Denied";
    case "interrupted":
      return "Cancelled";
    default:
      return "Error";
  }
}

/** An interaction's prompt with a button for each option, or how it was answered. */
function InteractionActions({
  answer,
  canRespond,
  decision,
  interaction,
  onAnswers,
}: {
  readonly answer?: AgentAnswer;
  readonly canRespond: (interactionId: string) => boolean;
  readonly decision?: string;
  readonly interaction: AskedInteraction;
  readonly onAnswers: (answers: readonly AgentAnswer[]) => void | Promise<void>;
}) {
  const selectedOption = interaction.options?.find((option) => option.id === answer?.optionId);
  const settledApproval = decision;

  return (
    <div className="space-y-3 rounded-md border border-yellow-500/30 bg-yellow-500/5 p-3">
      <p className="text-muted-foreground text-sm">{interaction.prompt}</p>
      {answer || settledApproval ? (
        <p className="font-medium text-sm">
          Responded: {selectedOption?.label ?? answer?.text ?? answer?.optionId ?? settledApproval}
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {interaction.options?.map((option) => (
            <Button
              disabled={!canRespond(interaction.interactionId)}
              key={option.id}
              onClick={() => {
                void onAnswers([
                  {
                    optionId: option.id,
                    interactionId: interaction.interactionId,
                  },
                ]);
              }}
              size="sm"
              type="button"
              variant={option.style === "danger" ? "destructive" : "default"}
            >
              {option.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

function partKey(part: EveMessagePart, index: number): string {
  switch (part.type) {
    case "interaction":
      return `interaction:${part.request.interactionId}`;
    case "tool":
      return part.callId;
    case "reasoning":
    case "text":
      return `${part.type}:${part.id ?? index}`;
    default:
      return `${part.type}:${index}`;
  }
}
