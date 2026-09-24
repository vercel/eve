import { deserializeContext } from "#context/serialize.js";
import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import {
  resetRemoteAgentSession,
  resolveRemoteAgentStreamHeaders,
} from "#subagents/remote-dispatch.js";
import { createLogger, logError } from "#internal/logging.js";
import { cancelRun, getWorld } from "#internal/workflow/runtime.js";
import { BundleKey, type CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import { getTaskTable } from "#tasks/state.js";

const log = createLogger("execution.terminate-child-sessions");

/**
 * Terminates every child session the owner has an address for when the
 * owner session ends. Local children are stopped; remote children are
 * retired through the authenticated session-reset route. A task whose child
 * never reported its address has nothing to stop.
 */
export async function terminateChildSessionsStep(input: {
  readonly serializedContext?: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}): Promise<void> {
  "use step";

  let session;
  try {
    session = readDurableSession(input.sessionState);
  } catch (error) {
    logError(log, "failed to read child sessions for termination", error, {
      parentSessionId: input.sessionState.sessionId,
    });
    return;
  }

  const records = getTaskTable(session).records.filter((record) => record.child !== undefined);
  if (records.length === 0) return;
  let bundle: CompiledBundle | undefined;
  if (records.some((record) => record.child?.kind === "remote")) {
    if (input.serializedContext === undefined) {
      throw new Error("Child finalization requires serialized runtime context.");
    }
    bundle = (await deserializeContext(input.serializedContext)).require(BundleKey);
  }

  for (const record of records) {
    const child = record.child!;
    try {
      if (child.kind === "remote") {
        const headers =
          child.credentialResolver === undefined
            ? {}
            : await resolveRemoteAgentStreamHeaders({
                bundle: bundle!,
                name: record.name,
                resolverId: child.credentialResolver,
                url: child.url,
              });
        await resetRemoteAgentSession({
          headers,
          remote: { name: record.name, url: child.url },
          sessionId: child.sessionId,
        });
      } else if (child.kind === "local") {
        await cancelRun(await getWorld(), child.sessionId, {
          cancelReason: "Parent session ended",
        });
      }
    } catch (error) {
      logError(log, "failed to terminate child session", error, {
        childKind: child.kind,
        parentSessionId: session.sessionId,
        taskId: record.id,
      });
    }
  }
}
