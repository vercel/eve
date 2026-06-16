import type { HandleMessageStreamEvent } from "eve/client";
import type { EveEvalTargetHandle } from "eve/evals";

/**
 * Shared helpers for the channel-metadata smoke evals. These cases verify
 * dynamic tool resolvers can read the channel's metadata projection via
 * `ctx.channel.metadata`, and that the metadata controls whether the tool
 * resolves. Sessions start through channel routes, so each case attaches to
 * the channel-created session and inspects its captured events directly;
 * cross-checks happen inside `run()` where the attached stream is in hand.
 */
export const METADATA_TOOL = "dynamic-channel-metadata";
export const PROMPT = "Call the `dynamic-channel-metadata` tool and report everything it returned.";

export async function startChannelSession(
  target: EveEvalTargetHandle,
  path: string,
  body: Record<string, unknown>,
): Promise<string> {
  const response = await target.fetch(path, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`POST ${path} failed (${response.status}): ${text}`);
  }

  const parsed = JSON.parse(text) as { sessionId?: unknown };
  if (typeof parsed.sessionId !== "string" || parsed.sessionId.length === 0) {
    throw new Error(`POST ${path} returned no sessionId: ${text}`);
  }
  return parsed.sessionId;
}

export function extractToolOutput(
  events: readonly HandleMessageStreamEvent[],
  toolName: string,
): Record<string, unknown> | undefined {
  for (const event of events) {
    if (event.type !== "action.result") continue;
    const result = event.data.result;
    if (
      result.kind === "tool-result" &&
      result.toolName === toolName &&
      typeof result.output === "object" &&
      result.output !== null
    ) {
      return result.output as Record<string, unknown>;
    }
  }
  return undefined;
}
