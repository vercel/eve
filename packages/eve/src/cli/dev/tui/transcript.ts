import {
  agentCallTurns,
  agentToolSession,
  isAgentCallContentPending,
  type ConversationState,
  taskCalls,
} from "#client/conversation-state.js";
import type { EveInteractionPart, EveToolPart, EveMessage } from "#client/message-types.js";
import { activity, callOutputSource } from "#protocol/session-projection/selectors.js";
import type { TaskRow, CallRow, SessionView } from "#protocol/session-projection/tables.js";
import { stripTerminalControls } from "#cli/ui/terminal-text.js";
import type { Block } from "./blocks.js";
import type { AgentTUIConversationView, AgentTUIFailure, ToolLabels } from "./conversation-view.js";
import { FileContentCache } from "./file-content-cache.js";
import { signInLabel, waitingLabel, type TaskEntry } from "./task-activity.js";
import { TaskRecords } from "./task-records.js";
import {
  agentDisplayName,
  agentTaskLabel,
  isPanelRoutedTool,
  readWriteFileInput,
  toolBaseName,
  type ToolPresentationContext,
} from "./tool-presentation.js";
import {
  activeToolSteps,
  taskNeedsApproval,
  type AgentActivity,
  authorizationTerminalMessage,
  endLine,
  firstLine,
  followUpLine,
  formatAuthorization,
  isActive,
  isToolCallRow,
  nestedTaskRecord,
  startLine,
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
import type { SignInChallenge } from "#protocol/session-events/families/interaction.js";

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
  readonly #tasks = new TaskRecords();
  readonly #nestedTasks = new Map<string, TaskRecord>();
  #placed: PlacedBlock[] = [];
  readonly #placedIds = new Set<string>();
  #working: readonly TaskEntry[] = [];

  reset(): void {
    this.#memo = new Map();
    this.#fileContents.clear();
    this.#tasks.clear();
    this.#nestedTasks.clear();
    this.#placed = [];
    this.#placedIds.clear();
    this.#working = [];
  }

  /** The tasks between their start and end lines as of the last projection, in start order. */
  get tasks(): readonly TaskEntry[] {
    return this.#working;
  }

  /** How input requests name the task that asked: as its task lines do. */
  taskLabel(conversation: ConversationState, taskId: string): string | undefined {
    const task = conversation.view.tasks[taskId];
    if (task === undefined) return undefined;
    const calls = taskCalls(conversation.view, taskId);
    const call = calls.findLast((candidate) => candidate.status !== "settled") ?? calls.at(-1);
    const record = call === undefined ? undefined : this.#tasks.get(call.callId);
    if (record !== undefined)
      return record.kind === "agent" ? agentTaskLabel(record.name) : record.name;
    return task.kind === "agent"
      ? agentTaskLabel(agentDisplayName(stripTerminalControls(task.name)))
      : stripTerminalControls(task.name);
  }

  /** End lines for the tasks still working when their session ends; they read as stopped. */
  stopWorking(options: TranscriptOptions): Block[] {
    const lines: Block[] = [];
    for (const record of this.#tasks.values()) {
      if (record.ended) continue;
      record.ended = true;
      lines.push(
        endLine(
          record,
          { outcome: "interrupted", status: "settled" },
          undefined,
          options.dot ?? "·",
        ),
      );
    }
    this.#working = [];
    return lines;
  }

  project(view: AgentTUIConversationView, options: TranscriptOptions): Block[] {
    const { conversation, working } = view;
    const now = Date.now();
    const blocks: Block[] = [];
    const taskCalls = taskCallsById(conversation);
    const { toolLabels: labels, withdrawn } = view.data;
    // A turn's failure shows where the turn ended, after its last message.
    const turnFailures = new Map(
      view.failures.flatMap((failure) =>
        failure.turnId === undefined ? [] : [[failure.turnId, failure] as const],
      ),
    );
    const lastOfTurn = new Map<string, number>();
    for (const [index, message] of conversation.messages.entries()) {
      const turnId = message.metadata?.turnId;
      if (turnId !== undefined) lastOfTurn.set(turnId, index);
    }
    const shown = new Set<string>();
    const endTurn = (index: number, turnId: string | undefined): boolean => {
      if (turnId === undefined || lastOfTurn.get(turnId) !== index) return false;
      const failure = turnFailures.get(turnId);
      if (failure === undefined) return false;
      blocks.push(this.#failureBlock(`failure:${turnId}`, failure, options));
      shown.add(turnId);
      return true;
    };

    for (const [messageIndex, message] of conversation.messages.entries()) {
      if (message.role === "user") {
        const block = this.#userBlock(message);
        if (block !== undefined) blocks.push(block);
        endTurn(messageIndex, message.metadata?.turnId);
        continue;
      }
      const tools = message.parts.filter(
        (part): part is EveToolPart =>
          isToolCallRow(part) &&
          // A call still streaming its input shows a placeholder only while the turn runs.
          (part.state !== "streaming" || working) &&
          part.kind !== "control" &&
          !withdrawn(part.callId) &&
          !taskCalls.has(part.callId) &&
          !isPanelRoutedTool(part.name),
      );
      const states = new Map(tools.map((part) => [part, toolState(part, view.data.view)]));
      const activeSteps = activeToolSteps(states);

      for (const [index, part] of message.parts.entries()) {
        if (part.type === "text" || part.type === "reasoning") {
          const block = this.#contentBlock(message, index, options, working);
          if (block !== undefined) blocks.push(block);
        } else if (part.type === "interaction") {
          // A sign-in shows where it was asked; the composer asks the rest.
          if (part.request.signIn !== undefined && options.connectionAuth !== "hidden")
            blocks.push(this.#signInBlock(part, part.request.signIn));
        } else if (part.type === "tool") {
          const taskCall = taskCalls.get(part.callId);
          if (taskCall !== undefined) {
            const start = this.#taskStartLine(
              part,
              taskCall.task,
              labels,
              options,
              now,
              view.data.view,
            );
            if (start !== undefined) blocks.push(start);
            continue;
          }
          const state = states.get(part);
          if (state === undefined || options.tools === "hidden") continue;
          const toolLabels = labels(part.callId);
          blocks.push(
            this.#toolBlock(part, state, activeSteps.has(part.stepIndex), toolLabels, options),
          );
        }
      }
      const turnId = message.metadata?.turnId;
      if (endTurn(messageIndex, turnId)) continue;
      if (
        turnId !== undefined &&
        !turnFailures.has(turnId) &&
        lastOfTurn.get(turnId) === messageIndex &&
        conversation.view.turns[turnId]?.outcome === "cancelled"
      ) {
        blocks.push(
          this.#memoize(`cancelled:${turnId}`, [], () => ({
            kind: "notice",
            body: "Cancelled.",
            live: false,
          })),
        );
      }
    }
    // Failures that ended no turn shown above, such as a session's own, go last.
    let unplaced = 0;
    for (const failure of view.failures) {
      if (failure.turnId !== undefined && shown.has(failure.turnId)) continue;
      const id =
        failure.turnId === undefined
          ? `failure:session:${unplaced++}`
          : `failure:${failure.turnId}`;
      blocks.push(this.#failureBlock(id, failure, options));
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

  /** A call became a task: its row is now the task's start line, or a message to a working one. */
  #taskStartLine(
    part: EveToolPart,
    task: TaskRow,
    labels: (callId: string) => ToolLabels | undefined,
    options: TranscriptOptions,
    now: number,
    view: SessionView,
  ): Block | undefined {
    const visible =
      task.kind === "agent" ? options.subagents !== "hidden" : options.tools !== "hidden";
    if (!visible) return undefined;
    const label = labels(part.callId)?.start;
    const record = this.#tasks.record(part, task, label, now, view);
    return record.callId === part.callId
      ? this.#memoize(`task:${record.callId}:start`, [record], () => startLine(record))
      : this.#memoize(`task:${part.callId}:message`, [record], () =>
          followUpLine(record, part, label),
        );
  }

  /**
   * Updates the working tasks and returns the blocks that appeared since the last projection:
   * `--subagents full` rows as an agent finishes each, and end lines as tasks end.
   */
  #taskActivity(
    view: AgentTUIConversationView,
    taskCalls: ReadonlyMap<string, { task: TaskRow; call: CallRow }>,
    options: TranscriptOptions,
    now: number,
  ): Block[] {
    const { conversation, working } = view;
    const lastTurn = Object.values(conversation.view.turns).at(-1);
    // A cancelled or failed turn gets no end for the tasks still working; they read as stopped.
    const stopping =
      !working &&
      (view.data.sessionFailed ||
        lastTurn?.outcome === "cancelled" ||
        lastTurn?.outcome === "failed");
    const arrivals: Block[] = [];
    const entries: TaskEntry[] = [];
    const traversal = { remaining: 128 };
    for (const record of this.#tasks.values()) {
      if (record.ended) continue;
      const task = taskCalls.get(record.callId)?.task;
      if (task === undefined) continue;
      const calls = record.callIds.flatMap((id) => {
        const call = taskCalls.get(id)?.call;
        return call === undefined ? [] : [call];
      });
      // The last call carries the task's latest outcome; one reply settles every call it answered.
      const call = calls.at(-1)!;
      const activity = this.#agentActivity(record, task, calls, conversation, options, traversal);
      if (options.subagents === "full") {
        for (const row of activity.rows) {
          if (!this.#placedIds.has(row.id!)) arrivals.push(row);
        }
      }
      const settled = calls.every((candidate) => candidate.status === "settled");
      if (settled) record.settledAtMs ??= now;
      // A settled agent task waits for its session to settle the call's delivery, while its turn
      // runs, before writing its end line.
      const finishing = settled && activity.pending && working;
      if ((settled && !finishing) || (!settled && stopping)) {
        record.ended = true;
        arrivals.push(
          endLine(
            record,
            settled
              ? { ...call, output: callOutputSource(conversation.view, call.callId)?.output }
              : { outcome: "interrupted", status: "settled" },
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
        purpose: record.purpose,
        children: activity.children,
        omittedTasks: activity.omittedTasks,
        omittedAttention: activity.omittedAttention,
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

  /** What an agent task has done for these calls: its tool calls, latest words, and finished rows. */
  #agentActivity(
    record: TaskRecord,
    task: TaskRow,
    calls: readonly CallRow[],
    conversation: ConversationState,
    options: TranscriptOptions,
    traversal: { remaining: number },
    depth = 0,
  ): AgentActivity {
    const agent = task.kind === "agent" ? agentToolSession(conversation, task) : undefined;
    const child =
      agent === undefined || agent.observation.status === "not-followed"
        ? undefined
        : agent.observation.conversation;
    if (agent === undefined || child === undefined) return { tools: [], rows: [], pending: false };
    const pending =
      agent.observation.status === "following" &&
      calls.some((call) =>
        isAgentCallContentPending(taskCalls(conversation.view, task.taskId), call, child),
      );
    const callTurns = agentCallTurns(taskCalls(conversation.view, task.taskId), child);
    const turnIds = new Set(calls.flatMap((call) => callTurns.get(call.callId) ?? []));
    const messages = child.messages.filter(
      (message) =>
        message.role === "assistant" &&
        message.metadata?.turnId !== undefined &&
        turnIds.has(message.metadata.turnId),
    );
    const childTasks = taskCallsById(child);
    const ordered: Array<{ order: number; block: Block; settled: boolean }> = [];
    const tools: Block[] = [];
    const children: TaskEntry[] = [];
    // A child task's later calls join its first working call's entry.
    const shownChildTasks = new Set<string>();
    let omittedTasks = 0;
    let omittedAttention = false;
    let order = 0;
    for (const message of messages) {
      for (const part of message.parts) {
        order += 1;
        if (!isToolCallRow(part) || part.kind === "control") continue;
        const childTask = childTasks.get(part.callId);
        const state = toolState(part, child.view);
        const id = `subagent:${record.callId}:tool:${part.callId}`;
        const block = this.#memoize(id, [part, state.status, record.name], () => {
          const context = this.#presentationContext(part.callId, part, state, options, {
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
        const childVisible =
          childTask?.task.kind === "agent"
            ? options.subagents !== "hidden"
            : options.tools !== "hidden";
        if (childTask !== undefined && childTask.call.status !== "settled" && childVisible) {
          if (shownChildTasks.has(childTask.task.taskId)) continue;
          shownChildTasks.add(childTask.task.taskId);
          if (depth >= 8 || traversal.remaining <= 0) {
            omittedTasks += 1;
            omittedAttention ||=
              state.status === "approval" || taskNeedsApproval(child, childTask.task);
            continue;
          }
          traversal.remaining -= 1;
          const key = `${record.callId}/${part.callId}`;
          let nested = this.#nestedTasks.get(key);
          if (nested === undefined) {
            nested = nestedTaskRecord(key, part, childTask.task, block);
            this.#nestedTasks.set(key, nested);
          }
          const activity = this.#agentActivity(
            nested,
            childTask.task,
            taskCalls(child.view, childTask.task.taskId).filter(
              (call) => call.status !== "settled",
            ),
            child,
            options,
            traversal,
            depth + 1,
          );
          children.push({
            ...nested,
            step: activity.step,
            children: activity.children,
            omittedTasks: activity.omittedTasks,
            omittedAttention: activity.omittedAttention,
            childTools: new Map(activity.tools.map((tool) => [tool.id!, tool])),
          });
        } else {
          tools.push(block);
        }
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
    const result: AgentActivity = {
      tools,
      rows,
      children,
      omittedTasks,
      omittedAttention,
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

  #userBlock(message: EveMessage): Block | undefined {
    const body = stripTerminalControls(userText(message));
    if (body.trim().length === 0) return undefined;
    const id = `user:${message.id}`;
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

  #signInBlock(part: EveInteractionPart, signIn: SignInChallenge): Block {
    return this.#memoize(`connection-auth:${part.interactionId}`, [part], () => {
      const state = part.outcome ?? "required";
      const terminalMessage = authorizationTerminalMessage(state);
      return {
        kind: "connection-auth",
        title: `${stripTerminalControls(signIn.displayName ?? signIn.name)} · authorization · ${state}`,
        ...formatAuthorization(part, signIn, terminalMessage),
        preformatted: true,
        live: terminalMessage === undefined,
      };
    });
  }

  #toolBlock(
    part: EveToolPart,
    state: ToolState,
    cohortActive: boolean,
    labels: ToolLabels | undefined,
    options: TranscriptOptions,
  ): Block {
    const live = cohortActive || isActive(state.status);
    return this.#memoize(
      `tool:${part.callId}`,
      [
        part,
        state.status,
        live,
        options.tools,
        options.subagentNames,
        labels?.start,
        labels?.complete,
      ],
      () => {
        const context = this.#presentationContext(part.callId, part, state, options, {
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

  #failureBlock(id: string, failure: AgentTUIFailure, options: TranscriptOptions): Block {
    const { message, hint, detail } = failure;
    return this.#memoize(id, [message, hint, detail], () => {
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
    part: EveToolPart,
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
      options.subagentNames?.includes(toolBaseName(part.name)) === true
    ) {
      context.isSubagent = true;
    }
    if (extra.label !== undefined) context.label = extra.label;
    if (extra.completeLabel !== undefined) context.completeLabel = extra.completeLabel;
    const write = readWriteFileInput(part.name, part.input);
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
 * Running tools and the live turn's model activity, for the turn bar. A session parked on a
 * sign-in names its connections, and a turn parked on its tasks names them.
 */
export function turnActivity(view: AgentTUIConversationView, tasks: readonly TaskEntry[]): string {
  const current = activity(view.data.view);
  switch (current.kind) {
    case "calling":
      return "Running";
    case "compacting":
      return "Compacting";
    case "waiting-on-tasks":
      return waitingLabel(tasks);
    case "waiting-on-person": {
      const signIns = current.interactions.flatMap((row) =>
        row.request.signIn === undefined ? [] : [row.request.signIn],
      );
      return signIns.length > 0
        ? signInLabel(signIns.map((signIn) => signIn.displayName ?? signIn.name))
        : "Waiting for input";
    }
    default: {
      const { previews } = view.conversation;
      return Object.values(previews.parts).some((part) => part.kind === "text") ||
        Object.keys(previews.calls).length > 0
        ? "Generating"
        : "Thinking";
    }
  }
}

function sameKey(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
