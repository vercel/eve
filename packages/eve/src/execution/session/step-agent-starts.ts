import type {
  SessionInboxPayload,
  SessionInboxReader,
  WorkflowToolRunAgentStarted,
} from "#execution/session-inbox/inbox.js";
import type { SessionStateCursor } from "#execution/session/state-cursor.js";
import { emitAgentStartedStep } from "#execution/tools/workflow/emit-workflow-tool-run-report-step.js";

/**
 * Publishes a run's `agent.started` as it arrives while a model step runs. The
 * step lasts as long as the model thinks, and clients follow a child from its
 * `agent.started`, so the event can't wait for the boundary.
 *
 * The step's delta applies to the state the step was given, so nothing
 * published during it may change that state. `agent.started` reaches no
 * channel handler and changes no activity, so its publication leaves the
 * state as it found it and is not adopted. Every other run message waits for
 * the boundary.
 */
export class StepAgentStarts {
  private readonly cursor: SessionStateCursor;
  private readonly inbox: SessionInboxReader;
  private readonly published = new Set<SessionInboxPayload>();

  constructor(inbox: SessionInboxReader, cursor: SessionStateCursor) {
    this.cursor = cursor;
    this.inbox = inbox;
  }

  async publishWhile<T>(step: Promise<T>): Promise<T> {
    const arrivals: WorkflowToolRunAgentStarted[] = [];
    let wake: (() => void) | undefined;
    const unsubscribe = this.inbox.onAgentStarted((message) => {
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
          await emitAgentStartedStep({ ...this.cursor.stepState(), message });
          this.published.add(message);
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

  /** Whether the payload was published already, so admission skips it. */
  consume(payload: SessionInboxPayload): boolean {
    return this.published.delete(payload);
  }
}
