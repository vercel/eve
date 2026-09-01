import { createHook, getWorkflowMetadata, getWritable } from "#compiled/@workflow/core/index.js";
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";

import {
  claimHookOwnership,
  closeHookIterator,
  disposeHook,
  isHookConflictError,
} from "#execution/hook-ownership.js";

interface PrototypeDelivery {
  readonly deliveryId: string;
  readonly message: string;
}

interface SequencedPrototypeDelivery extends PrototypeDelivery {
  readonly sequence: number;
}

type PrototypeRouterCommand =
  | ({ readonly kind: "deliver" } & PrototypeDelivery)
  | {
      readonly executorRunId: string;
      readonly executorToken: string;
      readonly generation: number;
      readonly kind: "activate";
    }
  | {
      readonly generation: number;
      readonly kind: "seal";
    }
  | {
      readonly generation: number;
      readonly kind: "complete";
      readonly processedCount: number;
    };

type PrototypeExecutorCommand =
  | { readonly delivery: SequencedPrototypeDelivery; readonly kind: "deliver" }
  | { readonly generation: number; readonly kind: "seal" };

interface PrototypeExecutorInput {
  readonly executorToken: string;
  readonly generation: number;
  readonly messageCount: number;
  readonly pendingDeliveries: readonly SequencedPrototypeDelivery[];
  readonly processedMessages: readonly string[];
  readonly routerToken: string;
  readonly sessionId: string;
  readonly writable: WritableStream<Uint8Array>;
}

export interface SuccessorPrototypeResult {
  readonly executorRunIds: readonly string[];
  readonly processedCount: number;
}

export interface SuccessorPrototypeEvent {
  readonly generation: number;
  readonly historyDepth: number;
  readonly message: string;
  readonly sequence: number;
}

/** Stable public token owned by the prototype's minimal FIFO ingress sequencer. */
export function successorPrototypeSessionToken(sessionId: string): string {
  return `${sessionId}:successor-prototype:session`;
}

function successorPrototypeExecutorToken(sessionId: string, generation: number): string {
  return `${sessionId}:successor-prototype:executor:${String(generation)}`;
}

/**
 * Executable topology proof for a stable ingress sequencer plus bounded,
 * latest-deployment successor runs. It is test-only: production semantics
 * still need cancellation, terminal delivery, and an atomic router handoff.
 */
export async function successorSessionRouterPrototypeWorkflow(input: {
  readonly messageCount: number;
}): Promise<SuccessorPrototypeResult> {
  "use workflow";

  const { workflowRunId: sessionId } = getWorkflowMetadata();
  const router = createHook<PrototypeRouterCommand>({
    token: successorPrototypeSessionToken(sessionId),
  });
  const iterator = router[Symbol.asyncIterator]();
  const writable = getWritable<Uint8Array>();

  try {
    await claimHookOwnership(router);

    const firstExecutorToken = successorPrototypeExecutorToken(sessionId, 0);
    const firstExecutorRunId = await startSuccessorExecutorStep({
      executorToken: firstExecutorToken,
      generation: 0,
      messageCount: input.messageCount,
      pendingDeliveries: [],
      processedMessages: [],
      routerToken: router.token,
      sessionId,
      writable,
    });
    const firstOwnerRunId = await waitForHookOwnerStep({ token: firstExecutorToken });

    let active = {
      executorRunId: firstOwnerRunId,
      generation: 0,
      token: firstExecutorToken,
    };
    const executorRunIds = [firstOwnerRunId];
    const heldDeliveries: SequencedPrototypeDelivery[] = [];
    let nextSequence = 0;
    let holding = false;

    // A duplicate start can lose the deterministic executor-token claim.
    // The actual owner is authoritative, not the run returned by start().
    void firstExecutorRunId;

    while (true) {
      const next = await iterator.next();
      if (next.done) throw new Error("Prototype router inbox closed before completion.");
      const command = next.value;

      if (command.kind === "deliver") {
        const delivery = { ...command, sequence: nextSequence++ };
        if (holding) {
          heldDeliveries.push(delivery);
        } else {
          await sendExecutorCommandStep({
            command: { delivery, kind: "deliver" },
            token: active.token,
          });
        }
        continue;
      }

      if (command.kind === "seal") {
        if (holding || command.generation !== active.generation) continue;
        await sendExecutorCommandStep({ command, token: active.token });
        holding = true;
        continue;
      }

      if (command.kind === "activate") {
        if (
          !holding ||
          command.generation !== active.generation + 1 ||
          command.executorToken !== successorPrototypeExecutorToken(sessionId, command.generation)
        ) {
          continue;
        }

        active = {
          executorRunId: command.executorRunId,
          generation: command.generation,
          token: command.executorToken,
        };
        executorRunIds.push(command.executorRunId);
        holding = false;

        for (const delivery of heldDeliveries.splice(0)) {
          await sendExecutorCommandStep({
            command: { delivery, kind: "deliver" },
            token: active.token,
          });
        }
        continue;
      }

      if (
        command.generation === active.generation &&
        command.processedCount === input.messageCount &&
        heldDeliveries.length === 0
      ) {
        return { executorRunIds, processedCount: command.processedCount };
      }
    }
  } finally {
    await closeHookIterator(iterator);
    await disposeHook(router);
  }
}

/** One bounded executor run: process one delivery, then start its successor. */
export async function successorSessionExecutorPrototypeWorkflow(
  input: PrototypeExecutorInput,
): Promise<void> {
  "use workflow";

  const inbox = createHook<PrototypeExecutorCommand>({ token: input.executorToken });
  const iterator = inbox[Symbol.asyncIterator]();

  try {
    try {
      await claimHookOwnership(inbox);
    } catch (error) {
      if (isHookConflictError(error)) return;
      throw error;
    }

    const pendingDeliveries = [...input.pendingDeliveries];
    const first = pendingDeliveries.shift() ?? (await waitForExecutorDelivery(iterator));
    const processedMessages = [...input.processedMessages, first.message];

    await writeSuccessorPrototypeEventStep({
      event: {
        generation: input.generation,
        historyDepth: processedMessages.length,
        message: first.message,
        sequence: first.sequence,
      },
      writable: input.writable,
    });

    if (processedMessages.length === input.messageCount) {
      await closeSuccessorPrototypeStreamStep({ writable: input.writable });
      await sendRouterCommandStep({
        command: {
          generation: input.generation,
          kind: "complete",
          processedCount: processedMessages.length,
        },
        token: input.routerToken,
      });
      return;
    }

    await sendRouterCommandStep({
      command: { generation: input.generation, kind: "seal" },
      token: input.routerToken,
    });

    while (true) {
      const next = await iterator.next();
      if (next.done) throw new Error("Prototype executor inbox closed before its handoff seal.");
      if (next.value.kind === "seal" && next.value.generation === input.generation) break;
      if (next.value.kind === "deliver") pendingDeliveries.push(next.value.delivery);
    }

    const nextGeneration = input.generation + 1;
    const nextExecutorToken = successorPrototypeExecutorToken(input.sessionId, nextGeneration);
    await startSuccessorExecutorStep({
      executorToken: nextExecutorToken,
      generation: nextGeneration,
      messageCount: input.messageCount,
      pendingDeliveries,
      processedMessages,
      routerToken: input.routerToken,
      sessionId: input.sessionId,
      writable: input.writable,
    });
    const nextOwnerRunId = await waitForHookOwnerStep({ token: nextExecutorToken });

    await sendRouterCommandStep({
      command: {
        executorRunId: nextOwnerRunId,
        executorToken: nextExecutorToken,
        generation: nextGeneration,
        kind: "activate",
      },
      token: input.routerToken,
    });
  } finally {
    await closeHookIterator(iterator);
    await disposeHook(inbox);
  }
}

async function waitForExecutorDelivery(
  iterator: AsyncIterator<PrototypeExecutorCommand>,
): Promise<SequencedPrototypeDelivery> {
  while (true) {
    const next = await iterator.next();
    if (next.done) throw new Error("Prototype executor inbox closed before a delivery.");
    if (next.value.kind === "deliver") return next.value.delivery;
  }
}

async function startSuccessorExecutorStep(input: PrototypeExecutorInput): Promise<string> {
  "use step";

  const { startWorkflowPreferLatest } = await import("#execution/workflow-runtime.js");
  const run = await startWorkflowPreferLatest(successorSessionExecutorPrototypeWorkflow, [input]);
  return run.runId;
}

async function waitForHookOwnerStep(input: { readonly token: string }): Promise<string> {
  "use step";

  const { getHookByToken } = await import("#internal/workflow/runtime.js");
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      const hook = (await getHookByToken(input.token)) as { readonly runId?: unknown };
      if (typeof hook.runId === "string" && hook.runId.length > 0) return hook.runId;
      throw new Error(`Hook "${input.token}" has no owner run id.`);
    } catch (error) {
      if (!HookNotFoundError.is(error) || Date.now() >= deadline) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  }
}

async function sendExecutorCommandStep(input: {
  readonly command: PrototypeExecutorCommand;
  readonly token: string;
}): Promise<void> {
  "use step";

  const { resumeHook } = await import("#internal/workflow/runtime.js");
  await resumeHook(input.token, input.command);
}

async function sendRouterCommandStep(input: {
  readonly command: PrototypeRouterCommand;
  readonly token: string;
}): Promise<void> {
  "use step";

  const { resumeHook } = await import("#internal/workflow/runtime.js");
  await resumeHook(input.token, input.command);
}

async function writeSuccessorPrototypeEventStep(input: {
  readonly event: SuccessorPrototypeEvent;
  readonly writable: WritableStream<Uint8Array>;
}): Promise<void> {
  "use step";

  const writer = input.writable.getWriter();
  try {
    await writer.write(new TextEncoder().encode(`${JSON.stringify(input.event)}\n`));
  } finally {
    writer.releaseLock();
  }
}

async function closeSuccessorPrototypeStreamStep(input: {
  readonly writable: WritableStream<Uint8Array>;
}): Promise<void> {
  "use step";

  const writer = input.writable.getWriter();
  try {
    await writer.close();
  } finally {
    writer.releaseLock();
  }
}

/** Old owner used by the integration proof of the non-atomic token gap. */
export async function directHookHandoffOwnerPrototypeWorkflow(input: {
  readonly finishToken: string;
  readonly stableToken: string;
}): Promise<void> {
  "use workflow";

  const stable = createHook<{ readonly kind: "release" }>({ token: input.stableToken });
  const iterator = stable[Symbol.asyncIterator]();
  try {
    await claimHookOwnership(stable);
    const command = await iterator.next();
    if (command.done || command.value.kind !== "release") {
      throw new Error("Direct handoff owner did not receive its release command.");
    }
  } finally {
    await closeHookIterator(iterator);
    await disposeHook(stable);
  }

  const finish = createHook<void>({ token: input.finishToken });
  try {
    await claimHookOwnership(finish);
    await finish;
  } finally {
    await disposeHook(finish);
  }
}

/** Successor gated so the test can observe the interval with no token owner. */
export async function directHookHandoffSuccessorPrototypeWorkflow(input: {
  readonly claimToken: string;
  readonly stableToken: string;
}): Promise<string> {
  "use workflow";

  const claim = createHook<void>({ token: input.claimToken });
  try {
    await claimHookOwnership(claim);
    await claim;
  } finally {
    await disposeHook(claim);
  }

  const stable = createHook<{ readonly message: string }>({ token: input.stableToken });
  try {
    await claimHookOwnership(stable);
    return (await stable).message;
  } finally {
    await disposeHook(stable);
  }
}
