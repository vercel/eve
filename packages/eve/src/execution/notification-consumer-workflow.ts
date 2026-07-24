import { createHook } from "#compiled/@workflow/core/index.js";

import { claimHookOwnership, disposeHook, isHookConflictError } from "#execution/hook-ownership.js";
import { consumeNotificationStep } from "#execution/notification-consumer-step.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";

/**
 * PROTOTYPE (issue #1170): per-session notification consumer.
 *
 * A companion run started by the session's entry workflow, parked on
 * `<sessionId>:notify`. Producers deliver curated child events with one
 * fire-and-forget `resumeHook`; each delivery runs one journaled step that
 * invokes the channel's existing adapter event handler and appends the
 * wrapped `subagent.event` to the session stream. The session workflow is
 * never woken for notifications.
 */

/** One delivery on the notify hook. */
export type NotificationConsumerDelivery =
  | {
      readonly kind: "notification";
      readonly callId: string;
      readonly childSessionId: string;
      readonly subagentName: string;
      readonly event: HandleMessageStreamEvent;
    }
  | { readonly kind: "dispose" };

export interface NotificationConsumerInput {
  readonly parentWritable: WritableStream<Uint8Array>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionId: string;
}

/** Notify hook token for one session. Producers ring this. */
export function notificationConsumerHookToken(sessionId: string): string {
  return `${sessionId}:notify`;
}

export async function notificationConsumer(rawInput: unknown): Promise<void> {
  "use workflow";

  const input = rawInput as NotificationConsumerInput;
  const hook = createHook<NotificationConsumerDelivery>({
    token: notificationConsumerHookToken(input.sessionId),
  });
  // Iterator before the claim so conflict replay is consumed by the claim,
  // not a later iterator read (same pattern as the turn inbox).
  const iterator = hook[Symbol.asyncIterator]();
  let ownsHook = false;

  try {
    try {
      await claimHookOwnership(hook);
      ownsHook = true;
    } catch (error) {
      if (isHookConflictError(error)) return;
      throw error;
    }

    while (true) {
      const next = await iterator.next();
      if (next.done || next.value.kind === "dispose") return;

      await consumeNotificationStep({
        delivery: next.value,
        parentWritable: input.parentWritable,
        serializedContext: input.serializedContext,
      });
    }
  } finally {
    if (ownsHook) await disposeHook(hook);
  }
}
