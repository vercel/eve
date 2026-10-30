import type { DynamicContext, SessionFrame } from "#dynamic/definition.js";
import { streamSessionLines } from "#execution/session-event-stream.js";
import { emptySessionView, foldLine } from "#protocol/session-projection/fold.js";
import { snapshotOf } from "#protocol/session-projection/session-view.js";
import type { SessionView } from "#protocol/session-projection/tables.js";
import { openMemos } from "#reactions/records.js";
import type { DynamicRemoteBinding } from "#reactions/remote.js";
import { latestTurn } from "#reactions/turn.js";
import { normalizeDynamicRemoteAgent } from "#runtime/subagents/dynamic-remote-agent-config.js";
import type { RemoteAgentCredentials } from "#runtime/subagents/dynamic-remote-agent-config.js";
import type { ResolvedDynamicSubagentResolver } from "#runtime/subagents/registry.js";

/**
 * Builds a dynamic remote agent's credentials from the binding its child was opened with: the
 * definition runs again with the session as the binding holds it, and memos return the bound
 * results without running. The destination it returns must be the one the child was opened at,
 * or the request fails rather than send credentials elsewhere.
 */
export async function remoteAgentCredentials(input: {
  readonly resolvers: readonly ResolvedDynamicSubagentResolver[];
  readonly nodeId: string;
  readonly binding: DynamicRemoteBinding | undefined;
  readonly destination: { readonly name: string; readonly url: string };
  readonly abortSignal?: AbortSignal;
}): Promise<RemoteAgentCredentials> {
  const resolver = input.resolvers.find(({ nodeId }) => nodeId === input.nodeId);
  const { binding } = input;
  if (resolver === undefined || binding === undefined) {
    throw new Error(
      `Remote agent "${input.destination.name}" carries credentials, but this deployment can't build them from what the session kept for its child.`,
    );
  }
  const label = resolver.logicalPath;
  const view = await foldSessionViewTo(binding.session.id, binding.position);
  const memos = openMemos({
    abortSignal: input.abortSignal ?? new AbortController().signal,
    kept: binding.memos,
    label,
    restoring:
      "a remote agent's credentials are built from the memos its child was opened with, and this memo isn't one of them. Key the memo on what the child was opened with",
    scope: `subagent:${input.nodeId}`,
    sessionId: binding.session.id,
  });
  const frame: SessionFrame = {
    channel: binding.channel,
    ...(binding.conversation !== undefined && { conversation: binding.conversation }),
    now: new Date(binding.at),
    session: binding.session,
    turn: latestTurn(view),
    view: snapshotOf(view),
  };
  const context: DynamicContext = {
    ...frame,
    memo: memos.memo,
    messages: async () => {
      throw new Error(
        `"${label}" read ctx.messages() while eve rebuilt a remote agent's credentials for its child, where the conversation as it was isn't available. Decide from the conversation inside a memo, so the child keeps the decision.`,
      );
    },
    model: { id: binding.model ?? "" },
  };
  let value: unknown;
  try {
    value = await (resolver.evaluate as (ctx: DynamicContext) => unknown)(context);
  } finally {
    memos.close();
  }
  if (value === null || value === undefined || (value as { kind?: unknown }).kind !== "remote") {
    throw destinationChanged(input.destination.name);
  }
  const built = await normalizeDynamicRemoteAgent({ name: resolver.name, value });
  if (resolver.name !== input.destination.name || built.config.url !== input.destination.url) {
    throw destinationChanged(input.destination.name);
  }
  return built.credentials ?? {};
}

function destinationChanged(name: string): Error {
  return new Error(
    `Remote agent "${name}" now resolves to another destination than the one its child was opened at, so eve doesn't send its credentials. Open a new child.`,
  );
}

/** The session's public view folded from its stream up to `position`, as a client would. */
async function foldSessionViewTo(sessionId: string, position: number): Promise<SessionView> {
  const view = emptySessionView();
  for await (const { line, position: at } of streamSessionLines(sessionId, { follow: false })) {
    if (at > position) break;
    if (line !== undefined) foldLine(view, line, at);
  }
  return view;
}
