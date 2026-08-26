import { createHook } from "#compiled/@workflow/core/index.js";

import type { ActivitySinkV1 } from "#channel/types.js";
import { createActivityObserver } from "#execution/activity-observer.js";
import {
  claimHookOwnership,
  closeHookIterator,
  disposeHook,
  isHookConflictError,
} from "#execution/hook-ownership.js";
import { parseNdjsonStream } from "#execution/ndjson-stream.js";
import { getRun } from "#internal/workflow/runtime.js";
import type { ActivityWorkIdentityV1 } from "#protocol/activity.js";
import type { MessageStreamEvent } from "#protocol/message.js";

export interface SessionEventRelayerInput {
  readonly sessionId: string;
  readonly sink: ActivitySinkV1;
  readonly workIdentity?: ActivityWorkIdentityV1;
}

/** Relays one co-located session event stream into an activity observer. */
export async function sessionEventRelayerWorkflow(input: SessionEventRelayerInput): Promise<void> {
  "use workflow";

  const ownership = createHook<void>({ token: sessionEventRelayerToken(input.sessionId) });
  const iterator = ownership[Symbol.asyncIterator]();
  let ownsHook = false;
  try {
    try {
      await claimHookOwnership(ownership);
      ownsHook = true;
    } catch (error) {
      if (isHookConflictError(error)) return;
      throw error;
    }
    await relaySessionEventsStep(input);
  } finally {
    if (ownsHook) {
      await closeHookIterator(iterator).catch(() => {});
      await disposeHook(ownership).catch(() => {});
    }
  }
}

export async function relaySessionEventsStep(input: SessionEventRelayerInput): Promise<void> {
  "use step";

  const observer = createActivityObserver(input);
  const events = parseNdjsonStream<MessageStreamEvent>(() =>
    getRun(input.sessionId).getReadable({ startIndex: 0 }),
  );
  for await (const event of events) {
    await observer.observe(event);
  }
}

export function sessionEventRelayerToken(sessionId: string): string {
  return `${sessionId}:event-relayer`;
}
