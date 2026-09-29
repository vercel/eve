import type { SessionInboxReader } from "#execution/session-inbox/inbox.js";
import type { SessionStateCursor } from "#execution/session/state-cursor.js";
import {
  isEarlyWritableRunMessage,
  type EarlyWritableRunMessage,
} from "#execution/tools/workflow/early-write.js";
import { writeEarlyRunMessageEventStep } from "#execution/tools/workflow/emit-workflow-tool-run-report-step.js";
import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";

/**
 * Writes the events of run messages that arrive while a model step runs, when
 * the session may write them before dispatching them (see `early-write.ts`).
 * A model step can run for a long time, and clients act on these events, such
 * as by following a session a run opened, so they can't wait for it to end.
 *
 * The model step owns the session's state, so each write runs in a step of its
 * own that writes the event and nothing else. Its dispatch waits on the cursor
 * for the next step that owns the session.
 */
export class MidStepWrites {
  private readonly cursor: SessionStateCursor;
  private readonly inbox: SessionInboxReader;
  private readonly written = new Set<WorkflowToolRunMessage>();

  constructor(inbox: SessionInboxReader, cursor: SessionStateCursor) {
    this.cursor = cursor;
    this.inbox = inbox;
  }

  /**
   * Resolves as `step` does, once every write that started while it ran has
   * finished, so the cursor adopts the step's result with those dispatches
   * still pending.
   */
  async during<T>(step: Promise<T>): Promise<T> {
    const arrivals: EarlyWritableRunMessage[] = [];
    let wake: (() => void) | undefined;
    const unsubscribe = this.inbox.onWorkflowMessage((message) => {
      if (!isEarlyWritableRunMessage(message)) return;
      arrivals.push(message);
      wake?.();
    });
    const stepSettled = step.then(
      () => "settled" as const,
      () => "settled" as const,
    );
    try {
      while (true) {
        const message = arrivals.shift();
        if (message !== undefined) {
          await this.write(message);
          continue;
        }
        const arrived = new Promise<"arrived">((resolve) => {
          wake = () => resolve("arrived");
        });
        if ((await Promise.race([stepSettled, arrived])) === "settled") break;
      }
    } finally {
      unsubscribe();
    }
    return await step;
  }

  /**
   * Whether the message's event was written while a model step ran. Admission
   * then drops the message: the event is on the stream and its dispatch is
   * pending, so handling the message again would write and dispatch it twice.
   */
  consume(message: WorkflowToolRunMessage): boolean {
    return this.written.delete(message);
  }

  private async write(message: EarlyWritableRunMessage): Promise<void> {
    const { cursor } = this;
    const pending = await writeEarlyRunMessageEventStep({
      message,
      serializedContext: cursor.serializedContext,
      sessionWritable: cursor.sessionWritable,
    });
    if (pending !== undefined) cursor.deferDispatch(pending);
    this.written.add(message);
  }
}
