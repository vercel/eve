import type { Spec } from "@json-render/react";
import type {
  ConversationInput,
  EveAuthorizationPart,
  EveDynamicToolPart,
  EveMessage,
  EveMessageInputRequest,
  EveMessagePart,
} from "eve/react";
import {
  CheckCircleIcon,
  ChevronRightIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileIcon,
  ImageIcon,
  XCircleIcon,
} from "lucide-react";
import { Fragment, useState } from "react";
import type { SubmitEvent } from "react";
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

import { GeneratedUi, uiSpecSchema } from "./ui-registry";

/** A visitor's answer to a question or approval request. */
export interface AgentInputResponse {
  /** The chosen option, for a multiple-choice request. */
  readonly optionId?: string;
  /** The request being answered. */
  readonly requestId: string;
  /** The typed answer, for a free-form request. */
  readonly text?: string;
}

type EveFilePart = Extract<EveMessagePart, { type: "file" }>;
type AuthorizationOutcome = NonNullable<EveAuthorizationPart["outcome"]>;
type OnInputResponses = (
  responses: readonly AgentInputResponse[]
) => void | Promise<void>;

const AUTHORIZATION_OUTCOME_LABEL: Record<AuthorizationOutcome, string> = {
  authorized: "Connected",
  declined: "Declined",
  failed: "Failed",
  "timed-out": "Timed out",
};

/**
 * Renders one chat message and each of its parts.
 *
 * @param props - The component props.
 * @returns The message.
 */
export function AgentMessage({
  canRespond,
  isStreaming,
  message,
  onInputResponses,
  questionsFor,
}: {
  /** Whether the request with this ID still accepts an answer. */
  readonly canRespond: (requestId: string) => boolean;
  /** Whether this message is the one currently streaming. */
  readonly isStreaming: boolean;
  /** The message to render. */
  readonly message: EveMessage;
  /** Submits answers to questions and approvals. */
  readonly onInputResponses: OnInputResponses;
  /** Returns every question the tool call with this ID asked. */
  readonly questionsFor: (callId: string) => readonly ConversationInput[];
}) {
  const lastTextIndex = message.parts.findLastIndex(
    (part) => part.type === "text"
  );
  const hasAssistantText =
    message.role === "assistant" &&
    message.parts.some((part) => part.type === "text" && part.text.length > 0);

  return (
    <Message
      data-optimistic={
        message.metadata?.optimistic === true ? "true" : undefined
      }
      from={message.role}
    >
      <MessageContent>
        {message.parts.map((part, index) =>
          hasAssistantText && part.type === "reasoning" ? null : (
            <AgentMessagePart
              canRespond={canRespond}
              key={partKey(part, index)}
              onInputResponses={onInputResponses}
              part={part}
              questionsFor={questionsFor}
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

/**
 * Renders one message part: text, reasoning, an attachment, an authorization
 * prompt, a tool call, or the questions a tool call asked.
 *
 * @param props - The component props.
 * @returns The rendered part, or `null` for parts with nothing to show.
 */
function AgentMessagePart({
  canRespond,
  onInputResponses,
  part,
  questionsFor,
  showCaret,
}: {
  /** Whether the request with this ID still accepts an answer. */
  readonly canRespond: (requestId: string) => boolean;
  /** Submits answers to questions and approvals. */
  readonly onInputResponses: OnInputResponses;
  /** The part to render. */
  readonly part: EveMessagePart;
  /** Returns every question the tool call with this ID asked. */
  readonly questionsFor: (callId: string) => readonly ConversationInput[];
  /** Whether to show the streaming caret after this text part. */
  readonly showCaret: boolean;
}) {
  switch (part.type) {
    case "step-start": {
      return null;
    }
    case "text": {
      return (
        <MessageResponse caret="block" isAnimating={showCaret}>
          {part.text}
        </MessageResponse>
      );
    }
    case "reasoning": {
      return (
        <Reasoning defaultOpen isStreaming={part.state === "streaming"}>
          <ReasoningTrigger />
          <ReasoningContent>{part.text}</ReasoningContent>
        </Reasoning>
      );
    }
    case "file": {
      return <AttachmentPart part={part} />;
    }
    case "authorization": {
      return <AuthorizationPrompt part={part} />;
    }
    case "dynamic-tool": {
      const questions = questionsFor(part.toolCallId);
      const inputRequest = part.toolMetadata?.eve?.inputRequest;
      const spec = renderUiSpec(part);
      if (spec === null) {
        return null;
      }
      if (spec !== undefined) {
        return <GeneratedUi spec={spec} />;
      }
      if (questions.length > 0) {
        return (
          <div className="space-y-4">
            {questions.map(({ request, response }) => (
              <QuestionRequest
                canRespond={canRespond(request.requestId)}
                inputRequest={request}
                inputResponse={response}
                key={request.requestId}
                onInputResponses={onInputResponses}
              />
            ))}
          </div>
        );
      }

      return (
        <>
          <Tool>
            <ToolHeader
              state={part.state}
              title={part.toolMetadata?.eve?.label ?? part.toolName}
              toolName={part.toolName}
              type="dynamic-tool"
            />
            <ToolContent>
              {part.toolName === "bash" ? (
                <BashToolContent
                  errorText={part.errorText}
                  input={part.input}
                  output={part.output}
                />
              ) : (
                <>
                  <ToolInput input={part.input} />
                  <ToolOutput errorText={part.errorText} output={part.output} />
                </>
              )}
            </ToolContent>
          </Tool>
          {inputRequest === undefined ? null : (
            <InputRequestActions
              canRespond={canRespond}
              part={part}
              onInputResponses={onInputResponses}
            />
          )}
        </>
      );
    }
    default: {
      return null;
    }
  }
}

/**
 * Resolves what a tool part shows as generated UI.
 *
 * @param part - The tool call part.
 * @returns The spec to render, `null` to hide a rejected `render_ui` call, or
 * `undefined` for other tools and for input that is still streaming in.
 */
function renderUiSpec(part: EveDynamicToolPart): Spec | null | undefined {
  if (part.toolName !== "render_ui") {
    return undefined;
  }
  if (part.state === "output-error") {
    return null;
  }
  const parsed = uiSpecSchema.safeParse(part.input);
  return parsed.success ? parsed.data : undefined;
}

/**
 * A question from the agent, answered by choosing an option or typing a reply,
 * then shown as a compact row with the answer.
 *
 * @param props - The component props.
 * @returns The question form, or the answer once given.
 */
function QuestionRequest({
  canRespond,
  inputRequest,
  inputResponse,
  onInputResponses,
}: {
  /** Whether the question still accepts an answer. */
  readonly canRespond: boolean;
  /** The question. */
  readonly inputRequest: EveMessageInputRequest;
  /** The submitted answer, once there is one. */
  readonly inputResponse?: AgentInputResponse;
  /** Submits the answer. */
  readonly onInputResponses: OnInputResponses;
}) {
  const [submittedResponse, setSubmittedResponse] =
    useState<AgentInputResponse>();
  const options = inputRequest.options ?? [];
  const acceptsFreeform =
    inputRequest.allowFreeform === true || options.length === 0;
  const answeredResponse =
    inputResponse ?? (canRespond ? undefined : submittedResponse);

  if (answeredResponse !== undefined) {
    return (
      <AnsweredQuestion
        inputRequest={inputRequest}
        inputResponse={answeredResponse}
      />
    );
  }

  const submitResponse = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const answer = new FormData(event.currentTarget).get(
      inputRequest.requestId
    );
    if (answer === null || answer instanceof File) {
      return;
    }

    const option = options.find(({ id }) => id === answer);
    const response: AgentInputResponse =
      option === undefined
        ? { requestId: inputRequest.requestId, text: answer.trim() }
        : { optionId: option.id, requestId: inputRequest.requestId };
    setSubmittedResponse(response);
    void onInputResponses([response]);
  };

  return (
    <div className="border-info/30 bg-info/5 w-full max-w-md rounded-md border p-3">
      <Questionnaire className="gap-3" onSubmit={submitResponse}>
        <QuestionnaireItem name={inputRequest.requestId} required>
          <QuestionnaireTitle className="text-sm font-medium [&:not(:has(~[data-slot=questionnaire-description]))]:mb-3">
            {inputRequest.prompt}
          </QuestionnaireTitle>
          <QuestionnaireChoices className="gap-2">
            {options.map((option) => (
              <QuestionnaireChoice
                className="min-h-0 px-3 py-2"
                disabled={!canRespond}
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
                disabled={!canRespond}
                placeholder="Type your answer…"
              />
            ) : null}
          </QuestionnaireChoices>
          <QuestionnaireError />
        </QuestionnaireItem>
        <QuestionnaireActions>
          <QuestionnaireSubmit disabled={!canRespond} size="sm">
            Answer
          </QuestionnaireSubmit>
        </QuestionnaireActions>
      </Questionnaire>
    </div>
  );
}

/**
 * An answered question: a row with the answer that expands to show the full
 * question and every option, with the chosen one highlighted.
 *
 * @param props - The component props.
 * @returns The collapsible answer.
 */
function AnsweredQuestion({
  inputRequest,
  inputResponse,
}: {
  /** The question. */
  readonly inputRequest: EveMessageInputRequest;
  /** The submitted answer. */
  readonly inputResponse: AgentInputResponse;
}) {
  const options = inputRequest.options ?? [];
  const answer =
    options.find(({ id }) => id === inputResponse.optionId)?.label ??
    inputResponse.text ??
    inputResponse.optionId;

  return (
    <div className="w-full max-w-md rounded-md border text-sm">
      <Collapsible>
        <CollapsibleTrigger asChild>
          <button
            className="group text-muted-foreground flex w-full items-center gap-2 px-3 py-2 text-left"
            type="button"
          >
            <ChevronRightIcon className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
            <span className="text-foreground shrink-0 font-medium">
              {answer}
            </span>
            <span className="truncate">{inputRequest.prompt}</span>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="space-y-2 border-t px-3 py-2">
            <p className="font-medium">{inputRequest.prompt}</p>
            <ul className="space-y-1">
              {options.map((option) => {
                const isChosen = option.id === inputResponse.optionId;
                return (
                  <li
                    className={cn(
                      "flex items-center gap-2",
                      isChosen
                        ? "text-foreground font-medium"
                        : "text-muted-foreground"
                    )}
                    key={option.id}
                  >
                    {isChosen ? (
                      <span className="border-primary bg-primary flex size-4 shrink-0 items-center justify-center rounded-full border">
                        <span className="bg-primary-foreground size-1.5 rounded-full" />
                      </span>
                    ) : (
                      <span className="border-input size-4 shrink-0 rounded-full border" />
                    )}
                    {option.label}
                  </li>
                );
              })}
            </ul>
            {inputResponse.text === undefined ? null : (
              <blockquote className="border-l-2 pl-3">
                {inputResponse.text}
              </blockquote>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

/**
 * A file attached to a message, with an image preview when possible.
 *
 * @param props - The component props.
 * @returns The attachment, linked when it has a URL.
 */
function AttachmentPart({
  part,
}: {
  /** The file part. */
  readonly part: EveFilePart;
}) {
  const label = part.filename ?? "Attachment";
  const detail = [part.mediaType, formatBytes(part.size)]
    .filter(Boolean)
    .join(" - ");
  const isImage = part.mediaType.startsWith("image/") && part.url !== undefined;
  const Icon = isImage ? ImageIcon : FileIcon;
  const isDataUrl = part.url?.startsWith("data:") === true;
  const LinkIcon = isDataUrl ? DownloadIcon : ExternalLinkIcon;
  const body = (
    <span className="bg-background/60 flex max-w-sm items-center gap-3 rounded-md border p-2 text-sm">
      {isImage ? (
        <img
          alt={label}
          className="size-12 shrink-0 rounded-sm object-cover"
          src={part.url}
        />
      ) : (
        <span className="bg-muted text-muted-foreground flex size-10 shrink-0 items-center justify-center rounded-sm">
          <Icon className="size-4" />
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium">{label}</span>
        {detail.length > 0 ? (
          <span className="text-muted-foreground block truncate">{detail}</span>
        ) : null}
      </span>
      {part.url === undefined ? null : (
        <LinkIcon className="text-muted-foreground size-4 shrink-0" />
      )}
    </span>
  );

  if (part.url === undefined) {
    return body;
  }
  return isDataUrl ? (
    <a download={part.filename ?? "attachment"} href={part.url}>
      {body}
    </a>
  ) : (
    <a href={part.url} rel="noreferrer" target="_blank">
      {body}
    </a>
  );
}

/**
 * Asks the visitor to sign in to a connection, then shows the outcome.
 *
 * @param props - The component props.
 * @returns The authorization card.
 */
function AuthorizationPrompt({
  part,
}: {
  /** The authorization part. */
  readonly part: EveAuthorizationPart;
}) {
  if (part.state === "completed") {
    const authorized = part.outcome === "authorized";
    const Icon = authorized ? CheckCircleIcon : XCircleIcon;
    return (
      <div className="text-muted-foreground flex w-full max-w-md items-center gap-2 rounded-md border px-3 py-2 text-sm">
        <Icon
          className={cn(
            "size-4 shrink-0",
            authorized ? "text-success" : "text-destructive"
          )}
        />
        <span className="text-foreground font-medium">
          {AUTHORIZATION_OUTCOME_LABEL[part.outcome]}
        </span>
        <span className="truncate">
          {part.reason === undefined
            ? part.displayName
            : `${part.displayName} (${part.reason})`}
        </span>
      </div>
    );
  }

  const instructions = part.authorization?.instructions;
  const userCode = part.authorization?.userCode;
  const signInUrl = part.authorization?.url;

  return (
    <div className="border-info/30 bg-info/5 w-full max-w-md space-y-3 rounded-md border p-3">
      <div className="space-y-1">
        <p className="text-sm font-medium">Connect {part.displayName}</p>
        <p className="text-muted-foreground text-sm">{part.description}</p>
        {instructions === undefined ||
        instructions === part.description ? null : (
          <p className="text-muted-foreground text-sm">{instructions}</p>
        )}
      </div>
      {userCode === undefined ? null : (
        <div className="bg-background/60 flex items-center gap-3 rounded-md border px-3 py-2 text-sm">
          <span className="text-muted-foreground">Code</span>
          <code className="font-mono">{userCode}</code>
        </div>
      )}
      {signInUrl === undefined ? null : (
        <Button asChild size="sm">
          <a href={signInUrl} rel="noreferrer" target="_blank">
            <ExternalLinkIcon className="size-4" />
            Sign in with {part.displayName}
          </a>
        </Button>
      )}
    </div>
  );
}

/**
 * Formats a byte count for display.
 *
 * @param size - Size in bytes, if known.
 * @returns A string such as "1.5 KB", or `undefined` when the size is unknown.
 */
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

/** Most input fields the approval card lists before summarizing the rest. */
const MAX_SUMMARY_ROWS = 4;

const summaryValueSchema = z.union([z.string(), z.number(), z.boolean()]);

/**
 * Parses a tool input into its top-level scalar fields, so the visitor can see
 * what they are approving without opening the tool card. Nested values are left out.
 */
const inputSummarySchema = z
  .record(z.string(), z.unknown())
  .transform((input) =>
    Object.entries(input).flatMap(([name, value]) => {
      const scalar = summaryValueSchema.safeParse(value);
      return scalar.success
        ? [
            [
              `${name.charAt(0).toUpperCase()}${name.slice(1)}`,
              String(scalar.data),
            ] as const,
          ]
        : [];
    })
  );

/**
 * Resolves a settled request to the text shown in place of its buttons.
 *
 * @param part - The tool call part.
 * @param inputRequest - The request.
 * @param inputResponse - The visitor's answer, if recorded.
 * @returns The outcome, or `undefined` while the request is open.
 */
function settledOutcome(
  part: EveDynamicToolPart,
  inputRequest: EveMessageInputRequest,
  inputResponse: AgentInputResponse | undefined
):
  | { readonly approved: boolean | undefined; readonly label: string }
  | undefined {
  const options = inputRequest.options ?? [];
  if (inputRequest.kind === "tool-approval") {
    const approved =
      part.approval?.approved ??
      (inputResponse?.optionId === undefined
        ? undefined
        : inputResponse.optionId === "approve");
    if (approved === undefined) {
      return undefined;
    }
    return { approved, label: approved ? "Approved" : "Cancelled" };
  }
  if (inputResponse === undefined) {
    return undefined;
  }
  const selected = options.find(({ id }) => id === inputResponse.optionId);
  return {
    approved: undefined,
    label:
      selected?.label ?? inputResponse.text ?? inputResponse.optionId ?? "",
  };
}

/**
 * Asks the visitor to approve a tool call, showing what the call will do, then
 * shows the decision once made.
 *
 * @param props - The component props.
 * @returns The approval card, or `null` when the tool call asks for nothing.
 */
function InputRequestActions({
  canRespond,
  onInputResponses,
  part,
}: {
  /** Whether the request with this ID still accepts an answer. */
  readonly canRespond: (requestId: string) => boolean;
  /** Submits the chosen option. */
  readonly onInputResponses: OnInputResponses;
  /** The tool call part. */
  readonly part: EveDynamicToolPart;
}) {
  const eve = part.toolMetadata?.eve;
  const inputRequest = eve?.inputRequest;
  if (inputRequest === undefined) {
    return null;
  }

  const isApproval = inputRequest.kind === "tool-approval";
  const outcome = settledOutcome(part, inputRequest, eve?.inputResponse);
  const summary = inputSummarySchema.safeParse(part.input);
  const details = isApproval && summary.success ? summary.data : [];

  if (outcome !== undefined) {
    const Icon = outcome.approved === false ? XCircleIcon : CheckCircleIcon;
    return (
      <div className="text-muted-foreground flex w-full max-w-md items-center gap-2 rounded-md border px-3 py-2 text-sm">
        <Icon
          className={cn(
            "size-4 shrink-0",
            outcome.approved === false ? "text-destructive" : "text-success"
          )}
        />
        <span className="text-foreground font-medium">{outcome.label}</span>
        {isApproval ? (
          <span className="truncate">{eve?.label ?? part.toolName}</span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="border-warning/30 bg-warning/5 w-full max-w-md space-y-3 rounded-md border p-3">
      <div className="space-y-1">
        <p className="text-sm font-medium">
          {isApproval ? (eve?.label ?? part.toolName) : inputRequest.prompt}
        </p>
        {isApproval ? (
          <p className="text-muted-foreground text-sm">
            Review the details before approving.
          </p>
        ) : null}
      </div>
      {details.length > 0 ? (
        <dl className="bg-background/60 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-sm">
          {details.slice(0, MAX_SUMMARY_ROWS).map(([name, value]) => (
            <Fragment key={name}>
              <dt className="text-muted-foreground">{name}</dt>
              <dd className="truncate">{value}</dd>
            </Fragment>
          ))}
          {details.length > MAX_SUMMARY_ROWS ? (
            <dd className="text-muted-foreground col-span-2">
              +{details.length - MAX_SUMMARY_ROWS} more in the tool details
            </dd>
          ) : null}
        </dl>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {inputRequest.options?.map((option, index) => (
          <Button
            disabled={!canRespond(inputRequest.requestId)}
            key={option.id}
            onClick={() => {
              void onInputResponses([
                {
                  optionId: option.id,
                  requestId: inputRequest.requestId,
                },
              ]);
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

/**
 * Picks the button variant for an approval option.
 *
 * @param style - The option's style, if eve set one.
 * @param index - The option's position; the first option is the primary action.
 * @returns The button variant.
 */
function optionVariant(
  style: "danger" | "default" | "primary" | undefined,
  index: number
): "default" | "destructive" | "outline" {
  if (style === "danger") {
    return "destructive";
  }
  return style === "primary" || index === 0 ? "default" : "outline";
}

/**
 * Builds a stable React key for a message part.
 *
 * @param part - The message part.
 * @param index - The part's position, used when it has no ID of its own.
 * @returns The key.
 */
function partKey(part: EveMessagePart, index: number): string {
  switch (part.type) {
    case "authorization": {
      return part.attemptId === undefined
        ? `authorization:${part.turnId}:${part.stepIndex}:${part.name}`
        : `authorization:${part.attemptId}`;
    }
    case "dynamic-tool": {
      return part.toolCallId;
    }
    case "reasoning":
    case "text": {
      return `${part.type}:${part.id ?? index}`;
    }
    case "file":
    case "step-start": {
      return `${part.type}:${index}`;
    }
    default: {
      return String(index);
    }
  }
}
