"use client";

import type { Spec } from "@json-render/react";
import { signInEnding, type Interaction } from "eve/events";
import type { EveMessage, EveMessagePart, EveToolPart } from "eve/react";
import {
  CheckCircleIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  XCircleIcon,
} from "lucide-react";
import { Fragment, useState, type SubmitEvent } from "react";
import { z } from "zod";

import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning";
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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
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

import { renderToolCard } from "./tool-cards";
import { GeneratedUi, uiSpecSchema } from "./ui-registry";

/** A visitor's answer to an interaction. */
export interface AgentAnswer {
  /** The interaction being answered. */
  readonly interactionId: string;
  /** The chosen option, for a multiple-choice interaction. */
  readonly optionId?: string;
  /** The typed answer, for a free-form interaction. */
  readonly text?: string;
}

/** Submits answers; rejects when they fail to send, so the visitor can retry. */
type OnAnswers = (answers: readonly AgentAnswer[]) => Promise<void>;

/** Most input fields the approval card lists before summarizing the rest. */
const MAX_SUMMARY_ROWS = 4;

/**
 * Renders one chat message and each of its parts.
 *
 * @param props - The message, streaming state, and interaction handlers.
 * @returns The rendered message.
 */
export function AgentMessage({
  canRespond,
  isStreaming,
  message,
  onAnswers,
}: {
  /** Whether an interaction with this ID still accepts an answer. */
  readonly canRespond: (interactionId: string) => boolean;
  /** Whether this message is the one currently streaming. */
  readonly isStreaming: boolean;
  /** The message to render. */
  readonly message: EveMessage;
  /** Submits answers to questions and approvals. */
  readonly onAnswers: OnAnswers;
}) {
  const lastTextIndex = message.parts.findLastIndex(
    (part) => part.type === "text"
  );
  const hasAssistantText =
    message.role === "assistant" &&
    message.parts.some((part) => part.type === "text" && part.text.length > 0);

  return (
    <Message
      data-optimistic={message.metadata?.optimistic === true ? "true" : undefined}
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
              showCaret={
                isStreaming &&
                message.role === "assistant" &&
                index === lastTextIndex
              }
            />
          )
        )}
      </MessageContent>
    </Message>
  );
}

/** Renders one text, reasoning, interaction, or tool message part. */
function AgentMessagePart({
  canRespond,
  onAnswers,
  part,
  showCaret,
}: {
  readonly canRespond: (interactionId: string) => boolean;
  readonly onAnswers: OnAnswers;
  readonly part: EveMessagePart;
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
      return null;
    case "interaction":
      return (
        <InteractionPrompt
          canRespond={canRespond}
          interaction={part}
          onAnswers={onAnswers}
        />
      );
    case "tool": {
      const spec = renderUiSpec(part);
      if (spec === null) return null;
      if (spec !== undefined) return <GeneratedUi spec={spec} />;
      return <ToolPart canRespond={canRespond} onAnswers={onAnswers} part={part} />;
    }
    default:
      return null;
  }
}

/** Renders a custom tool card or the generic call display and its interaction. */
function ToolPart({
  canRespond,
  onAnswers,
  part,
}: {
  readonly canRespond: (interactionId: string) => boolean;
  readonly onAnswers: OnAnswers;
  readonly part: EveToolPart;
}) {
  const card = renderToolCard(part);

  return (
    <>
      {card ?? <GenericTool part={part} />}
      {part.interaction === undefined ? null : (
        <InteractionPrompt
          canRespond={canRespond}
          interaction={part.interaction}
          onAnswers={onAnswers}
        />
      )}
    </>
  );
}

/** Renders an uncarded tool in the standard collapsible tool interface. */
function GenericTool({ part }: { readonly part: EveToolPart }) {
  return (
    <Tool>
      <ToolHeader
        state={toolHeaderState(part.state)}
        title={part.label}
        toolName={part.name}
        type="dynamic-tool"
      />
      <ToolContent>
        {part.state === "streaming" ? (
          <pre className="overflow-x-auto text-xs whitespace-pre-wrap">
            {part.inputText}
          </pre>
        ) : part.name === "bash" ? (
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
  );
}

/** Maps eve's tool states to the status vocabulary used by the shared tool UI. */
function toolHeaderState(
  state: EveToolPart["state"]
):
  | "approval-requested"
  | "input-available"
  | "input-streaming"
  | "output-available"
  | "output-denied"
  | "output-error" {
  switch (state) {
    case "completed":
      return "output-available";
    case "rejected":
      return "output-denied";
    case "failed":
    case "cancelled":
      return "output-error";
    case "approval":
      return "approval-requested";
    case "requested":
    case "streaming":
      return "input-streaming";
    case "running":
    case "blocked":
      return "input-available";
  }
}

/** Resolves what a tool part shows as generated UI. */
function renderUiSpec(part: EveToolPart): Spec | null | undefined {
  if (part.name !== "render_ui") return undefined;
  if (part.state === "failed" || part.state === "rejected") return null;
  const parsed = uiSpecSchema.safeParse(part.input);
  return parsed.success ? parsed.data : undefined;
}

/** Renders the appropriate prompt for a standalone or tool-attached interaction. */
function InteractionPrompt({
  canRespond,
  interaction,
  onAnswers,
}: {
  readonly canRespond: (interactionId: string) => boolean;
  readonly interaction: Interaction;
  readonly onAnswers: OnAnswers;
}) {
  if (interaction.request.kind === "sign-in") {
    return <SignInPrompt interaction={interaction} />;
  }
  if (interaction.request.kind === "question") {
    return (
      <QuestionRequest
        canRespond={canRespond(interaction.interactionId)}
        interaction={interaction}
        onAnswers={onAnswers}
      />
    );
  }
  return (
    <InteractionActions
      canRespond={canRespond}
      interaction={interaction}
      onAnswers={onAnswers}
    />
  );
}

/** Renders a question and the locally projected answer while it is submitted. */
function QuestionRequest({
  canRespond,
  interaction,
  onAnswers,
}: {
  readonly canRespond: boolean;
  readonly interaction: Interaction;
  readonly onAnswers: OnAnswers;
}) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const options = interaction.request.options ?? [];
  const acceptsFreeform =
    interaction.request.allowFreeform === true || options.length === 0;
  const answer = interaction.answer;
  const isLocked = !canRespond || isSubmitting || answer !== undefined;

  if (answer !== undefined) {
    return <AnsweredQuestion answer={answer} interaction={interaction} />;
  }

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isLocked) return;
    const value = new FormData(event.currentTarget).get(interaction.interactionId);
    if (typeof value !== "string") return;
    const option = options.find(({ id }) => id === value);
    setIsSubmitting(true);
    try {
      await onAnswers([
        option === undefined
          ? { interactionId: interaction.interactionId, text: value.trim() }
          : { interactionId: interaction.interactionId, optionId: option.id },
      ]);
    } catch {
      // The chat shows the error; the form unlocks below for a retry.
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="border-info/30 bg-info/5 w-full max-w-md rounded-md border p-3">
      <Questionnaire
        className="gap-3"
        onSubmit={(event) => {
          void submit(event);
        }}
      >
        <QuestionnaireItem name={interaction.interactionId} required>
          <QuestionnaireTitle className="text-sm font-medium [&:not(:has(~[data-slot=questionnaire-description]))]:mb-3">
            {interaction.request.prompt}
          </QuestionnaireTitle>
          <QuestionnaireChoices className="gap-2">
            {options.map((option) => (
              <QuestionnaireChoice
                className="min-h-0 px-3 py-2"
                disabled={isLocked}
                key={option.id}
                value={option.id}
              >
                {option.label}
                {option.description === undefined ? null : (
                  <QuestionnaireChoiceDescription>
                    {option.description}
                  </QuestionnaireChoiceDescription>
                )}
              </QuestionnaireChoice>
            ))}
            {acceptsFreeform ? (
              <QuestionnaireInput
                aria-label="Answer"
                disabled={isLocked}
                placeholder="Type your answer…"
              />
            ) : null}
          </QuestionnaireChoices>
          <QuestionnaireError />
        </QuestionnaireItem>
        <QuestionnaireActions>
          <QuestionnaireSubmit disabled={isLocked} size="sm">
            Answer
          </QuestionnaireSubmit>
        </QuestionnaireActions>
      </Questionnaire>
    </div>
  );
}

/** Renders an answered question as a collapsible summary row. */
function AnsweredQuestion({
  answer,
  interaction,
}: {
  readonly answer: AgentAnswer;
  readonly interaction: Interaction;
}) {
  const options = interaction.request.options ?? [];
  const label =
    options.find(({ id }) => id === answer.optionId)?.label ??
    answer.text ??
    answer.optionId;

  return (
    <div className="w-full max-w-md rounded-md border text-sm">
      <Collapsible>
        <CollapsibleTrigger asChild>
          <button
            className="group text-muted-foreground flex w-full items-center gap-2 px-3 py-2 text-left"
            type="button"
          >
            <ChevronRightIcon className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
            <span className="text-foreground shrink-0 font-medium">{label}</span>
            <span className="truncate">{interaction.request.prompt}</span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-2 border-t px-3 py-2">
            <p className="font-medium">{interaction.request.prompt}</p>
            <ul className="space-y-1">
              {options.map((option) => (
                <li
                  className={cn(
                    "flex items-center gap-2",
                    option.id === answer.optionId
                      ? "text-foreground font-medium"
                      : "text-muted-foreground"
                  )}
                  key={option.id}
                >
                  {option.label}
                </li>
              ))}
            </ul>
            {answer.text === undefined ? null : (
              <blockquote className="border-l-2 pl-3">{answer.text}</blockquote>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

const scalar = z.union([z.string(), z.number(), z.boolean()]);
const inputSummary = z.record(z.string(), z.unknown()).transform((input) =>
  Object.entries(input).flatMap(([name, value]) => {
    const parsed = scalar.safeParse(value);
    return parsed.success ? [[name, String(parsed.data)] as const] : [];
  })
);

/** Renders approval actions and settled approval outcomes. */
function InteractionActions({
  canRespond,
  interaction,
  onAnswers,
}: {
  readonly canRespond: (interactionId: string) => boolean;
  readonly interaction: Interaction;
  readonly onAnswers: OnAnswers;
}) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const details =
    interaction.call?.input === undefined
      ? undefined
      : inputSummary.safeParse(interaction.call.input);

  const submit = async (optionId: string) => {
    if (
      isSubmitting ||
      interaction.answer !== undefined ||
      !canRespond(interaction.interactionId)
    ) {
      return;
    }
    setIsSubmitting(true);
    try {
      await onAnswers([{ interactionId: interaction.interactionId, optionId }]);
    } catch {
      // The chat shows the error; the options unlock below for a retry.
    } finally {
      setIsSubmitting(false);
    }
  };

  if (interaction.status === "settled") {
    const label = interactionOutcomeLabel(interaction.outcome);
    const approved = interaction.outcome === "accepted";
    const Icon = approved ? CheckCircleIcon : XCircleIcon;
    return (
      <div className="text-muted-foreground flex w-full max-w-md items-center gap-2 rounded-md border px-3 py-2 text-sm">
        <Icon
          className={cn(
            "size-4 shrink-0",
            approved
              ? "text-success"
              : interaction.outcome === "declined"
                ? "text-destructive"
                : "text-muted-foreground"
          )}
        />
        <span className="text-foreground font-medium">{label}</span>
        <span className="truncate">{interaction.call?.name}</span>
      </div>
    );
  }

  return (
    <div className="border-warning/30 bg-warning/5 w-full max-w-md space-y-3 rounded-md border p-3">
      <p className="text-sm font-medium">{interaction.request.prompt}</p>
      {interaction.answer !== undefined ? (
        <p className="text-muted-foreground text-sm" role="status">
          Response submitted. Waiting for confirmation.
        </p>
      ) : null}
      {details?.success ? (
        <dl className="bg-background/60 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-sm">
          {details.data.slice(0, MAX_SUMMARY_ROWS).map(([name, value]) => (
            <Fragment key={name}>
              <dt className="text-muted-foreground">{name}</dt>
              <dd className="truncate">{value}</dd>
            </Fragment>
          ))}
        </dl>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {interaction.request.options?.map((option, index) => (
          <Button
            disabled={
              isSubmitting ||
              interaction.answer !== undefined ||
              !canRespond(interaction.interactionId)
            }
            key={option.id}
            onClick={() => {
              void submit(option.id);
            }}
            size="sm"
            type="button"
            variant={optionVariant(option.style, index)}
          >
            {option.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

/** Returns a readable label for a terminal interaction outcome. */
function interactionOutcomeLabel(outcome: Interaction["outcome"]): string {
  switch (outcome) {
    case "accepted":
      return "Approved";
    case "declined":
      return "Declined";
    case "invalid":
      return "Invalid response";
    case "failed":
      return "Failed";
    case "withdrawn":
      return "Withdrawn";
    case "interrupted":
      return "Interrupted";
    case "abandoned":
      return "Abandoned";
    case "expired":
      return "Expired";
    default:
      return "Ended";
  }
}

/** Renders a sign-in challenge or its specific terminal outcome. */
function SignInPrompt({ interaction }: { readonly interaction: Interaction }) {
  const signIn = interaction.request.signIn;
  const name = signIn?.displayName ?? signIn?.name ?? "the service";
  const complete = interaction.status === "settled";

  return (
    <div className="border-info/30 bg-info/5 w-full max-w-md space-y-3 rounded-md border p-3">
      <p className="text-sm font-medium">
        {complete
          ? `${name} ${signInEnding(interaction.outcome ?? "failed")}`
          : `Connect ${name}`}
      </p>
      <p className="text-muted-foreground text-sm">
        {complete ? interaction.reason : interaction.request.prompt}
      </p>
      {!complete && signIn?.instructions ? (
        <p className="text-muted-foreground text-sm">{signIn.instructions}</p>
      ) : null}
      {!complete && signIn?.userCode ? (
        <code className="font-mono">Code: {signIn.userCode}</code>
      ) : null}
      {!complete && signIn?.url ? (
        <Button asChild size="sm">
          <a href={signIn.url} rel="noreferrer" target="_blank">
            <ExternalLinkIcon className="size-4" />
            Sign in with {name}
          </a>
        </Button>
      ) : null}
    </div>
  );
}

/** Chooses a consistent visual treatment for an interaction option. */
function optionVariant(
  style: "danger" | "default" | "primary" | undefined,
  index: number
): "default" | "destructive" | "outline" {
  if (style === "danger") return "destructive";
  return style === "primary" || index === 0 ? "default" : "outline";
}

/** Builds a stable React key for a message part. */
function partKey(part: EveMessagePart, index: number): string {
  if (part.type === "tool") return part.callId;
  if (part.type === "interaction") return `interaction:${part.interactionId}`;
  if (part.type === "text" || part.type === "reasoning") {
    return `${part.type}:${part.id ?? index}`;
  }
  return `${part.type}:${index}`;
}
