import type { ProgressCallbackV1 } from "#channel/types.js";
import { postSessionCallbackRequest } from "#execution/session-callback-request.js";
import type { ProgressEventV1 } from "#protocol/progress.js";
import { parseProgressBatchV1 } from "#protocol/progress.js";
import { createLogger } from "#internal/logging.js";

const log = createLogger("execution.progress-report");
const PROGRESS_REPORT_TIMEOUT_MS = 2_000;

/** Reports progress over the sole callback transport and never affects producer execution. */
export async function reportProgress(input: {
  readonly callback: ProgressCallbackV1 | undefined;
  readonly events: readonly ProgressEventV1[];
}): Promise<void> {
  if (input.callback === undefined || input.events.length === 0) return;
  try {
    const batch = parseProgressBatchV1({ events: input.events, version: 1 });
    if (batch === undefined) return;
    const response = await postSessionCallbackRequest({
      body: batch,
      timeoutMs: PROGRESS_REPORT_TIMEOUT_MS,
      url: input.callback.url,
    });
    if (!response.ok) throw new Error(`Progress callback failed with HTTP ${response.status}.`);
  } catch {
    log.warn("progress callback request failed");
  }
}
