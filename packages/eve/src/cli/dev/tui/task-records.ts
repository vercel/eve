import type { ConversationTask } from "#client/conversation-state.js";
import type { EveDynamicToolPart } from "#client/message-reducer-types.js";
import { stripTerminalControls } from "#cli/ui/terminal-text.js";
import { agentDisplayName, presentTool } from "./tool-presentation.js";
import { agentTaskSummary, labelContext, type TaskRecord } from "./transcript-parts.js";

/**
 * The transcript's task records, one for each stretch of a task's work. A call that reaches a
 * task while one of its calls still works joins that task's record, as a model steering a working
 * agent does; a call that reaches it after it settled starts a new stretch with its own lines.
 */
export class TaskRecords {
  /** Records by the call that started them, in start order. */
  readonly #started = new Map<string, TaskRecord>();
  /** Records by every call they answer. */
  readonly #byCall = new Map<string, TaskRecord>();

  /** Records in start order. */
  values(): IterableIterator<TaskRecord> {
    return this.#started.values();
  }

  get(callId: string): TaskRecord | undefined {
    return this.#byCall.get(callId);
  }

  clear(): void {
    this.#started.clear();
    this.#byCall.clear();
  }

  /** The record a task call belongs to, joining its task's working record or starting one. */
  record(
    part: EveDynamicToolPart,
    task: ConversationTask,
    label: string | undefined,
    now: number,
  ): TaskRecord {
    const callId = part.toolCallId;
    const known = this.#byCall.get(callId) ?? this.#join(callId, task);
    if (known !== undefined) return known;
    let summary = agentTaskSummary(part.input);
    let baseName = agentDisplayName(stripTerminalControls(part.toolName));
    if (task.kind === "tool") {
      const presentation = presentTool(part.toolName, part.input, labelContext(label));
      baseName = stripTerminalControls(presentation.title);
      summary = stripTerminalControls(presentation.subtitle);
    }
    const record: TaskRecord = {
      callId,
      taskId: task.taskId,
      callIds: [callId],
      kind: task.kind,
      name: this.#uniqueName(baseName),
      toolName: part.toolName,
      input: part.input,
      label,
      purpose: summary || label,
      startedAtMs: now,
      ended: false,
    };
    this.#started.set(callId, record);
    this.#byCall.set(callId, record);
    return record;
  }

  #join(callId: string, task: ConversationTask): TaskRecord | undefined {
    for (const record of this.#started.values()) {
      if (record.ended || record.taskId !== task.taskId) continue;
      if (!record.callIds.some((id) => task.calls[id]?.status === "working")) continue;
      record.callIds.push(callId);
      this.#byCall.set(callId, record);
      return record;
    }
    return undefined;
  }

  /** Parallel tasks of one tool read `research`, `research:2`, …; a name is never renamed. */
  #uniqueName(baseName: string): string {
    const taken = new Set(
      [...this.#started.values()].filter((record) => !record.ended).map((record) => record.name),
    );
    if (!taken.has(baseName)) return baseName;
    for (let ordinal = 2; ; ordinal += 1) {
      const candidate = `${baseName}:${ordinal}`;
      if (!taken.has(candidate)) return candidate;
    }
  }
}
