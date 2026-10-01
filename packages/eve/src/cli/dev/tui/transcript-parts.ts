/** Pure pieces of the transcript projection: tool rows, task lines, and agent steps. */

import type {
  ConversationState,
  ConversationTaskCall,
  ConversationTask,
} from "#client/conversation-state.js";
import type {
  EveAuthorizationPart,
  EveDynamicToolPart,
  EveMessage,
  EveMessagePart,
} from "#client/message-reducer-types.js";
import { stripTerminalControls } from "#cli/ui/terminal-text.js";
import type { Block, ToolStatus } from "./blocks.js";
import { formatTurnDuration } from "./stream-format.js";
import { isTerminalToolCallPart } from "./terminal-tool-part.js";
import { summarizeChildTools } from "./tool-block-groups.js";
import {
  presentPreparingTool,
  presentTool,
  type ToolPresentationContext,
} from "./tool-presentation.js";

export type ToolState = {
  readonly status: ToolStatus;
  readonly output?: unknown;
  readonly errorText?: string;
};

/** A task whose start line is written, named once and never renamed. */
export interface TaskRecord {
  readonly callId: string;
  readonly kind: "agent" | "tool";
  readonly name: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly label: string | undefined;
  readonly startedAtMs: number;
  settledAtMs?: number;
  ended: boolean;
}

export function toolState(
  part: EveDynamicToolPart,
  conversation: ConversationState,
  working: boolean,
  taskWorking: boolean,
): ToolState {
  // A task call's receipt closes the tool part; the call runs until its task.settled, even after
  // its turn ends, as a root approval ends it.
  if (taskWorking) return { status: "running" };
  const state = settledToolState(part, conversation);
  return state.status === "running" && !working
    ? { status: "error", errorText: "interrupted" }
    : state;
}

function settledToolState(part: EveDynamicToolPart, conversation: ConversationState): ToolState {
  switch (part.state) {
    case "approval-requested": {
      const input = conversation.inputs[part.approval.id];
      if (input?.status !== "responded") return { status: "approval" };
      return input.response?.optionId === "approve"
        ? { status: "running" }
        : { status: "denied", errorText: "Denied by user." };
    }
    case "approval-responded":
      return part.approval.approved === false
        ? { status: "denied", errorText: part.approval.reason ?? "Denied by user." }
        : { status: "running" };
    case "output-available":
      return part.partial === true
        ? { status: "running" }
        : { status: "done", output: part.output };
    case "output-error":
      return { status: "error", errorText: part.errorText };
    case "output-denied":
      return {
        status: "denied",
        errorText: part.approval.reason ?? "Tool execution was cancelled.",
      };
    default:
      return { status: "running" };
  }
}

export function isActive(status: ToolStatus): boolean {
  return status === "running" || status === "approval";
}

export function toolBlock(
  part: EveDynamicToolPart,
  state: ToolState,
  context: ToolPresentationContext | undefined,
): Omit<Block, "kind"> {
  const { toolName, input } = part;
  const presentation =
    part.state === "input-streaming"
      ? presentPreparingTool(toolName, context)
      : presentTool(toolName, input, context);
  const block: Omit<Block, "kind"> = {
    title: stripTerminalControls(presentation.title),
    subtitle: stripTerminalControls(presentation.subtitle),
    status: state.status,
    toolInput: input,
    toolName,
    toolGroup: presentation.group,
  };
  if (presentation.doneTitle !== undefined) {
    block.doneTitle = stripTerminalControls(presentation.doneTitle);
  }
  if (presentation.detail !== undefined) {
    block.detailLines = presentation.detail;
    block.keepDetailWhenDone = presentation.keepDetailWhenDone === true;
  }
  if (state.output !== undefined) {
    block.result = presentation.summarizeResult(state.output);
    block.toolOutput = state.output;
  } else if (state.errorText !== undefined) {
    block.result = stripTerminalControls(state.errorText);
  }
  return block;
}

/** A task's end line: how long it took and what it did, or why it failed, or that it stopped. */
export function endLine(
  record: TaskRecord,
  call: Pick<ConversationTaskCall, "status" | "output" | "error">,
  childTools: readonly Block[] | undefined,
  /** The theme's `·`, which separates the line's facts. */
  separator: string,
): Block {
  const dot = ` ${separator} `;
  const line: Block = {
    id: `task:${record.callId}:end`,
    kind: "task",
    taskKind: record.kind,
    title: record.name,
    live: false,
  };
  switch (call.status) {
    case "completed": {
      const elapsed = `finished in ${formatTurnDuration((record.settledAtMs ?? Date.now()) - record.startedAtMs)}`;
      const outcome =
        record.kind === "agent"
          ? summarizeChildTools(childTools ?? [])
          : presentTool(record.toolName, record.input, labelContext(record.label)).summarizeResult(
              call.output,
            );
      line.status = "done";
      line.body =
        outcome === undefined || outcome.length === 0 ? elapsed : `${elapsed}${dot}${outcome}`;
      break;
    }
    case "failed": {
      const reason = firstLine(stripTerminalControls(call.error?.message ?? ""));
      line.status = "error";
      line.body = reason === undefined ? "failed" : `failed${dot}${reason}`;
      break;
    }
    default:
      line.status = "denied";
      line.body = "stopped";
  }
  return line;
}

export function labelContext(label: string | undefined): ToolPresentationContext | undefined {
  return label === undefined ? undefined : { label };
}

/** The first line of an agent call's message: what the agent was asked to do. */
export function agentTaskSummary(input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  const message: unknown = Reflect.get(input, "message");
  return typeof message === "string" ? (firstLine(stripTerminalControls(message)) ?? "") : "";
}

export function firstLine(text: string): string | undefined {
  const line = text.split(/\r?\n/u).find((candidate) => candidate.trim().length > 0);
  return line?.trim();
}

export type SubagentStep = {
  readonly key: string;
  /** Where the step ends among its messages' parts, to order it among the agent's tool calls. */
  readonly order: number;
  readonly reasoning: string;
  readonly message: string;
  readonly finalized: boolean;
};

/** Pairs each child reply with the reasoning that preceded it. */
export function subagentSteps(messages: readonly EveMessage[]): SubagentStep[] {
  const steps: SubagentStep[] = [];
  let order = 0;
  for (const message of messages) {
    let reasoning = "";
    for (const [index, part] of message.parts.entries()) {
      order += 1;
      if (part.type === "reasoning") reasoning += part.text;
      if (part.type === "text") {
        steps.push({
          key: part.id ?? `${message.id}:${index}`,
          order,
          reasoning,
          message: part.text,
          finalized: part.state === "done",
        });
        reasoning = "";
      }
      if (part.type === "dynamic-tool" && reasoning) {
        steps.push({
          key: `${message.id}:${index}:reasoning`,
          order: order - 0.5,
          reasoning,
          message: "",
          finalized: true,
        });
        reasoning = "";
      }
    }
    if (reasoning) {
      steps.push({
        key: `${message.id}:reasoning:${message.parts.length}`,
        order,
        reasoning,
        message: "",
        finalized: message.metadata?.status === "complete",
      });
    }
  }
  return steps
    .map((step) => ({
      ...step,
      reasoning: stripTerminalControls(step.reasoning).trim(),
      message: stripTerminalControls(step.message).trim(),
    }))
    .filter((step) => step.reasoning.length > 0 || step.message.length > 0);
}

export function childToolCallIds(conversation: ConversationState): Set<string> {
  const ids = new Set<string>();
  for (const agent of Object.values(conversation.agents)) {
    if (agent.observation.status === "not-followed") continue;
    for (const message of agent.observation.conversation?.messages ?? []) {
      for (const part of message.parts) {
        if (part.type === "dynamic-tool") ids.add(part.toolCallId);
      }
    }
  }
  return ids;
}

/** A tool call, including one whose input is still streaming and so has no kind yet. */
export function isToolCallRow(part: EveMessagePart): part is EveDynamicToolPart {
  return (
    part.type === "dynamic-tool" &&
    (part.state === "input-streaming" || isTerminalToolCallPart(part))
  );
}

/** Every call that started or reached a task, by call ID. */
export function taskCallsById(
  conversation: ConversationState,
): Map<string, { task: ConversationTask; call: ConversationTaskCall }> {
  const calls = new Map<string, { task: ConversationTask; call: ConversationTaskCall }>();
  for (const task of Object.values(conversation.tasks)) {
    for (const call of Object.values(task.calls)) calls.set(call.callId, { task, call });
  }
  return calls;
}

/** Tools a step runs in parallel settle together, so a finished one waits for its siblings. */
export function activeToolSteps(
  states: ReadonlyMap<EveDynamicToolPart, ToolState>,
): Set<number | undefined> {
  const steps = new Set<number | undefined>();
  for (const [part, state] of states) if (isActive(state.status)) steps.add(part.stepIndex);
  return steps;
}

export function userText(message: EveMessage): string {
  return message.parts
    .map((part) =>
      part.type === "text"
        ? part.text
        : part.type === "file"
          ? `[file${part.filename === undefined ? "" : `: ${part.filename}`}]`
          : "",
    )
    .filter((text) => text.length > 0)
    .join("\n");
}

export function authorizationTerminalMessage(state: string): string | undefined {
  switch (state) {
    case "authorized":
      return "Authorization complete";
    case "declined":
      return "Authorization declined";
    case "failed":
      return "Authorization failed";
    case "timed-out":
      return "Authorization timed out";
    default:
      return undefined;
  }
}

export function formatAuthorization(
  part: EveAuthorizationPart,
  terminalMessage: string | undefined,
): string {
  const lines: string[] = [];
  if (terminalMessage !== undefined) {
    lines.push(terminalMessage);
  } else {
    const description = stripTerminalControls(part.description);
    if (description.length > 0) lines.push(description);
    const challenge = part.authorization;
    if (challenge?.url) lines.push(`URL: ${stripTerminalControls(challenge.url)}`);
    if (challenge?.userCode) lines.push(`Code: ${stripTerminalControls(challenge.userCode)}`);
    if (challenge?.expiresAt) lines.push(`Expires: ${stripTerminalControls(challenge.expiresAt)}`);
    if (challenge?.instructions) lines.push(stripTerminalControls(challenge.instructions));
  }
  if (part.state === "completed" && part.reason !== undefined) {
    const reason = stripTerminalControls(part.reason);
    if (reason.length > 0) lines.push(`Reason: ${reason}`);
  }
  return lines.join("\n");
}

/** Reads the shared write-file result's `existed` flag, whatever the tool. */
export function writeExistedFlag(output: unknown): boolean | undefined {
  if (output === null || typeof output !== "object" || Array.isArray(output)) return undefined;
  const existed = (output as Record<string, unknown>)["existed"];
  return typeof existed === "boolean" ? existed : undefined;
}
