import type { ChildCall, ConversationState } from "#client/conversation-state.js";
import type { EveDynamicToolPart } from "#client/message-reducer-types.js";

export interface SubagentView {
  begin(update: { callId: string; name: string }): void;
  background(update: { callId: string }): void;
  upsertStep(update: SubagentStepUpdate): void;
  upsertTool(update: SubagentToolUpdate): void;
  removeTool(update: { callId: string; childCallId: string }): void;
  complete(update: { authoritative: boolean; callId: string }): void;
  markChildToolCallId(callId: string): void;
}

export type SubagentStepUpdate = {
  callId: string;
  subagentName: string;
  sectionKey: number;
  reasoning: string;
  message: string;
  finalized: boolean;
};
export type SubagentToolUpdate = {
  callId: string;
  subagentName: string;
  childCallId: string;
  toolName: string;
  input: unknown;
  status: "preparing" | "approval-requested" | "executing" | "done" | "failed" | "rejected";
  output?: unknown;
  errorText?: string;
};

function tools(conversation: ConversationState): EveDynamicToolPart[] {
  return conversation.messages.flatMap((message) =>
    message.role === "assistant"
      ? message.parts.filter((part): part is EveDynamicToolPart => part.type === "dynamic-tool")
      : [],
  );
}

function toolUpdate(call: ChildCall, part: EveDynamicToolPart): SubagentToolUpdate {
  const status =
    part.state === "input-streaming"
      ? "preparing"
      : part.state === "approval-requested"
        ? "approval-requested"
        : part.state === "output-available" && !part.partial
          ? "done"
          : part.state === "output-error"
            ? "failed"
            : part.state === "output-denied"
              ? "rejected"
              : "executing";
  const update: SubagentToolUpdate = {
    callId: call.callId,
    subagentName: call.name,
    childCallId: part.toolCallId,
    toolName: part.toolName,
    input: part.input,
    status,
  };
  if (part.state === "output-available") update.output = part.output;
  if (part.state === "output-error") update.errorText = part.errorText;
  return update;
}

function sections(conversation: ConversationState, call: ChildCall): SubagentStepUpdate[] {
  const result: SubagentStepUpdate[] = [];
  for (const message of conversation.messages) {
    if (message.role !== "assistant") continue;
    let reasoning = "";
    for (const part of message.parts) {
      if (part.type === "reasoning") reasoning += part.text;
      if (part.type === "text") {
        result.push({
          callId: call.callId,
          subagentName: call.name,
          sectionKey: result.length,
          reasoning,
          message: part.text,
          finalized: part.state === "done",
        });
        reasoning = "";
      }
      if (part.type === "dynamic-tool" && reasoning) {
        result.push({
          callId: call.callId,
          subagentName: call.name,
          sectionKey: result.length,
          reasoning,
          message: "",
          finalized: true,
        });
        reasoning = "";
      }
    }
    if (reasoning)
      result.push({
        callId: call.callId,
        subagentName: call.name,
        sectionKey: result.length,
        reasoning,
        message: "",
        finalized: message.metadata?.status === "complete",
      });
  }
  return result;
}

/** Converts canonical child conversation state into nested terminal rows. */
export class TerminalSubagentProjection {
  readonly #previous = new Map<
    string,
    { call: ChildCall; steps: SubagentStepUpdate[]; tools: SubagentToolUpdate[] }
  >();
  readonly #view: SubagentView;

  constructor(view: SubagentView) {
    this.#view = view;
  }

  update(state: ConversationState, callId: string): void {
    const call = state.children[callId];
    if (!call) return;
    const previous = this.#previous.get(callId);
    const conversation =
      call.observation.status === "following" ||
      call.observation.status === "ended" ||
      call.observation.status === "unavailable"
        ? call.observation.conversation
        : undefined;
    const nextSteps = conversation ? sections(conversation, call) : [];
    const nextTools = conversation ? tools(conversation).map((part) => toolUpdate(call, part)) : [];
    this.#view.markChildToolCallId(callId);
    if (!previous) this.#view.begin({ callId, name: call.name });
    if (call.background && !previous?.call.background) this.#view.background({ callId });
    for (const step of nextSteps) {
      const old = previous?.steps[step.sectionKey];
      if (
        !old ||
        old.reasoning !== step.reasoning ||
        old.message !== step.message ||
        old.finalized !== step.finalized
      )
        this.#view.upsertStep(step);
    }
    for (const tool of nextTools) {
      this.#view.markChildToolCallId(tool.childCallId);
      const old = previous?.tools.find((item) => item.childCallId === tool.childCallId);
      if (
        !old ||
        old.status !== tool.status ||
        old.input !== tool.input ||
        old.output !== tool.output ||
        old.errorText !== tool.errorText
      )
        this.#view.upsertTool(tool);
    }
    for (const tool of previous?.tools ?? []) {
      if (!nextTools.some((item) => item.childCallId === tool.childCallId))
        this.#view.removeTool({ callId, childCallId: tool.childCallId });
    }
    const ended = call.observation.status === "ended";
    if (ended && previous?.call.observation.status !== "ended")
      this.#view.complete({ callId, authoritative: true });
    else if (
      call.parentStatus === "reported-complete" &&
      previous?.call.parentStatus !== "reported-complete"
    )
      this.#view.complete({ callId, authoritative: false });
    this.#previous.set(callId, { call, steps: nextSteps, tools: nextTools });
  }

  reset(): void {
    this.#previous.clear();
  }
}
