import type { ModelMessage } from "ai";

import { loadContext } from "#context/container.js";
import { requeueDynamicSkillAnnouncement } from "#context/dynamic-skill-lifecycle.js";
import { clearReadFileState } from "#execution/tools/file-state.js";
import { getTodoCompactionMessage } from "#execution/tools/todo.js";
import { requeueTaskStateAnnouncement } from "#tasks/delivery-context.js";
import { requeueDeliveryInstruction } from "#tasks/delivery-policy.js";

/** Requeues framework announcements after durable history is replaced. */
export function requeueFrameworkPromptAnnouncements(): void {
  const ctx = loadContext();
  requeueDynamicSkillAnnouncement(ctx);
  requeueTaskStateAnnouncement(ctx);
  requeueDeliveryInstruction(ctx);
}

/**
 * Re-applies framework-owned state preservation after the harness compacts
 * message history, returning any messages to append to the compacted history.
 *
 * Runs the framework's built-in preservation steps:
 * - resets read-before-write tracking, so a write after compaction re-reads
 *   the file whose read evidence was summarized away;
 * - re-injects the todo list (when present), so the model keeps its task list.
 *
 * Must be called inside the harness step's `AlsContext`; both steps read
 * durable context state.
 */
export function preserveFrameworkStateOnCompaction(): readonly ModelMessage[] {
  requeueFrameworkPromptAnnouncements();
  clearReadFileState();
  const todo = getTodoCompactionMessage();
  return todo === undefined ? [] : [todo];
}
