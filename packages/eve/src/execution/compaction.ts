import type { ModelMessage } from "ai";

import { clearReadFileState } from "#runtime/framework-tools/file-state.js";
import { getTodoCompactionMessage } from "#runtime/framework-tools/todo.js";

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
  clearReadFileState();
  const todo = getTodoCompactionMessage();
  return todo === undefined ? [] : [todo];
}
