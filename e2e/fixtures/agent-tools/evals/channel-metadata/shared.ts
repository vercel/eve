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
export const PROMPT =
  "If the `dynamic-channel-metadata` tool is available, call it and report everything it returned. " +
  "If the tool is not available, reply exactly: metadata tool unavailable. Do not ask for more information.";

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
