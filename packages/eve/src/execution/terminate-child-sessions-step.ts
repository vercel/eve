import { deserializeContext } from "#context/serialize.js";
import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { hydrateDurableSession } from "#execution/session.js";
import { cancelOwnedTask } from "#execution/tasks/dispatch.js";
import { getAgentHandleStore, type AgentHandle } from "#harness/handles/store.js";
import { createLogger, logError } from "#internal/logging.js";
import { cancelRun, getWorld } from "#internal/workflow/runtime.js";
import { getSessionTaskIndex } from "#tasks/session-index.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";

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
  readonly serializedContext?: Record<string, unknown>;
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

  // Cooperatively cancel live tasks first: their runs are the single
  // writers for task state, and committing `cancelled` before the child
  // terminations below means no child termination can race a completion
  // into an ended parent. Already-terminal tasks report `unreachable`,
  // which is the expected no-op.
  const taskEntries = readSessionTaskIndex(session.state, session.sessionId);
  if (taskEntries.length > 0) {
    if (input.serializedContext === undefined) {
      throw new Error("Task finalization requires serialized runtime context.");
    }
    const ctx = await deserializeContext(input.serializedContext);
    const bundle = ctx.require(BundleKey);
    const effectiveAgent = resolveEffectiveAgentRuntime(bundle, ctx);
    const runtimeSession = hydrateDurableSession({
      durable: session,
      turnAgent: effectiveAgent.turnAgent,
    });
    for (const entry of taskEntries) {
      try {
        await cancelOwnedTask({ bundle, entry, session: runtimeSession });
      } catch (error) {
        logError(log, "failed to cancel task during parent finalization", error, {
          parentSessionId: session.sessionId,
          taskId: entry.taskId,
        });
      }
    }
  }

  const handles = (getAgentHandleStore(session.state)?.handles ?? []).filter(isLocalChildHandle);
  if (handles.length === 0) {
    return;
  }

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
      await cancelRun(await getWorld(), handle.address.sessionId, {
        cancelReason: "Parent session ended",
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

function readSessionTaskIndex(
  state: Parameters<typeof getSessionTaskIndex>[0],
  parentSessionId: string,
): ReturnType<typeof getSessionTaskIndex> {
  try {
    return getSessionTaskIndex(state);
  } catch (error) {
    logError(log, "failed to read the task index during parent finalization", error, {
      parentSessionId,
    });
    return [];
  }
}
