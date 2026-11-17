import { sessionTables } from "#protocol/session-projection/session-view.js";
import { interactionOwner } from "#protocol/session-projection/selectors.js";

import { agentToolSession } from "#client/conversation-state.js";
import type { TaskEntry } from "./task-activity.js";
import type { ConversationState } from "#client/conversation-state.js";
import type {
  EveInteractionPart,
  EveToolPart,
  EveMessage,
  EveMessagePart,
} from "#client/message-types.js";
import { stripTerminalControls } from "#cli/ui/terminal-text.js";
import type { Block, ToolStatus } from "./blocks.js";
import { formatTurnDuration } from "./stream-format.js";
import { isTerminalToolCallPart } from "./terminal-tool-part.js";
import { summarizeChildTools } from "./tool-block-groups.js";
import {
  agentDisplayName,
  agentTaskLabel,
  presentPreparingTool,
  presentTool,
  toolDisplayTitle,
  type ToolPresentationContext,
} from "./tool-presentation.js";
import type { SignInChallenge } from "#protocol/session-events/families/interaction.js";
import type { SessionView, CallRow, TaskRow } from "#protocol/session-projection/tables.js";

export type ToolState = {
  readonly status: ToolStatus;
  readonly output?: unknown;
  readonly errorText?: string;
};

export interface TaskRecord {
  readonly callId: string;
  readonly taskId: string;
  readonly callIds: string[];
  readonly kind: "agent" | "tool";
  readonly name: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly label: string | undefined;
  readonly purpose?: string;
  readonly startedAtMs: number;
  settledAtMs?: number;
  ended: boolean;
}

export interface AgentActivity {
  tools: Block[];
  rows: Block[];
  children?: TaskEntry[];
  omittedTasks?: number;
  omittedAttention?: boolean;
  step?: string;
  pending: boolean;
}

export function taskNeedsApproval(conversation: ConversationState, task: TaskRow): boolean {
  if (
    Object.values(sessionTables(conversation.view).interactions).some(
      (input) =>
        interactionOwner(sessionTables(conversation.view), input).taskId === task.taskId &&
        input.status === "open" &&
        input.request.kind === "approval",
    )
  )
    return true;
  const agent = agentToolSession(conversation, task);
  const child =
    agent?.observation.status === "not-followed" ? undefined : agent?.observation.conversation;
  return (
    child !== undefined &&
    Object.values(sessionTables(child.view).interactions).some(
      (input) => input.status === "open" && input.request.kind === "approval",
    )
  );
}

export function startLine(record: TaskRecord): Block {
  const presentation = presentTool(record.toolName, record.input, {
    ...labelContext(record.label),
    isSubagent: record.kind === "agent",
  });
  return {
    kind: "task",
    taskKind: record.kind,
    title: record.kind === "agent" ? `Delegate ${agentTaskLabel(record.name)}` : record.name,
    subtitle: stripTerminalControls(presentation.subtitle),
    live: false,
  };
}

export function followUpLine(
  record: TaskRecord,
  part: EveToolPart,
  label: string | undefined,
): Block {
  if (record.kind === "agent") {
    return {
      kind: "task",
      taskKind: "agent",
      title: `Message ${agentTaskLabel(record.name)}`,
      subtitle: agentTaskSummary(part.input),
      live: false,
    };
  }
  const presentation = presentTool(part.name, part.input, labelContext(label));
  return {
    kind: "task",
    taskKind: "tool",
    title: stripTerminalControls(presentation.title),
    subtitle: stripTerminalControls(presentation.subtitle),
    live: false,
  };
}

export function nestedTaskRecord(
  callId: string,
  part: EveToolPart,
  task: TaskRow,
  block: Block,
): TaskRecord {
  const name =
    task.kind === "agent"
      ? agentDisplayName(stripTerminalControls(part.name))
      : stripTerminalControls(toolDisplayTitle(part.name));
  return {
    callId,
    taskId: task.taskId,
    callIds: [part.callId],
    kind: task.kind === "agent" ? "agent" : "tool",
    name,
    toolName: part.name,
    input: part.input,
    label: undefined,
    purpose:
      task.kind === "agent"
        ? agentTaskSummary(part.input)
        : block.subtitle || (block.title === name ? undefined : block.title),
    startedAtMs: Date.now(),
    ended: false,
  };
}

export function toolState(part: EveToolPart, view: SessionView): ToolState {
  const errorText = part.error?.message;
  switch (part.state) {
    case "completed":
      return { status: "done", output: part.output };
    case "rejected":
      return view.calls[part.callId]?.taskId === undefined
        ? { status: "denied", errorText: errorText ?? "Denied by user." }
        : { status: "error", errorText };
    case "cancelled":
    case "failed":
      return { status: "error", errorText };
    case "approval":
      return { status: "approval" };
    default:
      return { status: "running", output: part.output };
  }
}

export function isActive(status: ToolStatus): boolean {
  return status === "running" || status === "approval";
}

export function toolBlock(
  part: EveToolPart,
  state: ToolState,
  context: ToolPresentationContext | undefined,
): Omit<Block, "kind"> {
  const { name: toolName, input } = part;
  const presentation =
    part.state === "streaming"
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

export function endLine(
  record: TaskRecord,
  call: Pick<CallRow, "status" | "outcome" | "output" | "error">,
  childTools: readonly Block[] | undefined,
  separator: string,
): Block {
  const dot = ` ${separator} `;
  const line: Block = {
    id: `task:${record.callId}:end`,
    kind: "task",
    taskKind: record.kind,
    title: record.kind === "agent" ? agentTaskLabel(record.name) : record.name,
    live: false,
  };
  switch (call.outcome) {
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
    case "failed":
    case "rejected":
    case "abandoned": {
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
  readonly order: number;
  readonly reasoning: string;
  readonly message: string;
  readonly finalized: boolean;
};

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
      if (part.type === "tool" && reasoning) {
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

export function isToolCallRow(part: EveMessagePart): part is EveToolPart {
  return part.type === "tool" && (part.state === "streaming" || isTerminalToolCallPart(part));
}

export function taskCallsById(
  conversation: ConversationState,
): Map<string, { task: TaskRow; call: CallRow }> {
  const calls = new Map<string, { task: TaskRow; call: CallRow }>();
  for (const call of Object.values(sessionTables(conversation.view).calls)) {
    const task =
      call.taskId === undefined ? undefined : sessionTables(conversation.view).tasks[call.taskId];
    if (task !== undefined) calls.set(call.callId, { task, call });
  }
  return calls;
}

export function activeToolSteps(
  states: ReadonlyMap<EveToolPart, ToolState>,
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
    case "accepted":
      return "Authorization complete";
    case "declined":
      return "Authorization declined";
    case "failed":
      return "Authorization failed";
    case "expired":
      return "Authorization timed out";
    case "withdrawn":
    case "interrupted":
    case "abandoned":
      return "Authorization cancelled";
    default:
      return undefined;
  }
}

export function formatAuthorization(
  part: EveInteractionPart,
  challenge: SignInChallenge,
  terminalMessage: string | undefined,
): { body: string; link?: string } {
  const lines: string[] = [];
  let link: string | undefined;
  if (terminalMessage !== undefined) {
    lines.push(terminalMessage);
  } else {
    const description = stripTerminalControls(part.request.prompt);
    if (description.length > 0) lines.push(description);
    if (challenge?.url) {
      link = stripTerminalControls(challenge.url);
      lines.push("Open to authorize:", link);
    }
    if (challenge?.userCode) lines.push(`Code: ${stripTerminalControls(challenge.userCode)}`);
    if (challenge?.expiresAt) lines.push(`Expires: ${stripTerminalControls(challenge.expiresAt)}`);
    if (challenge?.instructions) lines.push(stripTerminalControls(challenge.instructions));
  }
  if (part.status === "settled" && part.reason !== undefined) {
    const reason = stripTerminalControls(part.reason);
    if (reason.length > 0) lines.push(`Reason: ${reason}`);
  }
  const body = lines.join("\n");
  return link === undefined ? { body } : { body, link };
}

export function writeExistedFlag(output: unknown): boolean | undefined {
  if (output === null || typeof output !== "object" || Array.isArray(output)) return undefined;
  const existed = (output as Record<string, unknown>)["existed"];
  return typeof existed === "boolean" ? existed : undefined;
}
