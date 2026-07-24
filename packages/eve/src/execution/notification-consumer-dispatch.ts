import { createLogger, logError } from "#internal/logging.js";
import { resumeHook, start } from "#internal/workflow/runtime.js";
import {
  notificationConsumerHookToken,
  type NotificationConsumerInput,
} from "#execution/notification-consumer-workflow.js";
import { notificationConsumerReference } from "#execution/workflow-runtime.js";

const log = createLogger("execution.notification-consumer");

/**
 * PROTOTYPE (issue #1170): starts the session's notification consumer run.
 * Plain `start` — no latest-deployment routing — so the consumer stays on
 * the entry's deployment with the stream writable it holds.
 */
export async function startNotificationConsumerStep(
  input: NotificationConsumerInput,
): Promise<void> {
  "use step";

  await start(notificationConsumerReference, [input]);
}

/**
 * PROTOTYPE (issue #1170): rings the consumer's dispose sentinel at session
 * end. Best-effort — a consumer that never started or already ended is not
 * an error.
 */
export async function disposeNotificationConsumerStep(input: {
  readonly sessionId: string;
}): Promise<void> {
  "use step";

  try {
    await resumeHook(notificationConsumerHookToken(input.sessionId), { kind: "dispose" });
  } catch (error) {
    logError(log, "notification consumer dispose ring failed", error, {
      sessionId: input.sessionId,
    });
  }
}
