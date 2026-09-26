import type {
  SessionInboxPayload,
  SessionInboxReader,
  WorkflowToolRunAnnouncement,
} from "#execution/session-inbox/inbox.js";

/**
 * Publishes run announcements, such as a task's `agent.started`, as they
 * arrive while a model step runs. The step lasts as long as the model thinks,
 * and clients stream a child from its `agent.started`. Other messages wait for
 * the boundary because they change state the step also writes.
 */
export class StepAnnouncements {
  private readonly inbox: SessionInboxReader;
  private readonly published = new Set<SessionInboxPayload>();

  constructor(inbox: SessionInboxReader) {
    this.inbox = inbox;
  }

  async publishWhile<T>(
    step: Promise<T>,
    publish: (message: WorkflowToolRunAnnouncement) => Promise<void>,
  ): Promise<T> {
    const arrivals: WorkflowToolRunAnnouncement[] = [];
    let wake: (() => void) | undefined;
    const unsubscribe = this.inbox.onAnnouncement((message) => {
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
          await publish(message);
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
