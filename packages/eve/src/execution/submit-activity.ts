import type { ActivitySinkV1 } from "#channel/types.js";
import { postSessionCallbackRequest } from "#execution/session-callback-request.js";
import type { ActivityEventV1 } from "#protocol/activity.js";
import { parseActivityBatchV1 } from "#protocol/activity.js";
import { createLogger } from "#internal/logging.js";

const log = createLogger("execution.activity-submit");
const ACTIVITY_SUBMIT_TIMEOUT_MS = 2_000;

/** Submits activity to its sink without affecting the observed session. */
export async function submitActivity(input: {
  readonly sink: ActivitySinkV1 | undefined;
  readonly events: readonly ActivityEventV1[];
}): Promise<void> {
  if (input.sink === undefined || input.events.length === 0) return;
  try {
    const batch = parseActivityBatchV1({ events: input.events, version: 1 });
    if (batch === undefined) return;
    const response = await postSessionCallbackRequest({
      body: batch,
      timeoutMs: ACTIVITY_SUBMIT_TIMEOUT_MS,
      url: input.sink.url,
    });
    if (!response.ok) throw new Error(`Activity sink failed with HTTP ${response.status}.`);
  } catch {
    log.warn("activity sink request failed");
  }
}
