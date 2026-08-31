import { deserializeContext } from "#context/serialize.js";
import type { ContextContainer } from "#context/container.js";
import { getDynamicSubagentSelection } from "#context/dynamic-subagent-lifecycle.js";
import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { hydrateDurableSession } from "#execution/session.js";
import {
  resetRemoteAgentSession,
  resolveRemoteAgentForAction,
  resolveRemoteAgentStreamHeaders,
} from "#execution/remote-agent-dispatch.js";
import { cancelOwnedTask } from "#execution/tasks/parent/dispatch.js";
import { getAgentHandleStore } from "#harness/handles/store.js";
import { createLogger, logError } from "#internal/logging.js";
import { cancelRun, getWorld } from "#internal/workflow/runtime.js";
import { getSessionTaskIndex } from "#tasks/session-index.js";
import { BundleKey, type CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";

const log = createLogger("execution.terminate-child-sessions");

/**
 * Terminates children the parent holds handles to when the parent session
 * ends.
 *
 * Every nonterminal `agent/local`/`agent/self` handle is covered: `running`
 * and `parked` handles carry a confirmed address; a `starting` handle has
 * no session id yet (the child may not exist), so it is skipped with a
 * debug log rather than guessed at. Remote handles are retired through the
 * authenticated session-reset route.
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
  const handles = getAgentHandleStore(session.state)?.handles ?? [];
  const hasRemoteHandle = handles.some(
    (handle) => handle.phase !== "starting" && handle.address.kind === "agent/remote",
  );
  let runtimeContext:
    | {
        readonly bundle: CompiledBundle;
        readonly ctx: ContextContainer;
      }
    | undefined;
  if (taskEntries.length > 0 || hasRemoteHandle) {
    if (input.serializedContext === undefined) {
      throw new Error("Child finalization requires serialized runtime context.");
    }
    const ctx = await deserializeContext(input.serializedContext);
    runtimeContext = { bundle: ctx.require(BundleKey), ctx };
  }
  if (taskEntries.length > 0) {
    const { bundle, ctx } = runtimeContext!;
    const effectiveAgent = resolveEffectiveAgentRuntime(bundle, ctx);
    const runtimeSession = hydrateDurableSession({
      durable: session,
      turnAgent: effectiveAgent.turnAgent,
    });
    for (const entry of taskEntries) {
      try {
        await cancelOwnedTask({
          bundle,
          entry,
          serializedContext: input.serializedContext,
          session: runtimeSession,
        });
      } catch (error) {
        logError(log, "failed to cancel task during parent finalization", error, {
          parentSessionId: session.sessionId,
          taskId: entry.taskId,
        });
      }
    }
  }

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
      if (handle.address.kind === "agent/remote") {
        if (handle.address.credentialResolver !== undefined) {
          const resolverId = handle.address.credentialResolver.resolverId;
          const headers =
            resolverId === undefined
              ? {}
              : await resolveRemoteAgentStreamHeaders({
                  bundle: runtimeContext!.bundle,
                  name: handle.identity.name,
                  resolverId,
                  url: handle.address.url,
                });
          await resetRemoteAgentSession({
            headers,
            remote: { name: handle.identity.name, url: handle.address.url },
            sessionId: handle.address.sessionId,
          });
        } else {
          // Compatibility for handles written before resolver identity was persisted.
          const selection = getDynamicSubagentSelection(
            runtimeContext!.ctx,
            handle.identity.nodeId,
          );
          const remote = resolveRemoteAgentForAction({
            dynamicRemoteAgent: selection?.kind === "remote" ? selection.remoteAgent : undefined,
            nodeId: handle.identity.nodeId,
            registry: runtimeContext!.bundle.subagentRegistry.subagentsByNodeId,
            remoteAgentName: handle.identity.name,
          });
          if (remote.url === handle.address.url) {
            await resetRemoteAgentSession({ remote, sessionId: handle.address.sessionId });
          } else {
            await resetRemoteAgentSession({
              headers: {},
              remote: { name: handle.identity.name, url: handle.address.url },
              sessionId: handle.address.sessionId,
            });
          }
        }
      } else {
        await cancelRun(await getWorld(), handle.address.sessionId, {
          cancelReason: "Parent session ended",
        });
      }
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
