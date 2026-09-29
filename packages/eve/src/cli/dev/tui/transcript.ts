import {
  agentCallTurns,
  agentToolSession,
  isAgentCallContentPending,
  type ConversationState,
  type ConversationTask,
  type ConversationTaskCall,
} from "#client/conversation-state.js";
import type {
  EveAuthorizationPart,
  EveDynamicToolPart,
  EveMessage,
} from "#client/message-reducer-types.js";
import { authorizationKey } from "#client/session-utils.js";
import { stripTerminalControls } from "#cli/ui/terminal-text.js";
import { isTaskControlTool } from "#protocol/task-tools.js";
import type { Block } from "./blocks.js";
import type { AgentTUIConversationView, AgentTUIFailure, ToolLabels } from "./conversation-view.js";
import { FileContentCache } from "./file-content-cache.js";
import { waitingLabel, type TaskEntry } from "./task-activity.js";
import { isTerminalToolCallPart } from "./terminal-tool-part.js";
import {
  agentDisplayName,
  isPanelRoutedTool,
  presentTool,
  readWriteFileInput,
  toolBaseName,
  type ToolPresentationContext,
} from "./tool-presentation.js";
import {
  activeToolSteps,
  agentTaskSummary,
  authorizationTerminalMessage,
  childToolCallIds,
  endLine,
  firstLine,
  formatAuthorization,
  isActive,
  isToolCallRow,
  labelContext,
  subagentSteps,
  taskCallsById,
  toolBlock,
  toolState,
  userText,
  writeExistedFlag,
  type TaskRecord,
  type ToolState,
} from "./transcript-parts.js";
import type { SubagentDisplayMode, TerminalPartDisplayMode } from "./types.js";

export interface TranscriptOptions {
  readonly tools: TerminalPartDisplayMode;
  readonly reasoning: TerminalPartDisplayMode;
  readonly subagents: SubagentDisplayMode;
  readonly connectionAuth: TerminalPartDisplayMode;
  /** Names of the agent's local subagents, whose tools read as delegations. */
  readonly subagentNames?: readonly string[];
  /** Where full failure detail is recorded, shown instead of the raw dump. */
  readonly diagnosticsPath?: string;
  /** Separates a task end line's facts; the theme's `·`. */
  readonly dot?: string;
}

/**
 * A block written when it first appeared rather than where its part sits: a task's end line, or
 * an agent's own finished row. It stays after the blocks that preceded it then, as `main`'s
 * append-only transcript would have written it.
 */
interface PlacedBlock {
  readonly block: Block;
  /** The blocks it followed, newest last; the newest still projected anchors it. */
  readonly after: readonly string[];
}

/** How long a settled agent task waits for its own last events before writing its end line. */
export const TASK_END_GRACE_MS = 2_000;

const PLACEMENT_ANCHORS = 8;

/**
 * Projects one session's conversation into transcript blocks. Each block's
 * `live` flag says whether its part can still change; the renderer commits a
 * settled prefix to scrollback. Built blocks are reused while their inputs are
 * unchanged, so file-diff bases observe each tool call once, in order.
 *
 * A task writes one line when it starts, at its call, and one when it ends, where the transcript
 * had reached by then; what it does in between is {@link ConversationTranscript.tasks}, which the
 * renderer shows in the task panel above the prompt.
 */
export class ConversationTranscript {
  #memo = new Map<string, { readonly key: readonly unknown[]; readonly block: Block }>();
  readonly #fileContents = new FileContentCache();
  /** Server user messages that confirmed an optimistic message keep its block. */
  readonly #aliases = new Map<string, string>();
  #optimistic = new Map<string, string>();
  readonly #confirmed = new Set<string>();
  readonly #tasks = new Map<string, TaskRecord>();
  #placed: PlacedBlock[] = [];
  readonly #placedIds = new Set<string>();
  #working: readonly TaskEntry[] = [];

  reset(): void {
    this.#memo = new Map();
    this.#fileContents.clear();
    this.#aliases.clear();
    this.#optimistic = new Map();
    this.#confirmed.clear();
    this.#tasks.clear();
    this.#placed = [];
    this.#placedIds.clear();
    this.#working = [];
  }

  /** The tasks between their start and end lines as of the last projection, in start order. */
  get tasks(): readonly TaskEntry[] {
    return this.#working;
  }

  /** Whether a settled agent task is waiting for its own last events. */
  get finishing(): boolean {
    return this.#working.some((entry) => entry.finishing === true);
  }

  /** How input requests name the task that asked: as its task lines do. */
  taskLabel(conversation: ConversationState, taskId: string): string | undefined {
    const task = conversation.tasks[taskId];
    if (task === undefined) return undefined;
    const calls = Object.values(task.calls);
    const call = calls.findLast((candidate) => candidate.status === "working") ?? calls.at(-1);
    const record = call === undefined ? undefined : this.#tasks.get(call.callId);
    if (record !== undefined) return record.name;
    return task.kind === "agent"
      ? agentDisplayName(stripTerminalControls(task.name))
      : stripTerminalControls(task.name);
  }

  /** End lines for the tasks still working when their session ends; they read as stopped. */
  stopWorking(options: TranscriptOptions): Block[] {
    const lines: Block[] = [];
    for (const record of this.#tasks.values()) {
      if (record.ended) continue;
      record.ended = true;
      lines.push(endLine(record, { status: "cancelled" }, undefined, options.dot ?? "·"));
    }
    this.#working = [];
    return lines;
  }

  project(view: AgentTUIConversationView, options: TranscriptOptions): Block[] {
    const { conversation, working } = view;
    const now = Date.now();
    const blocks: Block[] = [];
    this.#aliasConfirmedMessages(conversation.messages);
    const childToolIds = childToolCallIds(conversation);
    const taskCalls = taskCallsById(conversation);
    const withdrawn = new Set(view.data.withdrawnCallIds);
    const labels = view.data.toolLabels;

    for (const message of conversation.messages) {
      if (message.role === "user") {
        const block = this.#userBlock(message);
        if (block !== undefined) blocks.push(block);
        continue;
      }
      const tools = message.parts.filter(
        (part): part is EveDynamicToolPart =>
          isToolCallRow(part) &&
          // A call still streaming its input shows a placeholder only while the turn runs.
          (part.state !== "input-streaming" || working) &&
          !isTaskControlTool(part.toolName) &&
          !withdrawn.has(part.toolCallId) &&
          part.toolMetadata?.eve?.inputRequest?.kind !== "session-limit" &&
          !taskCalls.has(part.toolCallId) &&
          !childToolIds.has(part.toolCallId) &&
          !isPanelRoutedTool(part.toolName),
      );
      const states = new Map(
        tools.map((part) => [part, toolState(part, conversation, working, false)]),
      );
      const activeSteps = activeToolSteps(states);

      for (const [index, part] of message.parts.entries()) {
        if (part.type === "text" || part.type === "reasoning") {
          const block = this.#contentBlock(message, index, options, working);
          if (block !== undefined) blocks.push(block);
        } else if (part.type === "authorization") {
          if (options.connectionAuth !== "hidden") blocks.push(this.#authorizationBlock(part));
        } else if (part.type === "dynamic-tool") {
          const taskCall = taskCalls.get(part.toolCallId);
          if (taskCall !== undefined) {
            const start = this.#taskStartLine(part, taskCall.task, labels, options, now);
            if (start !== undefined) blocks.push(start);
            continue;
          }
          const state = states.get(part);
          if (state === undefined || options.tools === "hidden") continue;
          const toolLabels = labels[part.toolCallId];
          blocks.push(
            this.#toolBlock(part, state, activeSteps.has(part.stepIndex), toolLabels, options),
          );
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
    for (const [index, failure] of view.failures.entries()) {
      blocks.push(this.#failureBlock(index, failure, options));
    }

    const placed = this.#placeBlocks(blocks);
    const arrivals = this.#taskActivity(view, taskCalls, options, now);
    for (const block of arrivals) {
      const after = placed.slice(-PLACEMENT_ANCHORS).map((candidate) => candidate.id!);
      this.#placed.push({ block, after });
      this.#placedIds.add(block.id!);
      placed.push(block);
    }
    return placed;
  }

  /** Interleaves placed blocks after the blocks they first followed. */
  #placeBlocks(blocks: readonly Block[]): Block[] {
    const placed = [...blocks];
    for (const { block, after } of this.#placed) {
      let index = placed.length;
      for (let anchor = after.length - 1; anchor >= 0; anchor -= 1) {
        const found = placed.findIndex((candidate) => candidate.id === after[anchor]);
        if (found !== -1) {
          index = found + 1;
          break;
        }
      }
      placed.splice(index, 0, block);
    }
    return placed;
  }

  /** A call became a task: its row is now the task's start line, written once. */
  #taskStartLine(
    part: EveDynamicToolPart,
    task: ConversationTask,
    labels: Readonly<Record<string, ToolLabels>>,
    options: TranscriptOptions,
    now: number,
  ): Block | undefined {
    const visible =
      task.kind === "agent" ? options.subagents !== "hidden" : options.tools !== "hidden";
    if (!visible) return undefined;
    const callId = part.toolCallId;
    const label = labels[callId]?.start;
    let record = this.#tasks.get(callId);
    let summary = agentTaskSummary(part.input);
    let baseName = agentDisplayName(stripTerminalControls(part.toolName));
    if (task.kind === "tool") {
      const presentation = presentTool(part.toolName, part.input, labelContext(label));
      baseName = stripTerminalControls(presentation.title);
      summary = stripTerminalControls(presentation.subtitle);
    }
    if (record === undefined) {
      record = {
        callId,
        kind: task.kind,
        name: this.#uniqueName(baseName),
        toolName: part.toolName,
        input: part.input,
        label,
        startedAtMs: now,
        ended: false,
      };
      this.#tasks.set(callId, record);
    }
    const { name } = record;
    return this.#memoize(`task:${callId}:start`, [name, summary, task.kind], () => ({
      kind: "task",
      taskKind: task.kind,
      title: name,
      subtitle: summary,
      live: false,
    }));
  }

  /** Parallel calls to one agent read `researcher`, `researcher #2`, …; a name is never renamed. */
  #uniqueName(baseName: string): string {
    const taken = new Set(
      [...this.#tasks.values()].filter((record) => !record.ended).map((record) => record.name),
    );
    if (!taken.has(baseName)) return baseName;
    for (let ordinal = 2; ; ordinal += 1) {
      const candidate = `${baseName} #${String(ordinal)}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  /**
   * Updates the working tasks and returns the blocks that appeared since the last projection:
   * `--subagents full` rows as an agent finishes each, and end lines as tasks end.
   */
  #taskActivity(
    view: AgentTUIConversationView,
    taskCalls: ReadonlyMap<string, { task: ConversationTask; call: ConversationTaskCall }>,
    options: TranscriptOptions,
    now: number,
  ): Block[] {
    const { conversation, working } = view;
    const lastTurn = Object.values(conversation.turns).at(-1);
    // A cancelled or failed turn gets no end for the tasks still working; they read as stopped.
    const stopping =
      !working &&
      (view.data.sessionFailed ||
        lastTurn?.status === "cancelled" ||
        lastTurn?.status === "failed");
    const arrivals: Block[] = [];
    const entries: TaskEntry[] = [];
    for (const record of this.#tasks.values()) {
      if (record.ended) continue;
      const taskCall = taskCalls.get(record.callId);
      if (taskCall === undefined) continue;
      const { task, call } = taskCall;
      const activity = this.#agentActivity(record, task, call, conversation, options);
      if (options.subagents === "full") {
        for (const row of activity.rows) {
          if (!this.#placedIds.has(row.id!)) arrivals.push(row);
        }
      }
      const settled = call.status !== "working";
      if (settled) record.settledAtMs ??= now;
      const finishing =
        settled &&
        activity.pending &&
        working &&
        now - (record.settledAtMs ?? now) < TASK_END_GRACE_MS;
      if ((settled && !finishing) || (!settled && stopping)) {
        record.ended = true;
        arrivals.push(
          endLine(
            record,
            settled ? call : { status: "cancelled" },
            activity.tools,
            options.dot ?? "·",
          ),
        );
        continue;
      }
      const entry: TaskEntry = {
        callId: record.callId,
        kind: record.kind,
        name: record.name,
        toolName: record.toolName,
        input: record.input,
        label: record.label,
        startedAtMs: record.startedAtMs,
        childTools: new Map(activity.tools.map((block) => [block.id!, block])),
      };
      if (activity.step !== undefined) entry.step = activity.step;
      if (finishing) entry.finishing = true;
      entries.push(entry);
    }
    this.#working = entries;
    return arrivals;
  }

  /** What an agent task has done for this call: its tool calls, latest words, and finished rows. */
  #agentActivity(
    record: TaskRecord,
    task: ConversationTask,
    call: ConversationTaskCall,
    conversation: ConversationState,
    options: TranscriptOptions,
  ): { tools: Block[]; rows: Block[]; step?: string; pending: boolean } {
    const agent = task.kind === "agent" ? agentToolSession(conversation, task) : undefined;
    const child =
      agent === undefined || agent.observation.status === "not-followed"
        ? undefined
        : agent.observation.conversation;
    if (agent === undefined || child === undefined) return { tools: [], rows: [], pending: false };
    const pending =
      agent.observation.status === "following" && isAgentCallContentPending(task, call, child);
    const turnIds = new Set(agentCallTurns(task, child).get(call.callId) ?? []);
    const messages = child.messages.filter(
      (message) =>
        message.role === "assistant" &&
        message.metadata?.turnId !== undefined &&
        turnIds.has(message.metadata.turnId),
    );
    const running = call.status === "working" || pending;
    const childTasks = taskCallsById(child);
    const ordered: Array<{ order: number; block: Block; settled: boolean }> = [];
    const tools: Block[] = [];
    let order = 0;
    for (const message of messages) {
      for (const part of message.parts) {
        order += 1;
        if (!isToolCallRow(part) || isTaskControlTool(part.toolName)) continue;
        const childTask = childTasks.get(part.toolCallId);
        const state = toolState(part, child, running, childTask?.call.status === "working");
        const id = `subagent:${record.callId}:tool:${part.toolCallId}`;
        const block = this.#memoize(id, [part, state.status, record.name], () => {
          const context = this.#presentationContext(part.toolCallId, part, state, options, {
            isSubagent: childTask?.task.kind === "agent",
          });
          return {
            ...toolBlock(part, state, context),
            kind: "subagent-tool",
            subagentCallId: record.callId,
            agentName: record.name,
            depth: 1,
            live: false,
          };
        });
        tools.push(block);
        ordered.push({ order, block, settled: !isActive(state.status) });
      }
    }
    const steps = subagentSteps(messages);
    for (const step of steps) {
      if (!step.finalized) continue;
      const id = `subagent:${record.callId}:step:${step.key}`;
      const block = this.#memoize(id, [step.reasoning, step.message, record.name], () => {
        const row: Block = {
          kind: "subagent-step",
          subagentCallId: record.callId,
          agentName: record.name,
          depth: 1,
          body: step.message,
          live: false,
        };
        if (step.reasoning.length > 0) row.reasoning = step.reasoning;
        return row;
      });
      ordered.push({ order: step.order, block, settled: true });
    }
    const rows = ordered
      .filter((row) => row.settled)
      .sort((left, right) => left.order - right.order)
      .map((row) => row.block);
    const latest = steps.at(-1);
    const result: { tools: Block[]; rows: Block[]; step?: string; pending: boolean } = {
      tools,
      rows,
      pending,
    };
    if (latest !== undefined) result.step = firstLine(latest.message) ?? "Thinking";
    return result;
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
    const pendingTexts = new Set(optimistic.values());
    for (const message of messages) {
      if (message.role !== "user" || message.metadata?.optimistic === true) continue;
      if (this.#confirmed.has(message.id)) continue;
      const text = userText(message);
      const match = vanished.findIndex(([, candidate]) => candidate === text);
      // An early server echo can share a snapshot with its optimistic twin; wait for the swap.
      if (match === -1 && pendingTexts.has(text)) continue;
      this.#confirmed.add(message.id);
      if (match === -1) continue;
      this.#aliases.set(message.id, vanished[match]![0]);
      vanished.splice(match, 1);
    }
    this.#optimistic = optimistic;
  }

  #userBlock(message: EveMessage): Block | undefined {
    // A server copy waiting on its optimistic twin's swap would otherwise print twice.
    if (message.metadata?.optimistic !== true && !this.#confirmed.has(message.id)) return undefined;
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
    labels: ToolLabels | undefined,
    options: TranscriptOptions,
  ): Block {
    const live = cohortActive || isActive(state.status);
    return this.#memoize(
      `tool:${part.toolCallId}`,
      [part, state.status, live, options.tools, options.subagentNames, labels],
      () => {
        const context = this.#presentationContext(part.toolCallId, part, state, options, {
          label: labels?.start,
          completeLabel: labels?.complete,
        });
        return {
          ...toolBlock(part, state, context),
          kind: "tool",
          live,
          expanded: options.tools === "full",
        };
      },
    );
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
    extra: {
      readonly isSubagent?: boolean;
      readonly label?: string | undefined;
      readonly completeLabel?: string | undefined;
    } = {},
  ): ToolPresentationContext | undefined {
    if (state.output !== undefined) this.#fileContents.observeRead(state.output);
    const context: {
      previousContent?: string;
      existed?: boolean;
      isSubagent?: boolean;
      label?: string;
      completeLabel?: string;
    } = {};
    if (
      extra.isSubagent === true ||
      options.subagentNames?.includes(toolBaseName(part.toolName)) === true
    ) {
      context.isSubagent = true;
    }
    if (extra.label !== undefined) context.label = extra.label;
    if (extra.completeLabel !== undefined) context.completeLabel = extra.completeLabel;
    const write = readWriteFileInput(part.toolName, part.input);
    if (write !== undefined) {
      const previous = this.#fileContents.observeWrite({ ...write, callId });
      if (previous !== undefined) context.previousContent = previous;
      const existed = writeExistedFlag(state.output);
      if (existed !== undefined) context.existed = existed;
    }
    return Object.keys(context).length > 0 ? context : undefined;
  }
}

/**
 * Running tools and the live turn's model activity, for the turn bar. A turn parked on its tasks
 * names them.
 */
export function turnActivity(view: AgentTUIConversationView, tasks: readonly TaskEntry[]): string {
  const { conversation } = view;
  const turn =
    conversation.activeTurnId === undefined
      ? undefined
      : conversation.turns[conversation.activeTurnId];
  const message = view.conversation.messages.findLast(
    (candidate) => candidate.role === "assistant",
  );
  const taskCalls = taskCallsById(conversation);
  if (
    message?.parts.some(
      (part) =>
        isTerminalToolCallPart(part) &&
        !isTaskControlTool(part.toolName) &&
        !taskCalls.has(part.toolCallId) &&
        (part.state === "input-available" || part.state === "approval-responded"),
    ) === true
  )
    return "Running";
  if (turn?.waiting === true && tasks.length > 0) return waitingLabel(tasks);
  if (message === undefined) return "Thinking";
  const last = message.parts.findLast((part) => part.type !== "step-start");
  return (last?.type === "text" && last.state === "streaming") ||
    (last?.type === "dynamic-tool" && last.state === "input-streaming")
    ? "Generating"
    : "Thinking";
}

function sameKey(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
