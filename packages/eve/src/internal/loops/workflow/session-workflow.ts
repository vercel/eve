import { getWorkflowMetadata, getWritable } from "#compiled/@workflow/core/index.js";

import type { RunInput, SessionCapabilities } from "#channel/types.js";
import { runSession } from "#core/index.js";
import { readChannelRequestId, readRootSessionId } from "#execution/eve-workflow-attributes.js";
import type { RunMode } from "#shared/run-mode.js";
import type { DurableCompiledArtifactsSource } from "#runtime/durable-compiled-artifacts-source.js";
import { notifyDelegatedParentStep } from "#execution/delegated-parent-notification.js";
import { createDelegatedSubagentErrorResult } from "#execution/delegated-parent-result.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import { createSessionStep } from "#execution/create-session-step.js";
import { emitTerminalSessionFailureStep } from "#execution/terminal-session-failure-step.js";
import { fireSessionCallbackStep } from "#execution/session-callback-step.js";
import { WorkflowSessionBackend } from "#internal/loops/workflow/session-backend.js";
import { readSerializedSubagentDepth } from "#harness/subagent-depth.js";

// workflow-entry.ts is the durable workflow body — the bundler rejects
// node built-ins here, so `internal/logging.ts` cannot be imported.
// Error logging happens inside `emitTerminalSessionFailureStep`.

/**
 * Serializable workflow-entry input. All runtime state travels via
 * `serializedContext`, which is produced by `serializeContext(ctx)`
 * and deserialized at each `"use step"` boundary.
 */
export interface WorkflowEntryInput {
  readonly input: RunInput["input"];
  readonly limits?: RunInput["limits"];
  readonly serializedContext: Record<string, unknown>;
}

export interface WorkflowEntryResult {
  readonly output: unknown;
}

/**
 * Long-lived workflow entrypoint. Handles both root sessions and
 * delegated child sessions: root sessions expose only parent
 * control-plane events; delegated children publish their full progress
 * on a child stream and resume the parked parent with a
 * `subagent-result` on completion.
 *
 * Owns the public delivery hook and the session lifecycle; each turn-owned
 * turn resolves its own runtime actions in-line and reports back only
 * `done`/`park` via the closed-contract {@link NextDriverAction}. The
 * only session-shape flag the driver reads (besides identity) is
 * `hasProxyInputRequests`, the documented short-circuit for hook-payload
 * routing to any descendant still active when the parent parks.
 */
export async function workflowEntry(input: WorkflowEntryInput): Promise<WorkflowEntryResult> {
  "use workflow";

  const { workflowRunId: sessionId } = getWorkflowMetadata();
  const continuationToken = (input.serializedContext["eve.continuationToken"] as string) || "";
  const mode = input.serializedContext["eve.mode"] as RunMode;
  const capabilities = input.serializedContext["eve.capabilities"] as
    | SessionCapabilities
    | undefined;
  const serializedBundle = input.serializedContext["eve.bundle"] as {
    source: DurableCompiledArtifactsSource;
    nodeId?: string;
  };

  // Seed `eve.sessionId` so the terminal failure emitter can stamp it
  // onto `session.failed` even if `createSessionStep` itself throws.
  input.serializedContext["eve.sessionId"] = sessionId;

  const driverWritable = getWritable<Uint8Array>();

  try {
    // Derived once and reused for createSession + tag emission so the
    // chain-root id can never drift between persisted session and tags.
    const rootSessionIdFromParent = readRootSessionId(input.serializedContext);
    const subagentDepth = readSerializedSubagentDepth(input.serializedContext);

    const { state: sessionState } = await createSessionStep({
      compiledArtifactsSource: serializedBundle.source,
      continuationToken,
      inheritedLimits: input.limits,
      nodeId: serializedBundle.nodeId,
      outputSchema: input.input.outputSchema,
      rootSessionId: rootSessionIdFromParent,
      sessionId,
      subagentDepth,
    });

    const backend = new WorkflowSessionBackend({ driverWritable, mode, sessionId });
    try {
      await backend.initialize(sessionState.continuationToken);
      const outcome = await runSession(backend, {
        capabilities,
        initialDelivery: {
          kind: "deliver",
          payloads: [
            {
              message: input.input.message,
              context: input.input.context,
              outputSchema: input.input.outputSchema,
            },
          ],
          requestId: readChannelRequestId(input.serializedContext),
        },
        mode,
        state: { durable: sessionState, serializedContext: input.serializedContext },
      });
      return { output: outcome.output };
    } finally {
      await backend.dispose();
    }
  } catch (error) {
    // Safety net for failures the tool-loop harness does not already
    // surface as `session.failed` (deserialization, runtime-action
    // throws, adapter `deliver` throws, staging errors, etc.) so the
    // channel still sees a terminal event.
    await emitTerminalSessionFailureStep({
      error: normalizeSerializableError(error),
      parentWritable: driverWritable,
      serializedContext: input.serializedContext,
    });
    await fireSessionCallbackStep({
      error: normalizeSerializableError(error),
      serializedContext: input.serializedContext,
      status: "failed",
    });
    await notifyDelegatedParentStep({
      result: createDelegatedSubagentErrorResult(input.serializedContext, error),
      serializedContext: input.serializedContext,
    });
    throw error;
  }
}
