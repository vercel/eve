import type { ChildCall, ConversationState } from "#client/conversation-state.js";
import type {
  EveAuthorizationPart,
  EveDynamicToolPart,
  EveMessage,
} from "#client/message-reducer-types.js";
import { authorizationKey } from "#client/session-utils.js";
import { stripTerminalControls } from "#cli/ui/terminal-text.js";
import type { Block, ToolStatus } from "./blocks.js";
import type { AgentTUIConversationView, AgentTUIFailure } from "./conversation-view.js";
import { FileContentCache } from "./file-content-cache.js";
import { isTerminalToolCallPart } from "./terminal-tool-part.js";
import {
  isPanelRoutedTool,
  presentTool,
  readWriteFileInput,
  toolBaseName,
  type ToolPresentationContext,
} from "./tool-presentation.js";
import type { TerminalPartDisplayMode } from "./types.js";

export interface TranscriptOptions {
  readonly tools: TerminalPartDisplayMode;
  readonly reasoning: TerminalPartDisplayMode;
  readonly subagents: TerminalPartDisplayMode;
  readonly connectionAuth: TerminalPartDisplayMode;
  /** Names of the agent's local subagents, whose tools read as delegations. */
  readonly subagentNames?: readonly string[];
  /** Where full failure detail is recorded, shown instead of the raw dump. */
  readonly diagnosticsPath?: string;
}

type ToolState = {
  readonly status: ToolStatus;
  readonly output?: unknown;
  readonly errorText?: string;
};

/**
 * Projects one session's conversation into transcript blocks. Each block's
 * `live` flag says whether its part can still change; the renderer commits a
 * settled prefix to scrollback. Built blocks are reused while their inputs are
 * unchanged, so file-diff bases observe each tool call once, in order.
 */
export class ConversationTranscript {
  #memo = new Map<string, { readonly key: readonly unknown[]; readonly block: Block }>();
  readonly #fileContents = new FileContentCache();
  /** Server user messages that confirmed an optimistic message keep its block. */
  readonly #aliases = new Map<string, string>();
  #optimistic = new Map<string, string>();
  readonly #confirmed = new Set<string>();

  reset(): void {
    this.#memo = new Map();
    this.#fileContents.clear();
    this.#aliases.clear();
    this.#optimistic = new Map();
    this.#confirmed.clear();
  }

  project(view: AgentTUIConversationView, options: TranscriptOptions): Block[] {
    const { conversation, working } = view;
    const blocks: Block[] = [];
    this.#aliasConfirmedMessages(conversation.messages);
    const childToolIds = childToolCallIds(conversation);
    const emittedCalls = new Set<string>();

    for (const message of conversation.messages) {
      if (message.role === "user") {
        const block = this.#userBlock(message);
        if (block !== undefined) blocks.push(block);
        continue;
      }
      const tools = message.parts.filter(
        (part): part is EveDynamicToolPart =>
          isTerminalToolCallPart(part) &&
          part.state !== "input-streaming" &&
          part.toolMetadata?.eve?.inputRequest?.kind !== "session-limit" &&
          conversation.children[part.toolCallId] === undefined &&
          !childToolIds.has(part.toolCallId) &&
          !isPanelRoutedTool(part.toolName),
      );
      const states = new Map(tools.map((part) => [part, toolState(part, conversation, working)]));
      const cohortActive = [...states.values()].some((state) => isActive(state.status));

      for (const [index, part] of message.parts.entries()) {
        if (part.type === "text" || part.type === "reasoning") {
          const block = this.#contentBlock(message, index, options, working);
          if (block !== undefined) blocks.push(block);
        } else if (part.type === "authorization") {
          if (options.connectionAuth !== "hidden") blocks.push(this.#authorizationBlock(part));
        } else if (part.type === "dynamic-tool") {
          const call = conversation.children[part.toolCallId];
          if (call !== undefined) {
            emittedCalls.add(call.callId);
            blocks.push(...this.#subagentBlocks(call, conversation, options, working));
            continue;
          }
          const state = states.get(part);
          if (state === undefined || options.tools === "hidden") continue;
          blocks.push(this.#toolBlock(part, state, cohortActive, options));
        }
      }
      const turnId = message.metadata?.turnId;
      if (turnId !== undefined && conversation.turns[turnId]?.status === "cancelled") {
        blocks.push(
          this.#memoize(`cancelled:${turnId}`, [], () => ({
            kind: "notice",
            body: "Cancelled.",
            live: false,
          })),
        );
      }
    }
    for (const call of Object.values(conversation.children)) {
      if (!emittedCalls.has(call.callId)) {
        blocks.push(...this.#subagentBlocks(call, conversation, options, working));
      }
    }
    for (const [index, failure] of view.failures.entries()) {
      blocks.push(this.#failureBlock(index, failure, options));
    }
    return blocks;
  }

  #memoize(id: string, key: readonly unknown[], build: () => Block): Block {
    const cached = this.#memo.get(id);
    if (cached !== undefined && sameKey(cached.key, key)) return cached.block;
    const block = { ...build(), id };
    this.#memo.set(id, { key, block });
    return block;
  }

  #aliasConfirmedMessages(messages: readonly EveMessage[]): void {
    const optimistic = new Map<string, string>();
    for (const message of messages) {
      if (message.role === "user" && message.metadata?.optimistic === true) {
        optimistic.set(message.id, userText(message));
      }
    }
    const vanished = [...this.#optimistic].filter(([id]) => !optimistic.has(id));
    for (const message of messages) {
      if (message.role !== "user" || message.metadata?.optimistic === true) continue;
      if (this.#confirmed.has(message.id)) continue;
      this.#confirmed.add(message.id);
      const text = userText(message);
      const match = vanished.findIndex(([, candidate]) => candidate === text);
      if (match === -1) continue;
      this.#aliases.set(message.id, vanished[match]![0]);
      vanished.splice(match, 1);
    }
    this.#optimistic = optimistic;
  }

  #userBlock(message: EveMessage): Block | undefined {
    const body = stripTerminalControls(userText(message));
    if (body.trim().length === 0) return undefined;
    const id = `user:${this.#aliases.get(message.id) ?? message.id}`;
    return this.#memoize(id, [body], () => ({ kind: "user", body, live: false }));
  }

  #contentBlock(
    message: EveMessage,
    index: number,
    options: TranscriptOptions,
    working: boolean,
  ): Block | undefined {
    const part = message.parts[index];
    if (part?.type !== "text" && part?.type !== "reasoning") return undefined;
    if (part.type === "reasoning" && options.reasoning !== "full") return undefined;
    const body = stripTerminalControls(part.text).trim();
    if (body.length === 0) return undefined;
    const live = part.state === "streaming" && working;
    const id = `${part.type}:${part.id ?? `${message.id}:${index}`}`;
    return this.#memoize(id, [body, live], () =>
      part.type === "text"
        ? { kind: "assistant", body, live }
        : { kind: "reasoning", body, collapsed: false, live },
    );
  }

  #authorizationBlock(part: EveAuthorizationPart): Block {
    return this.#memoize(`connection-auth:${authorizationKey(part)}`, [part], () => {
      const state = part.state === "completed" ? part.outcome : part.state;
      const terminalMessage = authorizationTerminalMessage(state);
      return {
        kind: "connection-auth",
        title: `${stripTerminalControls(part.name)} · authorization · ${state}`,
        body: formatAuthorization(part, terminalMessage),
        preformatted: true,
        live: terminalMessage === undefined,
      };
    });
  }

  #toolBlock(
    part: EveDynamicToolPart,
    state: ToolState,
    cohortActive: boolean,
    options: TranscriptOptions,
  ): Block {
    const live = cohortActive || isActive(state.status);
    return this.#memoize(
      `tool:${part.toolCallId}`,
      [part, state.status, live, options.tools, options.subagentNames],
      () => {
        const context = this.#presentationContext(part.toolCallId, part, state, options);
        return {
          ...toolBlock(part.toolName, part.input, state, context),
          kind: "tool",
          live,
          expanded: options.tools === "full",
        };
      },
    );
  }

  #subagentBlocks(
    call: ChildCall,
    conversation: ConversationState,
    options: TranscriptOptions,
    working: boolean,
  ): Block[] {
    if (options.subagents === "hidden") return [];
    const ended = call.observation.status === "ended";
    const provisional =
      !ended &&
      call.parentStatus === "reported-complete" &&
      call.observation.status === "following";
    const background = !ended && call.background;
    const active = !ended && (provisional || background || working);
    const name = stripTerminalControls(call.name);
    const siblings = Object.values(conversation.children).filter(
      (candidate) => stripTerminalControls(candidate.name) === name,
    );
    const subtitle =
      siblings.length > 1 ? `#${siblings.findIndex((c) => c.callId === call.callId) + 1}` : "";
    const status: ToolStatus | undefined = ended ? "done" : background ? "running" : undefined;
    const header = this.#memoize(
      `subagent:${call.callId}:header`,
      [name, subtitle, status, active],
      () => {
        const block: Block = {
          kind: "subagent",
          subagentCallId: call.callId,
          title: name,
          live: active,
        };
        if (subtitle !== "") block.subtitle = subtitle;
        if (status !== undefined) block.status = status;
        return block;
      },
    );
    const child =
      call.observation.status === "not-followed" ? undefined : call.observation.conversation;
    if (options.subagents === "collapsed" || child === undefined) return [header];

    const blocks: Block[] = [header];
    for (const step of subagentSteps(child)) {
      const live = ended ? false : provisional || (!step.finalized && active);
      blocks.push(
        this.#memoize(
          `subagent:${call.callId}:step:${step.key}`,
          [step.reasoning, step.message, live, options.subagents],
          () => ({
            kind: "subagent-step",
            subagentCallId: call.callId,
            depth: 1,
            reasoning: step.reasoning,
            body: step.message,
            collapsed: options.subagents !== "full",
            live,
          }),
        ),
      );
    }
    const tools = child.messages.flatMap((message) =>
      message.role === "assistant" ? message.parts.filter(isTerminalToolCallPart) : [],
    );
    const states = new Map(
      tools
        .filter((part) => part.state !== "input-streaming")
        .map((part) => [part, toolState(part, child, active)]),
    );
    const cohortActive = [...states.values()].some((state) => isActive(state.status));
    for (const [part, state] of states) {
      const live = ended ? false : provisional || cohortActive || isActive(state.status);
      blocks.push(
        this.#memoize(
          `subagent:${call.callId}:tool:${part.toolCallId}`,
          [part, state.status, live, options.subagents, options.subagentNames],
          () => {
            const context = this.#presentationContext(part.toolCallId, part, state, options);
            return {
              ...toolBlock(part.toolName, part.input, state, context),
              kind: "subagent-tool",
              subagentCallId: call.callId,
              depth: 1,
              live,
              expanded: options.subagents === "full",
            };
          },
        ),
      );
    }
    return blocks;
  }

  #failureBlock(index: number, failure: AgentTUIFailure, options: TranscriptOptions): Block {
    const { message, hint, detail } = failure;
    return this.#memoize(`failure:${index}`, [message, hint, detail], () => {
      const block: Block = {
        kind: "error",
        title: "Error",
        body: stripTerminalControls(message),
        live: false,
      };
      if (hint !== undefined) block.hint = stripTerminalControls(hint);
      if (detail !== undefined) {
        block.detail =
          options.diagnosticsPath === undefined
            ? stripTerminalControls(detail)
            : `details: ${options.diagnosticsPath}`;
      }
      return block;
    });
  }

  /** Feeds the file-content cache and derives the context a write needs for its diff. */
  #presentationContext(
    callId: string,
    part: EveDynamicToolPart,
    state: ToolState,
    options: TranscriptOptions,
  ): ToolPresentationContext | undefined {
    if (state.output !== undefined) this.#fileContents.observeRead(state.output);
    const isSubagent = options.subagentNames?.includes(toolBaseName(part.toolName)) === true;
    const write = readWriteFileInput(part.toolName, part.input);
    if (write === undefined) return isSubagent ? { isSubagent } : undefined;
    const context: { previousContent?: string; existed?: boolean; isSubagent?: boolean } = {};
    if (isSubagent) context.isSubagent = true;
    const previous = this.#fileContents.observeWrite({ ...write, callId });
    if (previous !== undefined) context.previousContent = previous;
    const existed = writeExistedFlag(state.output);
    if (existed !== undefined) context.existed = existed;
    return context;
  }
}

/** Running tools and the live turn's model activity, for the turn bar. */
export function turnActivity(
  view: AgentTUIConversationView,
): "Thinking" | "Generating" | "Running" {
  const message = view.conversation.messages.findLast(
    (candidate) => candidate.role === "assistant",
  );
  if (message === undefined) return "Thinking";
  if (
    message.parts.some(
      (part) =>
        isTerminalToolCallPart(part) &&
        (part.state === "input-available" || part.state === "approval-responded"),
    )
  )
    return "Running";
  const last = message.parts.findLast((part) => part.type !== "step-start");
  return last?.type === "text" && last.state === "streaming" ? "Generating" : "Thinking";
}

function toolState(
  part: EveDynamicToolPart,
  conversation: ConversationState,
  working: boolean,
): ToolState {
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

function isActive(status: ToolStatus): boolean {
  return status === "running" || status === "approval";
}

function toolBlock(
  toolName: string,
  input: unknown,
  state: ToolState,
  context: ToolPresentationContext | undefined,
): Omit<Block, "kind"> {
  const presentation = presentTool(toolName, input, context);
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

type SubagentStep = {
  readonly key: string;
  readonly reasoning: string;
  readonly message: string;
  readonly finalized: boolean;
};

/** Pairs each child reply with the reasoning that preceded it. */
function subagentSteps(conversation: ConversationState): SubagentStep[] {
  const steps: SubagentStep[] = [];
  for (const message of conversation.messages) {
    if (message.role !== "assistant") continue;
    let reasoning = "";
    for (const [index, part] of message.parts.entries()) {
      if (part.type === "reasoning") reasoning += part.text;
      if (part.type === "text") {
        steps.push({
          key: part.id ?? `${message.id}:${index}`,
          reasoning,
          message: part.text,
          finalized: part.state === "done",
        });
        reasoning = "";
      }
      if (part.type === "dynamic-tool" && reasoning) {
        steps.push({
          key: `${message.id}:${index}:reasoning`,
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

function childToolCallIds(conversation: ConversationState): Set<string> {
  const ids = new Set<string>();
  for (const call of Object.values(conversation.children)) {
    if (call.observation.status === "not-followed") continue;
    for (const message of call.observation.conversation?.messages ?? []) {
      for (const part of message.parts) {
        if (part.type === "dynamic-tool") ids.add(part.toolCallId);
      }
    }
  }
  return ids;
}

function userText(message: EveMessage): string {
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

function authorizationTerminalMessage(state: string): string | undefined {
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

function formatAuthorization(
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
function writeExistedFlag(output: unknown): boolean | undefined {
  if (output === null || typeof output !== "object" || Array.isArray(output)) return undefined;
  const existed = (output as Record<string, unknown>)["existed"];
  return typeof existed === "boolean" ? existed : undefined;
}

function sameKey(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
