import type { EveMessagePart, EveToolPart } from "eve/react";
import type { ComponentProps } from "react";
import { MessageResponse } from "@web/components/ai-elements/message";
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@web/components/ai-elements/reasoning";
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@web/components/ai-elements/tool";
import { AttachmentPart } from "./attachment";
import { InteractionActions, QuestionRequest } from "./interaction";
import { SignInPrompt } from "./sign-in";
import type { RespondToAgentInput } from "./types";

export function AgentMessagePart({
  canRespond,
  onAnswers,
  part,
  showCaret,
  userVisibleOnly,
}: {
  readonly canRespond: boolean;
  readonly onAnswers: RespondToAgentInput;
  readonly part: EveMessagePart;
  readonly showCaret: boolean;
  readonly userVisibleOnly: boolean;
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
      if (part.request.kind === "sign-in") {
        return <SignInPrompt interaction={part} />;
      }
      if (part.request.kind === "question") {
        return (
          <QuestionRequest
            canRespond={canRespond}
            interaction={part}
            onAnswers={onAnswers}
          />
        );
      }
      return (
        <InteractionActions
          canRespond={canRespond}
          interaction={part}
          onAnswers={onAnswers}
        />
      );
    case "tool": {
      const { interaction } = part;
      if (interaction?.request.kind === "question") {
        return (
          <QuestionRequest
            canRespond={canRespond}
            interaction={interaction}
            onAnswers={onAnswers}
          />
        );
      }

      if (userVisibleOnly && interaction) {
        return (
          <InteractionActions
            canRespond={canRespond}
            interaction={interaction}
            onAnswers={onAnswers}
          />
        );
      }

      const status = toolStatus(part);
      return (
        <Tool
          defaultOpen={
            status === "approval-requested" ||
            status === "approval-responded" ||
            status === "output-error" ||
            part.state === "cancelled"
          }
        >
          <ToolHeader
            status={status}
            statusLabel={part.state === "cancelled" ? "Cancelled" : undefined}
            title={part.name}
          />
          <ToolContent>
            <ToolInput input={part.input} />
            {interaction ? (
              <InteractionActions
                canRespond={canRespond}
                interaction={interaction}
                onAnswers={onAnswers}
              />
            ) : null}
            {part.state === "cancelled" ? (
              <output className="type-supporting-body text-muted-foreground">
                Cancelled before completion.
              </output>
            ) : (
              <ToolOutput
                errorText={
                  part.state === "failed"
                    ? (part.error?.message ??
                      "The tool call failed without error details.")
                    : undefined
                }
                output={part.output}
              />
            )}
          </ToolContent>
        </Tool>
      );
    }
  }
  throw new Error("Unsupported agent message part.");
}

export function partKey(part: EveMessagePart, index: number): string {
  switch (part.type) {
    case "interaction":
      return `interaction:${part.interactionId}`;
    case "tool":
      return part.callId;
    default:
      return `${part.type}:${String(index)}`;
  }
}

type ToolStatus = NonNullable<ComponentProps<typeof ToolHeader>["status"]>;

/** Maps eve's call state onto the AI SDK tool states the tool header presents. */
function toolStatus(part: EveToolPart): ToolStatus {
  switch (part.state) {
    case "streaming":
    case "requested":
      return "input-streaming";
    case "approval":
      return part.interaction?.answer === undefined
        ? "approval-requested"
        : "approval-responded";
    case "running":
    case "blocked":
      return "input-available";
    case "completed":
      return "output-available";
    case "rejected":
      return "output-denied";
    case "cancelled":
      return "output-denied";
    case "failed":
      return "output-error";
  }
  throw new Error("Unsupported tool call state.");
}
