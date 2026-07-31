import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { getAgentHandleStore, type AgentHandle } from "#harness/handles/store.js";
import { createLogger, logError } from "#internal/logging.js";

const log = createLogger("execution.terminate-child-sessions");

/**
 * Terminates same-deployment children the parent holds handles to when the
 * parent session ends.
 *
 * Every nonterminal `agent/local`/`agent/self` handle is covered: `running`
 * and `parked` handles carry a confirmed address; a `starting` handle has
 * no session id yet (the child may not exist), so it is skipped with a
 * debug log rather than guessed at. Remote handles are out of scope —
 * documented gap: remote children survive parent termination until a
 * remote-termination protocol exists.
 */
export async function terminateChildSessionsStep(input: {
  readonly sessionState: DurableSessionState;
}): Promise<void> {
  "use step";

  let session;
  try {
    session = await readDurableSession(input.sessionState);
  } catch (error) {
    logError(log, "failed to read child sessions for termination", error, {
      parentSessionId: input.sessionState.sessionId,
    });
    return;
  }

  const handles = (getAgentHandleStore(session.state)?.handles ?? []).filter(isLocalChildHandle);
  if (handles.length === 0) {
    return;
  }

  const runtime = createWorkflowRuntime({
    compiledArtifactsSource: { kind: "bundled" },
  });

  for (const handle of handles) {
    if (handle.phase === "starting") {
      log.debug("skipping starting child without a session id", {
        agentId: handle.identity.id,
        kind: handle.target.kind,
        parentSessionId: session.sessionId,
      });
      continue;
    }
    try {
      await runtime.dispatchSession({
        command: { kind: "reset", reason: "Parent session ended" },
        sessionId: handle.address.sessionId,
      });
    } catch (error) {
      logError(log, "failed to terminate child session", error, {
        agentId: handle.identity.id,
        childSessionId: handle.address.sessionId,
        kind: handle.address.kind,
        parentSessionId: session.sessionId,
      });
    }
  }
}

function isLocalChildHandle(handle: AgentHandle): boolean {
  const kind = handle.phase === "starting" ? handle.target.kind : handle.address.kind;
  return kind === "agent/local" || kind === "agent/self";
}
