import { getWorkflowMetadata } from "#compiled/@workflow/core/index.js";
import { STUB_CONTEXT_KEY, type StubScope } from "#tool-stubs/types.js";
import { withStubPlayback } from "#execution/tool-stubs/playback.js";
import type { SessionCapabilities, TurnCaller } from "#channel/types.js";
import type { AgentWorkflowRetentionDefinition } from "#shared/agent-definition.js";
import { resolveInitialTurnCallerStep } from "#subagents/parent-notification.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { HarnessModelMessage } from "#harness/messages.js";
import type { SessionEnd, SessionStart } from "#execution/session/scheduler/state.js";
import { SessionLoop } from "#execution/session/session-loop.js";
import { createTurnControl, type TurnControl } from "#execution/session/turn-control.js";
import { SessionStateCursor } from "#execution/session/state-cursor.js";
import { finalizeSession, type SessionTerminalOutcome } from "#execution/session/finalization.js";
import type { SessionInboxHandle } from "#execution/session-inbox/inbox.js";
import type { SessionTimeoutControl } from "#execution/session/timeout-control.js";
import { SessionHandoff, sessionAnchorToken } from "#execution/session/handoff.js";
import { signalSessionAnchorStep } from "#execution/session/handoff-steps.js";
import type { WorkflowEntryResult } from "#execution/session/entry-input.js";

export type { SessionStart } from "#execution/session/scheduler/state.js";

function createSafeOuterWorkflowError(): Error {
  const error = new Error("Agent workflow failed. Inspect the private session trace for details.");
  error.name = "EveWorkflowFailure";
  return error;
}

/** A successor reports to the original owner, which anchors the public stream. */
export type SessionAnchor =
  | { readonly kind: "self"; readonly notify?: (result: WorkflowEntryResult) => Promise<void> }
  | { readonly kind: "successor" };

export interface SessionBoot {
  readonly admittedDeliveryKeys: readonly string[];
  readonly anchor: SessionAnchor;
  readonly caller: TurnCaller | undefined;
  readonly capabilities?: SessionCapabilities;
  readonly deploymentId: string;
  readonly history: HarnessModelMessage[];
  readonly initialTurnControl?: TurnControl;
  readonly start: SessionStart;
  readonly retention?: AgentWorkflowRetentionDefinition;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionId: string;
  readonly sessionState: DurableSessionState;
  readonly sessionTimeoutControl?: SessionTimeoutControl;
  readonly sessionTimeoutMs: number | false;
  readonly sessionWritable: WritableStream<Uint8Array>;
}

type SessionLoopOutcome =
  | { readonly kind: "terminal"; readonly outcome: SessionTerminalOutcome }
  | { readonly kind: "transferred" };

/** Runs an already prepared owner against its session's existing stream. */
export async function runPreparedSession(
  boot: SessionBoot,
  inbox: SessionInboxHandle,
): Promise<WorkflowEntryResult> {
  const scope = boot.serializedContext[STUB_CONTEXT_KEY] as StubScope | undefined;
  if (scope !== undefined && scope.rootSessionId === undefined) {
    boot.serializedContext[STUB_CONTEXT_KEY] = { ...scope, rootSessionId: boot.sessionId };
  }
  const cursor = new SessionStateCursor({
    history: boot.history,
    inbox,
    sessionWritable: boot.sessionWritable,
    serializedContext: boot.serializedContext,
    sessionState: boot.sessionState,
  });
  const handoff = new SessionHandoff({
    checkpoint: {
      capabilities: boot.capabilities,
      retention: boot.retention,
      sessionTimeoutMs: boot.sessionTimeoutMs,
    },
    deploymentId: boot.deploymentId,
    inbox,
    isInitialOwner: boot.anchor.kind === "self",
    sessionId: boot.sessionId,
  });
  const session = new SessionLoop({
    admittedDeliveryKeys: boot.admittedDeliveryKeys,
    caller: boot.caller,
    capabilities: boot.capabilities,
    cursor,
    handoff,
    inbox,
    sessionId: boot.sessionId,
    ownerRunId: getWorkflowMetadata().workflowRunId,
    sessionTimeoutControl: boot.sessionTimeoutControl,
    start: boot.start,
  });
  let result: WorkflowEntryResult = { output: "", isError: true };
  let loop: SessionLoopOutcome | undefined;
  let terminalEmitted = false;
  try {
    result = await withStubPlayback(scope, boot.sessionId, async () => {
      try {
        const end = await runSession(boot, session);
        loop =
          end.kind === "expired" && inbox.takenOver
            ? await handoff.adoptTakeover()
            : outcomeOf(end);
      } finally {
        await inbox.dispose();
      }
      if (loop.kind === "transferred") {
        if (boot.anchor.kind !== "self") return { output: "" };
        result = await handoff.awaitAnchoredResult();
        return result;
      }
      result = await finalizeSession(loop.outcome, {
        caller: session.caller,
        cursor,
        sessionWritable: boot.sessionWritable,
      });
      terminalEmitted = true;
      return result;
    });
    return result;
  } catch (error) {
    if (!terminalEmitted) {
      await finalizeSession(
        { error, kind: "failed", turnId: session.turnId },
        { caller: session.caller, cursor, sessionWritable: boot.sessionWritable },
      );
    }
    throw createSafeOuterWorkflowError();
  } finally {
    await inbox.dispose();
    await reportResultToAnchor(boot, result, handoff, loop);
  }
}

/** Reports a boot failure before any turn could bind its caller. */
export async function failSession(input: {
  readonly error: unknown;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionId: string;
  readonly sessionState: DurableSessionState | undefined;
  readonly sessionWritable: WritableStream<Uint8Array>;
}): Promise<never> {
  let caller: TurnCaller | undefined;
  try {
    caller = await resolveInitialTurnCallerStep({ serializedContext: input.serializedContext });
  } catch {
    // A repeated resolution failure leaves no reachable caller to notify.
  }
  await finalizeSession(
    { error: input.error, kind: "failed" },
    {
      caller,
      cursor: { serializedContext: input.serializedContext, sessionState: input.sessionState },
      sessionWritable: input.sessionWritable,
    },
  );
  throw createSafeOuterWorkflowError();
}

async function reportResultToAnchor(
  boot: SessionBoot,
  result: WorkflowEntryResult,
  handoff: SessionHandoff,
  loop: SessionLoopOutcome | undefined,
): Promise<void> {
  switch (boot.anchor.kind) {
    case "self":
      await handoff.disposeAnchor();
      await boot.anchor.notify?.(result);
      return;
    case "successor":
      if (loop?.kind === "transferred") return;
      await signalSessionAnchorStep({ result, token: sessionAnchorToken(boot.sessionId) });
      return;
  }
}

async function runSession(boot: SessionBoot, session: SessionLoop): Promise<SessionEnd> {
  const timeout = boot.sessionTimeoutControl;
  try {
    return await session.run({
      control:
        boot.initialTurnControl ?? (boot.anchor.kind === "self" ? createTurnControl() : undefined),
      startup: timeout?.start(),
    });
  } finally {
    await timeout?.dispose();
  }
}

function outcomeOf(end: SessionEnd): SessionLoopOutcome {
  switch (end.kind) {
    case "transferred":
      return { kind: "transferred" };
    case "done":
      return { kind: "terminal", outcome: { action: end.outcome, kind: "done" } };
    case "expired":
      return { kind: "terminal", outcome: end };
  }
}
