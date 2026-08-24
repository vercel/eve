import type { RunMessage } from "#execution/tool-run/messages.js";
import { resumeHook } from "#internal/workflow/runtime.js";

/**
 * Sends one message to an address. The whole run-to-owner transport: a hook
 * token and `resumeHook`. A missing hook means the addressee is gone and the
 * call throws; callers that tolerate an absent owner catch that themselves.
 */
export async function tell(replyTo: string, message: RunMessage): Promise<void> {
  "use step";

  await resumeHook(replyTo, message);
}
