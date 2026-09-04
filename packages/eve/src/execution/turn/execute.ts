import { selectDeliveries } from "#execution/turn/receipts.js";
import {
  commandDelivery,
  admitSubmissions,
  retireTaskSubmissions,
} from "#execution/turn/submissions.js";
import { getStepMetadata } from "#compiled/@workflow/core/index.js";
import type { DeliverHookPayload, HookPayload } from "#channel/types.js";
import type { InboxAddress } from "#execution/inbox/types.js";
import { sessionEvents } from "#execution/session/events.js";
import { sessionSnapshots } from "#execution/session/snapshots.js";
import { publishSessionDescriptor } from "#execution/session/directory.js";
import type { SessionResources, SnapshotRecordRef } from "#execution/session/resources.js";
import { replaceDurableSessionSnapshot } from "#execution/session/state.js";
import { createSessionState } from "#execution/session/create-state.js";
import { dispatchCoordination } from "#execution/turn/dispatch-coordination.js";
import { acknowledgeDelegatedTasks } from "#execution/tasks/dispatch.js";
import { acknowledgeWorkflowTools } from "#execution/workflow-tool/start.js";
import { getWorkflowToolRuns } from "#harness/workflow-tool-runs.js";
import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import { runModel } from "#execution/turn/model.js";
import { applyRuntimeEvents } from "#execution/turn/runtime-events.js";
import type { ModelPayload } from "#execution/turn/model-types.js";
import type {
  AcceptedSubmission,
  PendingSubmission,
  SessionCheckpoint,
  InitializedSessionCheckpoint,
  TurnExecutionResult,
  TurnProgress,
  TurnWork,
} from "#execution/turn/types.js";
import { bindTurnCallerContext, resolveInitialTurnCaller } from "#subagents/parent-notification.js";
import { buildTurnAttributes, readRootSessionId } from "#execution/eve-workflow-attributes.js";
import { setEveAttributes } from "#runtime/attributes/emit.js";
import type { DurableCompiledArtifactsSource } from "#runtime/durable-compiled-artifacts-source.js";
import type { DynamicSubagentAgentConfig } from "#runtime/subagents/dynamic-agent-config.js";
import { coalesceDeliveries } from "#harness/messages.js";
import { startSessionTimeout } from "#execution/session-timeout-steps.js";
import { sessionCommandToken } from "#execution/session-command-token.js";
import { DEFAULT_SESSION_TIMEOUT_MS } from "#execution/session-timeout.js";

export interface ExecuteTurnInput {
  readonly session: SessionResources;
  readonly owner: InboxAddress;
  readonly submission: AcceptedSubmission;
  readonly checkpoint?: SnapshotRecordRef;
  readonly work: TurnWork;
  readonly abortSignal: AbortSignal;
}

/** The only model boundary: hydrate, do work, commit, and return a small reference. */
export async function executeTurnStep(input: ExecuteTurnInput): Promise<TurnExecutionResult> {
  "use step";
  const writeId = getStepMetadata().stepId;
  const completed = await sessionSnapshots.find<InitializedSessionCheckpoint>(
    input.session.snapshots,
    writeId,
  );
  if (completed !== undefined) {
    await acknowledgeCheckpoint(completed.checkpoint);
    return { kind: "progress", progress: projectProgress(completed.ref, completed.checkpoint) };
  }
  const entered = await sessionSnapshots.find<SessionCheckpoint>(
    input.session.snapshots,
    `${writeId}:entered`,
  );
  if (entered !== undefined) {
    await publishSessionDescriptor(input.session.holderRunId, input.session);
    throw new Error("The previous execution attempt did not commit its effects.");
  }
  const loaded =
    input.checkpoint === undefined
      ? (await sessionSnapshots.latest<SessionCheckpoint>(input.session.snapshots))?.checkpoint
      : await sessionSnapshots.read<SessionCheckpoint>(input.checkpoint);
  if (
    loaded?.phase === "initialization-failed" ||
    loaded?.phase === "terminal" ||
    (loaded?.deliveries[input.submission.eventId] !== undefined && input.checkpoint === undefined)
  ) {
    return {
      kind: "receipt",
      receipt: {
        checkpoint: input.checkpoint,
        deliveries: selectDeliveries(loaded.deliveries, [input.submission.eventId]),
        terminal: loaded.phase === "terminal" || loaded.phase === "initialization-failed",
      },
    };
  }
  let checkpoint: InitializedSessionCheckpoint | undefined = loaded;
  if (checkpoint?.phase === "running" && checkpoint.writerRunId !== input.owner.ownerRunId) {
    throw new Error("The previous turn released ownership without settling its effects.");
  }
  if (checkpoint === undefined) {
    if (
      input.submission.eventId !== input.session.initialEventId ||
      input.submission.initial === undefined
    ) {
      throw new Error("A session must be initialized by its first accepted submission.");
    }
    checkpoint = await initializeCheckpoint(input);
  } else if (input.checkpoint === undefined) {
    const head = checkpoint.queue[0];
    const urgent =
      input.submission.command.kind === "cancel" ||
      input.submission.command.kind === "reset" ||
      input.submission.command.kind === "session-timeout";
    if (!urgent && head !== undefined && head.submission.eventId !== input.submission.eventId) {
      return { kind: "wait", runId: head.candidateRunId };
    }
    checkpoint = {
      ...checkpoint,
      caller:
        input.submission.command.kind === "send"
          ? (input.submission.command.caller ?? checkpoint.caller)
          : checkpoint.caller,
      queue: checkpoint.queue.filter(
        (item) => item.submission.eventId !== input.submission.eventId,
      ),
      inputs: [
        !urgent && head !== undefined
          ? head
          : { submission: input.submission, candidateRunId: input.owner.ownerRunId },
      ],
      result: undefined,
      runtimeResults: [],
      runtimeResultTimes: {},
      pendingTaskAcks: [],
      pendingToolAcks: [],
    };
    checkpoint = {
      ...checkpoint,
      serializedContext: await bindTurnCallerContext({
        caller: checkpoint.caller,
        serializedContext: checkpoint.serializedContext,
      }),
    };
  }
  if (input.checkpoint === undefined)
    checkpoint = retireTaskSubmissions(checkpoint, input.submission);
  const emission = checkpoint.state.emissionState;
  if (input.checkpoint === undefined) {
    const state = checkpoint.state;
    checkpoint = {
      ...checkpoint,
      state: replaceDurableSessionSnapshot({
        session: {
          ...state.snapshot.session,
          state: {
            ...state.snapshot.session.state,
            "eve.harness.emission": { ...emission, nextTurnId: `turn_${input.owner.ownerRunId}` },
          },
        },
      }),
    };
    await setEveAttributes(
      buildTurnAttributes({
        parentSessionId: input.session.sessionId,
        rootSessionId: readRootSessionId(checkpoint.serializedContext) ?? input.session.sessionId,
        requestId:
          input.submission.command.kind === "send" ? input.submission.command.requestId : undefined,
        serializedContext: checkpoint.serializedContext,
      }),
    );
  }
  checkpoint = {
    ...checkpoint,
    writerRunId: input.owner.ownerRunId,
    phase: "running",
    writeId: `${writeId}:entered`,
  };
  await sessionSnapshots.append(input.session.snapshots, checkpoint);
  if (input.submission.eventId === input.session.initialEventId) {
    await publishSessionDescriptor(input.session.holderRunId, input.session);
  }

  const admitted = checkpoint;
  checkpoint = await sessionEvents.withWriter(input.session.events, async (events) => {
    let state = admitted;
    if (input.work.kind !== "dispatch") {
      const envelopes = input.work.envelopes ?? [];
      const submissions = envelopes.filter((envelope) => envelope.kind === "session.submit");
      state = admitSubmissions(
        state,
        submissions.map((envelope) => envelope.payload as PendingSubmission),
      );
      const runtimeSubmissions = (state.inputs ?? []).filter(
        (item) =>
          item.submission.command.kind === "runtime" &&
          isRuntimeEvent(item.submission.command.payload),
      );
      const runtimeIds = new Set(runtimeSubmissions.map((item) => item.submission.eventId));
      const runtime = await applyRuntimeEvents({
        events: [
          ...envelopes.filter((envelope) => envelope.kind !== "session.submit"),
          ...runtimeSubmissions.map((item) => ({
            eventId: item.submission.eventId,
            kind: "runtime.result",
            payload:
              item.submission.command.kind === "runtime"
                ? item.submission.command.payload
                : undefined,
          })),
        ],
        eventsWriter: events,
        owner: input.owner,
        serializedContext: state.serializedContext,
        state: state.state,
      });
      state = {
        ...state,
        state: runtime.state,
        serializedContext: runtime.serializedContext,
        runtimeResults: [
          ...new Map(
            [...(state.runtimeResults ?? []), ...runtime.results].map((result) => [
              result.callId,
              result,
            ]),
          ).values(),
        ],
        runtimeResultTimes: { ...state.runtimeResultTimes, ...runtime.acceptedAtMsByCallId },
        deliveries: {
          ...state.deliveries,
          ...Object.fromEntries([...runtimeIds].map((id) => [id, "applied" as const])),
        },
        inputs: state.inputs?.filter((item) => !runtimeIds.has(item.submission.eventId)),
      };
      if (input.work.kind === "events") return await routePendingResponses(state, events);
    }
    if (input.work.kind === "dispatch") {
      const result = state.result;
      if (result?.action !== "park" && result?.action !== "dispatch-workflow-tasks")
        throw new Error("Turn has no pending dispatch.");
      const dispatch = await dispatchCoordination({
        action: result.action,
        parentContinuationToken: input.owner.token,
        serializedContext: state.serializedContext,
        sessionState: state.state,
      });
      state = {
        ...state,
        state: dispatch.sessionState,
        runtimeResults: dispatch.results,
        runtimeResultTimes: Object.fromEntries(
          dispatch.results.map((result) => [result.callId, Date.now()]),
        ),
        dispatched: true,
        pendingTaskAcks: [],
        pendingToolAcks: getWorkflowToolRuns(dispatch.sessionState.snapshot.session.state),
      };
      return state;
    }

    let payload: ModelPayload | undefined;
    const deliveries: DeliverHookPayload[] = [];
    const applied = { ...state.deliveries };
    const remaining = [...(state.inputs ?? [])];
    const runtimeReady = (state.runtimeResults?.length ?? 0) > 0;
    if (runtimeReady) {
      payload = {
        kind: "runtime-action-result",
        results: state.runtimeResults!,
        acceptedAtMsByCallId: state.runtimeResultTimes,
      };
    } else {
      while (remaining.length > 0) {
        const { submission } = remaining[0]!;
        const command = submission.command;
        if (command.kind === "send") {
          if (payload !== undefined) break;
          deliveries.push(commandDelivery(submission));
        } else {
          if (deliveries.length > 0 || payload !== undefined) break;
          if (command.kind === "runtime") payload = command.payload;
          else if (command.kind === "clear" || command.kind === "compact")
            payload = { kind: command.kind };
          else if (command.kind === "cancel") {
            remaining.shift();
            applied[submission.eventId] = "retired";
            return {
              ...state,
              deliveries: applied,
              inputs: remaining,
              result: parkedResult(state),
            };
          } else {
            return {
              ...state,
              result: cancelledResult(state),
            };
          }
        }
        remaining.shift();
        applied[submission.eventId] = "applied";
        if (command.kind !== "send") break;
      }
    }
    if (deliveries.length > 0) {
      const routed = await routeDeliverToChildren({
        delivery: coalesceDeliveries(deliveries),
        parentWritable: events,
        serializedContext: state.serializedContext,
        sessionState: state.state,
      });
      state = {
        ...state,
        serializedContext: routed.serializedContext ?? state.serializedContext,
        state: routed.sessionState ?? state.state,
      };
      if (routed.kind === "cancel-turn")
        return {
          ...state,
          result: cancelledResult(state),
        };
      payload = routed.remainder;
      if (payload === undefined) {
        return {
          ...state,
          deliveries: applied,
          inputs: remaining,
          result: state.result ?? parkedResult(state),
        };
      }
    }
    if (payload === undefined && state.result === undefined && (state.inputs?.length ?? 0) === 0) {
      return { ...state, result: parkedResult(state) };
    }
    const result = await runModel({
      input: payload,
      events,
      abortSignal: input.abortSignal,
      serializedContext: state.serializedContext,
      sessionState: state.state,
    });
    return {
      ...state,
      state: result.sessionState,
      serializedContext: result.serializedContext,
      result,
      deliveries: applied,
      inputs: remaining,
      runtimeResults: [],
      runtimeResultTimes: {},
      dispatched: false,
      modelWriteId: writeId,
      pendingTaskAcks: result.backgroundTasks,
      pendingToolAcks: [],
    };
  });
  const committed: InitializedSessionCheckpoint = { ...checkpoint, writeId };
  const ref = await sessionSnapshots.append(input.session.snapshots, committed);
  await acknowledgeCheckpoint(committed);
  return { kind: "progress", progress: projectProgress(ref, committed) };
}

async function acknowledgeCheckpoint(checkpoint: InitializedSessionCheckpoint): Promise<void> {
  await acknowledgeWorkflowTools({ runs: checkpoint.pendingToolAcks ?? [] });
  await acknowledgeDelegatedTasks({ tasks: checkpoint.pendingTaskAcks ?? [] });
}

function isRuntimeEvent(payload: HookPayload): boolean {
  return (
    payload.kind === "runtime-action-result" ||
    payload.kind === "subagent-input-request" ||
    payload.kind === "subagent-authorization-event"
  );
}

function parkedResult(checkpoint: InitializedSessionCheckpoint) {
  return {
    action: "park" as const,
    hasPendingAuthorization: false,
    hasPendingInputBatch: false,
    sessionState: checkpoint.state,
    serializedContext: checkpoint.serializedContext,
  };
}

function cancelledResult(checkpoint: InitializedSessionCheckpoint) {
  return {
    action: "cancelled" as const,
    sessionState: checkpoint.state,
    serializedContext: checkpoint.serializedContext,
  };
}

async function routePendingResponses(
  checkpoint: InitializedSessionCheckpoint,
  events: WritableStream<Uint8Array>,
): Promise<InitializedSessionCheckpoint> {
  let current = checkpoint;
  const inputs: PendingSubmission[] = [];
  const deliveries = { ...checkpoint.deliveries };
  for (const item of checkpoint.inputs ?? []) {
    const command = item.submission.command;
    const delivery =
      command.kind === "send"
        ? commandDelivery(item.submission)
        : command.kind === "runtime" && command.payload.kind === "deliver"
          ? command.payload
          : undefined;
    if (
      delivery === undefined ||
      delivery.payloads.some((payload) => payload.message !== undefined)
    ) {
      inputs.push(item);
      continue;
    }
    const routed = await routeDeliverToChildren({
      delivery,
      parentWritable: events,
      serializedContext: current.serializedContext,
      sessionState: current.state,
    });
    current = {
      ...current,
      state: routed.sessionState ?? current.state,
      serializedContext: routed.serializedContext ?? current.serializedContext,
    };
    if (routed.kind === "cancel-turn") {
      current = {
        ...current,
        result: cancelledResult(current),
      };
      deliveries[item.submission.eventId] = "applied";
      continue;
    }
    if (routed.remainder === undefined) deliveries[item.submission.eventId] = "applied";
    else
      inputs.push({
        ...item,
        submission: { ...item.submission, command: { kind: "runtime", payload: routed.remainder } },
      });
  }
  return { ...current, deliveries, inputs };
}

export function projectProgress(
  ref: SnapshotRecordRef,
  checkpoint: InitializedSessionCheckpoint,
): TurnProgress {
  const result = checkpoint.result;
  const pendingCallIds =
    result?.action === "dispatch-workflow-tasks"
      ? result.pendingTaskCallIds
      : result?.action === "park"
        ? result.pendingCoordinationCallIds
        : undefined;
  return {
    checkpoint: ref,
    turnId: checkpoint.state.emissionState.turnId || `turn_${checkpoint.writerRunId}`,
    taskId: checkpoint.caller?.taskId,
    action: nextAction(checkpoint, pendingCallIds),
    terminal: result?.action === "done",
    pendingCallIds,
    pendingRunIds: getWorkflowToolRuns(checkpoint.state.snapshot.session.state).map(
      (run) => run.runId,
    ),
    sleepDurationMs: result?.sleepDurationMs,
    sleepKey: checkpoint.modelWriteId,
    continuationToken: checkpoint.state.continuationToken,
    claimedContinuationToken: checkpoint.claimedContinuationToken,
  };
}

function nextAction(
  checkpoint: InitializedSessionCheckpoint,
  pendingCallIds: readonly string[] | undefined,
): TurnProgress["action"] {
  const result = checkpoint.result;
  if (result?.action === "cancelled") return "cancelled";
  if (result?.action === "done") return "settle";
  if (pendingCallIds !== undefined) {
    if (checkpoint.dispatched !== true) return "dispatch";
    return pendingCallIds.every((callId) =>
      checkpoint.runtimeResults?.some((result) => result.callId === callId),
    )
      ? "continue"
      : "wait";
  }
  if ((checkpoint.inputs?.length ?? 0) > 0 || result === undefined || result.action === "continue")
    return "continue";
  if (
    result.action === "park" &&
    result.settlement === undefined &&
    (result.hasPendingAuthorization || result.hasPendingInputBatch)
  )
    return "wait";
  return "settle";
}

async function initializeCheckpoint(
  input: ExecuteTurnInput,
): Promise<InitializedSessionCheckpoint> {
  const seed = input.submission.initial!;
  const serializedContext: Record<string, unknown> = {
    ...seed.serializedContext,
    "eve.sessionId": input.session.sessionId,
  };
  const bundle = serializedContext["eve.bundle"] as {
    source: DurableCompiledArtifactsSource;
    nodeId?: string;
  };
  const created = await createSessionState({
    compiledArtifactsSource: bundle.source,
    nodeId: bundle.nodeId,
    sessionId: input.session.sessionId,
    continuationToken: String(serializedContext["eve.continuationToken"] ?? ""),
    inheritedLimits: seed.limits,
    taskId: seed.taskId,
    rootSessionId: readRootSessionId(serializedContext),
    dynamicSubagentAgentConfig: serializedContext["eve.dynamicSubagentAgentConfig"] as
      | DynamicSubagentAgentConfig
      | undefined,
    outputSchema:
      input.submission.command.kind === "send"
        ? input.submission.command.payload.outputSchema
        : undefined,
  });
  const caller =
    input.submission.command.kind === "send"
      ? (input.submission.command.caller ?? (await resolveInitialTurnCaller({ serializedContext })))
      : undefined;
  const timeout =
    seed.sessionTimeoutMs === false
      ? undefined
      : await startSessionTimeout({
          deadline: new Date(Date.now() + (seed.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS)),
          token: sessionCommandToken(input.session.sessionId),
        });
  return {
    writeId: "initial",
    writerRunId: input.owner.ownerRunId,
    phase: "running",
    state: created.state,
    serializedContext: await bindTurnCallerContext({ caller, serializedContext }),
    caller,
    deliveries: {},
    queue: [],
    inputs: [{ submission: input.submission, candidateRunId: input.owner.ownerRunId }],
    timeoutRunId: timeout?.runId,
    activityCollectorRunId: seed.activityCollectorRunId,
  };
}
