"use client";

import type {
  ConversationInput,
  EveAuthorizationPart,
  EveDynamicToolPart,
  EveMessage,
  EveMessageInputRequest,
  EveMessagePart,
  ToolCallState,
} from "eve/react";
import type { FormEvent } from "react";
import { useState } from "react";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleXIcon,
  ExternalLinkIcon,
  FileIcon,
  ImageIcon,
  KeyRoundIcon,
  LoaderCircleIcon,
} from "lucide-react";
import { Streamdown } from "streamdown";
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message";
import { Button } from "@/components/ui/button";
import {
  CodeBlock,
  CodeBlockContent,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ui/code-block";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
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
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceDescription,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "@/components/ui/trace";
import { cn } from "@/lib/utils";

export type AgentInputResponse = {
  readonly optionId?: string;
  readonly requestId: string;
  readonly text?: string;
};

export type StepStatus = "done" | "failed" | "running" | "stopped";

type EveFilePart = Extract<EveMessagePart, { type: "file" }>;
type EveReasoningPart = Extract<EveMessagePart, { type: "reasoning" }>;
type StepPart = EveAuthorizationPart | EveDynamicToolPart | EveReasoningPart;
type Indexed<T> = { readonly index: number; readonly part: T };

export function AgentMessage({
  callState,
  canRespond,
  isStreaming,
  message,
  onInputResponses,
  questionsFor,
  reasoningDurations = {},
}: {
  readonly callState: (callId: string) => ToolCallState | undefined;
  readonly canRespond: (requestId: string) => boolean;
  readonly isStreaming: boolean;
  readonly message: EveMessage;
  readonly onInputResponses: (responses: readonly AgentInputResponse[]) => void | Promise<void>;
  readonly questionsFor: (callId: string) => readonly ConversationInput[];
  readonly reasoningDurations?: Readonly<Record<string, number>>;
}) {
  const lastTextIndex = message.parts.reduce(
    (last, part, index) => (part.type === "text" ? index : last),
    -1,
  );
  const isStep = (part: EveMessagePart): part is StepPart =>
    part.type === "reasoning" ||
    (part.type === "authorization" && part.state === "completed") ||
    (part.type === "dynamic-tool" &&
      questionsFor(part.toolCallId).length === 0 &&
      !isAwaitingApproval(part));

  // Steps between two pieces of content share one Trace.
  const blocks: (Indexed<EveMessagePart> | Indexed<StepPart>[])[] = [];
  for (const [index, part] of message.parts.entries()) {
    if (part.type === "step-start" || (part.type === "text" && part.text.length === 0)) {
      continue;
    }
    const last = blocks.at(-1);
    if (!isStep(part)) {
      blocks.push({ index, part });
    } else if (Array.isArray(last)) {
      last.push({ index, part });
    } else {
      blocks.push([{ index, part }]);
    }
  }

  return (
    <Message
      data-optimistic={message.metadata?.optimistic ? "true" : undefined}
      from={message.role}
    >
      <MessageContent>
        {blocks.map((block) =>
          Array.isArray(block) ? (
            <Trace key={`steps:${block[0]?.index}`}>
              {block.map(({ index, part }) => (
                <StepRow
                  callState={callState}
                  duration={
                    part.type === "reasoning" && part.id ? reasoningDurations[part.id] : undefined
                  }
                  isStreaming={isStreaming}
                  key={partKey(part, index)}
                  part={part}
                />
              ))}
            </Trace>
          ) : (
            <AgentMessagePart
              canRespond={canRespond}
              key={partKey(block.part, block.index)}
              onInputResponses={onInputResponses}
              part={block.part}
              questionsFor={questionsFor}
              showCaret={
                isStreaming && message.role === "assistant" && block.index === lastTextIndex
              }
            />
          ),
        )}
      </MessageContent>
    </Message>
  );
}

export function StepLine({
  detail,
  status,
  title,
}: {
  readonly detail?: string;
  readonly status: StepStatus;
  readonly title: string;
}) {
  return (
    <TraceLine
      status={status === "running" ? "running" : status === "failed" ? "error" : undefined}
    >
      <TraceIcon>
        {status === "running" ? (
          <LoaderCircleIcon className="animate-spin" />
        ) : status === "failed" ? (
          <CircleAlertIcon />
        ) : status === "stopped" ? (
          <CircleXIcon />
        ) : (
          <CircleCheckIcon />
        )}
      </TraceIcon>
      <TraceTitle>{title}</TraceTitle>
      {detail ? <TraceDescription>{detail}</TraceDescription> : null}
    </TraceLine>
  );
}

function StepRow({
  callState,
  duration,
  isStreaming,
  part,
}: {
  readonly callState: (callId: string) => ToolCallState | undefined;
  readonly duration?: number;
  readonly isStreaming: boolean;
  readonly part: StepPart;
}) {
  switch (part.type) {
    case "reasoning":
      return (
        <ReasoningRow
          duration={duration}
          running={isStreaming && part.state === "streaming"}
          text={part.text}
        />
      );
    case "authorization":
      if (part.state === "required") {
        return null;
      }
      return part.outcome === "authorized" ? (
        <StepLine status="done" title={`Connected ${part.displayName}`} />
      ) : (
        <StepLine
          detail={part.reason}
          status="failed"
          title={`${part.displayName} authorization ${formatAuthorizationOutcome(part.outcome)}`}
        />
      );
    case "dynamic-tool":
      return <ToolRow part={part} state={callState(part.toolCallId)} />;
  }
}

function ReasoningRow({
  duration,
  running,
  text,
}: {
  readonly duration?: number;
  readonly running: boolean;
  readonly text: string;
}) {
  const [open, setOpen] = useState<boolean>();
  const line = (
    <StepLine
      // A block that arrived whole was never timed.
      detail={!running && duration ? `${Math.max(1, Math.round(duration / 1000))}s` : undefined}
      status={running ? "running" : "done"}
      title={running ? "Thinking" : "Thought"}
    />
  );

  if (text.length === 0) {
    return line;
  }

  return (
    <TraceCollapsible onOpenChange={setOpen} open={open ?? running}>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <Streamdown className="text-sm">{text}</Streamdown>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

function ToolRow({
  part,
  state,
}: {
  readonly part: EveDynamicToolPart;
  readonly state: ToolCallState | undefined;
}) {
  const title = part.toolMetadata?.eve?.label ?? part.toolName;
  const status = toolStepStatus(state);
  const line = <StepLine detail={toolStepDetail(state)} status={status} title={title} />;
  const output = state?.output ?? part.output;
  const errorText = state?.errorText ?? part.errorText;

  if (status === "running" || status === "stopped") {
    return line;
  }

  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="flex flex-col gap-2">
        {part.toolName === "bash" ? (
          <BashOutput errorText={errorText} input={part.input} output={output} />
        ) : (
          <>
            {hasValue(part.input) ? <ToolPayload title="Input" value={part.input} /> : null}
            {errorText ? (
              <ToolPayload failed title="Error" value={errorText} />
            ) : hasValue(output) ? (
              <ToolPayload title="Output" value={output} />
            ) : null}
          </>
        )}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  );
}

function ToolPayload({
  failed = false,
  title,
  value,
}: {
  readonly failed?: boolean;
  readonly title: string;
  readonly value: unknown;
}) {
  return (
    <CodeBlock size="sm" variant={failed ? "destructive" : "default"}>
      <CodeBlockHeader>
        <CodeBlockTitle>{title}</CodeBlockTitle>
      </CodeBlockHeader>
      <CodeBlockContent className="max-h-64" wrap>
        {formatPayload(value)}
      </CodeBlockContent>
    </CodeBlock>
  );
}

function BashOutput({
  errorText,
  input,
  output,
}: {
  readonly errorText?: string;
  readonly input: unknown;
  readonly output: unknown;
}) {
  const stdout = getRecordValue(output, "stdout") ?? (typeof output === "string" ? output : "");
  const stderr = getRecordValue(output, "stderr") ?? errorText ?? "";
  const exitCode = getRecordValue(output, "exitCode");
  const lines = [
    `$ ${getRecordValue(input, "command") ?? "…"}`,
    String(stdout).trimEnd(),
    String(stderr).trimEnd(),
    typeof exitCode === "number" && exitCode !== 0 ? `Exited with code ${exitCode}` : "",
  ].filter(Boolean);

  return (
    <CodeBlock size="sm" variant={errorText ? "destructive" : "default"}>
      <CodeBlockContent className="max-h-64" wrap>
        {lines.join("\n")}
      </CodeBlockContent>
    </CodeBlock>
  );
}

function AgentMessagePart({
  canRespond,
  onInputResponses,
  part,
  questionsFor,
  showCaret,
}: {
  readonly canRespond: (requestId: string) => boolean;
  readonly onInputResponses: (responses: readonly AgentInputResponse[]) => void | Promise<void>;
  readonly part: EveMessagePart;
  readonly questionsFor: (callId: string) => readonly ConversationInput[];
  readonly showCaret: boolean;
}) {
  switch (part.type) {
    case "text":
      return (
        <MessageResponse caret="block" isAnimating={showCaret}>
          {part.text}
        </MessageResponse>
      );
    case "file":
      return <AttachmentPart part={part} />;
    case "authorization":
      return <AuthorizationPrompt part={part} />;
    case "dynamic-tool": {
      const questions = questionsFor(part.toolCallId);
      if (questions.length === 0) {
        return (
          <ApprovalRequest
            canRespond={canRespond}
            onInputResponses={onInputResponses}
            part={part}
          />
        );
      }

      return (
        <div className="flex flex-col gap-4">
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
    default:
      return null;
  }
}

function QuestionRequest({
  canRespond,
  inputRequest,
  inputResponse,
  onInputResponses,
}: {
  readonly canRespond: boolean;
  readonly inputRequest: EveMessageInputRequest;
  readonly inputResponse?: AgentInputResponse;
  readonly onInputResponses: (responses: readonly AgentInputResponse[]) => void | Promise<void>;
}) {
  const options = inputRequest.options ?? [];
  const acceptsFreeform = inputRequest.allowFreeform === true || options.length === 0;
  const disabled = !canRespond || inputResponse !== undefined;

  const submitResponse = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const answer = new FormData(event.currentTarget).get(inputRequest.requestId);
    if (typeof answer !== "string") {
      return;
    }

    const option = options.find(({ id }) => id === answer);
    void onInputResponses([
      option === undefined
        ? { requestId: inputRequest.requestId, text: answer.trim() }
        : { optionId: option.id, requestId: inputRequest.requestId },
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
      <QuestionnaireItem name={inputRequest.requestId} required>
        <QuestionnaireTitle className="text-sm font-medium">
          {inputRequest.prompt}
        </QuestionnaireTitle>
        <QuestionnaireChoices>
          {options.map((option) => (
            <QuestionnaireChoice
              className={cn(inputResponse?.optionId === option.id && "data-disabled:opacity-100")}
              defaultChecked={inputResponse?.optionId === option.id}
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
              className={cn(inputResponse?.text !== undefined && "disabled:opacity-100")}
              defaultValue={inputResponse?.text}
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

/** A tool waiting for approval is a question for the person, not a step. */
function ApprovalRequest({
  canRespond,
  onInputResponses,
  part,
}: {
  readonly canRespond: (requestId: string) => boolean;
  readonly onInputResponses: (responses: readonly AgentInputResponse[]) => void | Promise<void>;
  readonly part: EveDynamicToolPart;
}) {
  const inputRequest = part.toolMetadata?.eve?.inputRequest;
  if (!inputRequest) {
    return null;
  }

  return (
    <Item size="sm" variant="outline">
      <ItemContent>
        <ItemTitle>{part.toolMetadata?.eve?.label ?? part.toolName}</ItemTitle>
        <ItemDescription>{inputRequest.prompt}</ItemDescription>
      </ItemContent>
      <ItemActions>
        {inputRequest.options?.map((option, index) => (
          <Button
            disabled={!canRespond(inputRequest.requestId)}
            key={option.id}
            onClick={() => {
              void onInputResponses([{ optionId: option.id, requestId: inputRequest.requestId }]);
            }}
            size="sm"
            type="button"
            variant={
              option.style === "danger" ? "destructive" : index === 0 ? "default" : "outline"
            }
          >
            {option.label}
          </Button>
        ))}
      </ItemActions>
    </Item>
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

/** A sign-in the person still has to finish. Once settled it reads as a step. */
function AuthorizationPrompt({ part }: { readonly part: EveAuthorizationPart }) {
  const instructions = part.authorization?.instructions;

  return (
    <Item size="sm" variant="outline">
      <ItemMedia variant="icon">
        <KeyRoundIcon />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>Connect {part.displayName}</ItemTitle>
        <ItemDescription>{part.description}</ItemDescription>
        {instructions !== undefined && instructions !== part.description ? (
          <ItemDescription>{instructions}</ItemDescription>
        ) : null}
        {part.authorization?.userCode ? (
          <ItemDescription>
            Code{" "}
            <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-foreground">
              {part.authorization.userCode}
            </code>
          </ItemDescription>
        ) : null}
      </ItemContent>
      {part.authorization?.url ? (
        <ItemActions>
          <Button asChild size="sm">
            <a href={part.authorization.url} rel="noreferrer" target="_blank">
              <ExternalLinkIcon />
              Sign in with {part.displayName}
            </a>
          </Button>
        </ItemActions>
      ) : null}
    </Item>
  );
}

function isAwaitingApproval(part: EveDynamicToolPart) {
  return (
    part.state === "approval-requested" &&
    part.toolMetadata?.eve?.inputRequest !== undefined &&
    part.toolMetadata.eve.inputResponse === undefined
  );
}

function toolStepStatus(state: ToolCallState | undefined): StepStatus {
  switch (state?.status) {
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "rejected":
    case "cancelled":
    case "interrupted":
      return "stopped";
    default:
      return "running";
  }
}

function toolStepDetail(state: ToolCallState | undefined) {
  switch (state?.status) {
    case "failed":
      return "Failed";
    case "rejected":
      return "Denied";
    case "cancelled":
      return "Cancelled";
    case "interrupted":
      return "Interrupted";
    default:
      return undefined;
  }
}

function formatAuthorizationOutcome(outcome: NonNullable<EveAuthorizationPart["outcome"]>) {
  switch (outcome) {
    case "authorized":
      return "authorized";
    case "declined":
      return "declined";
    case "failed":
      return "failed";
    case "timed-out":
      return "timed out";
  }
}

function formatPayload(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function hasValue(value: unknown) {
  if (value === undefined || value === null || value === "") {
    return false;
  }
  return typeof value !== "object" || Object.keys(value).length > 0;
}

function getRecordValue(value: unknown, key: string): string | number | undefined {
  if (typeof value !== "object" || value === null || !(key in value)) {
    return undefined;
  }
  const property = value[key as keyof typeof value];
  return typeof property === "string" || typeof property === "number" ? property : undefined;
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

function partKey(part: EveMessagePart, index: number): string {
  switch (part.type) {
    case "authorization":
      return part.attemptId === undefined
        ? `authorization:${part.turnId}:${part.stepIndex}:${part.name}`
        : `authorization:${part.attemptId}`;
    case "dynamic-tool":
      return part.toolCallId;
    case "reasoning":
    case "text":
      return `${part.type}:${part.id ?? index}`;
    default:
      return `${part.type}:${index}`;
  }
}
