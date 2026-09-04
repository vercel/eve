import { deserializeContext } from "#context/serialize.js";
import type { ContextContainer } from "#context/container.js";
import { readDurableSession, type DurableSessionState } from "#execution/session/state.js";
import { resolveEffectiveAgentRuntime } from "#execution/effective-agent-config.js";
import { hydrateDurableSession } from "#execution/session.js";
import {
  resetRemoteAgentSession,
  resolveRemoteAgentStreamHeaders,
} from "#subagents/remote-dispatch.js";
import { cancelOwnedTask } from "#execution/tasks/control.js";
import { cancelBackgroundAgentTask } from "#execution/tools/subagent/task-cancel.js";
import { getAgentHandleStore } from "#subagents/handles/store.js";
import { createLogger, logError } from "#internal/logging.js";
import { dispatchSessionCommand } from "#execution/session/ingress.js";
import { waitForTurnReceipt } from "#execution/turn/admission.js";
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
export async function terminateChildSessions(input: {
  readonly serializedContext?: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<void> {
  const session = readDurableSession(input.sessionState);
  const errors: unknown[] = [];

  // Cooperatively cancel live tasks first: their runs are the single
  // writers for task state, and committing `cancelled` before the child
  // terminations below means no child termination can race a completion
  // into an ended parent. Already-terminal tasks report `unreachable`,
  // which is the expected no-op.
  const taskEntries = getSessionTaskIndex(session.state);
  const handles = getAgentHandleStore(session.state)?.handles ?? [];
  const hasRemoteHandle = handles.some(
    (handle) => "address" in handle && handle.address.kind === "agent/remote",
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
          cancelOwnedWork: cancelBackgroundAgentTask,
          entry,
          serializedContext: input.serializedContext,
          session: runtimeSession,
        });
      } catch (error) {
        errors.push(error);
        logError(log, "failed to cancel task during parent finalization", error, {
          parentSessionId: session.sessionId,
          taskId: entry.taskId,
        });
      }
    }
  }

  for (const handle of handles) {
    if (!("address" in handle)) {
      log.debug("skipping unaddressed child", {
        agentId: handle.identity.id,
        parentSessionId: session.sessionId,
      });
      continue;
    }
    try {
      if (handle.address.kind === "agent/remote") {
        const resolverId = handle.address.credentialResolver?.resolverId;
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
        const { run } = await dispatchSessionCommand(
          handle.address.sessionId,
          { kind: "reset" },
          `parent-ended:${session.sessionId}:${handle.address.sessionId}`,
        );
        await waitForTurnReceipt(run.runId);
      }
    } catch (error) {
      errors.push(error);
      logError(log, "failed to terminate child session", error, {
        agentId: handle.identity.id,
        childSessionId: handle.address.sessionId,
        kind: handle.address.kind,
        parentSessionId: session.sessionId,
      });
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, "Child termination did not complete.");
}
