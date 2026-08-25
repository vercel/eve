import {
  abandonInstrumentationState,
  instrumentationStateSlot,
  isInstrumentationStateAbandoned,
  releaseAllInstrumentationAttemptState,
  releaseAllInstrumentationState,
  releaseAllInstrumentationTurnState,
  takeInstrumentationActionScopes,
  type InstrumentationStateOwner,
} from "#instrumentation/state.js";
import { withoutInstrumentationContent } from "#instrumentation/content.js";
import { createLogger, formatError } from "#internal/logging.js";

import type {
  CreateInstrumentationHooksOptions,
  InstrumentationActionFailedEvent,
  InstrumentationDispatchGroups,
  InstrumentationEvent,
  InstrumentationEventHandler,
  InstrumentationHooks,
  InstrumentationHooksInput,
  InstrumentationProviderDefinition,
  InstrumentationSessionFailedEvent,
  InstrumentationSessionSettledEvent,
  InstrumentationTurnFailedEvent,
  InstrumentationTurnSettledEvent,
} from "#instrumentation/lifecycle.js";

const log = createLogger("harness.instrumentation-dispatch");
const DEFAULT_HANDLER_TIMEOUT_MS = 5_000;

export function createInstrumentationDispatcher(
  input: InstrumentationHooksInput,
  options: CreateInstrumentationHooksOptions,
): InstrumentationHooks {
  const handlerTimeoutMs = options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
  const groups = normalizeDispatchGroups(input);
  const snapshots = new WeakMap<object, unknown>();
  const providers = [...groups.serialBefore, ...groups.parallel, ...groups.serialAfter];
  const capturesContent = providers.some((provider) => provider.capture === "content");

  const publish = async (event: InstrumentationEvent): Promise<void> => {
    const snapshot = snapshotInstrumentationEvent(event, snapshots);
    const cleanupSession =
      snapshot.type === "session.completed" || snapshot.type === "session.failed";
    const cleanupTurn = snapshot.type === "turn.cancelled" || snapshot.type === "turn.failed";
    if (cleanupSession || cleanupTurn) {
      const pendingActions = takeInstrumentationActionScopes(
        snapshot.sessionId,
        cleanupTurn ? snapshot.turnId : undefined,
      );
      const failure = terminalActionFailure(snapshot);
      for (const action of pendingActions) {
        await publish({
          ...failure,
          idempotencyKey: action.idempotencyKey,
          scope: action.scope,
          type: "action.failed",
        });
      }
    }

    let stripped: InstrumentationEvent | undefined;
    const visibleEvent = (provider: InstrumentationProviderDefinition): InstrumentationEvent => {
      if (provider.capture === "content") return snapshot;
      stripped ??= withoutInstrumentationContent(snapshot);
      return stripped;
    };

    try {
      try {
        for (const provider of groups.serialBefore) {
          await dispatchToProvider(provider, snapshot, handlerTimeoutMs, () =>
            visibleEvent(provider),
          );
        }

        if (groups.parallel.length === 1) {
          const provider = groups.parallel[0]!;
          await dispatchToProvider(provider, snapshot, handlerTimeoutMs, () =>
            visibleEvent(provider),
          );
        } else if (groups.parallel.length > 1) {
          const results = await Promise.allSettled(
            groups.parallel.map((provider) =>
              dispatchToProvider(provider, snapshot, handlerTimeoutMs, () =>
                visibleEvent(provider),
              ),
            ),
          );
          const rejected = results.find(
            (result): result is PromiseRejectedResult => result.status === "rejected",
          );
          if (rejected !== undefined) throw rejected.reason;
        }
      } finally {
        for (const provider of groups.serialAfter) {
          await dispatchToProvider(provider, snapshot, handlerTimeoutMs, () =>
            visibleEvent(provider),
          );
        }
      }
    } finally {
      releaseTerminalState(snapshot);
    }
  };

  return { capturesContent, publish };
}

function snapshotInstrumentationEvent(
  event: InstrumentationEvent,
  snapshots: WeakMap<object, unknown>,
): InstrumentationEvent {
  return snapshotPlainValue(event, snapshots) as InstrumentationEvent;
}

function snapshotPlainValue(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (Array.isArray(value)) {
    const existing = seen.get(value);
    if (existing !== undefined) return existing;
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const entry of value) copy.push(snapshotPlainValue(entry, seen));
    return Object.freeze(copy);
  }

  if (typeof value !== "object" || value === null) return value;
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
  } catch {
    return value;
  }
  if (prototype !== Object.prototype && prototype !== null) return value;

  const existing = seen.get(value);
  if (existing !== undefined) return existing;
  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, entry] of Object.entries(value)) {
    copy[key] = snapshotPlainValue(entry, seen);
  }
  return Object.freeze(copy);
}

function normalizeDispatchGroups(
  input: InstrumentationHooksInput,
): Required<InstrumentationDispatchGroups> {
  if (!Array.isArray(input)) {
    const groups = input as InstrumentationDispatchGroups;
    return {
      parallel: groups.parallel ?? [],
      serialAfter: groups.serialAfter ?? [],
      serialBefore: groups.serialBefore ?? [],
    };
  }

  return {
    parallel: [],
    serialAfter: [],
    serialBefore: input.map((provider, index) => ({
      ...provider,
      name: provider.name ?? `provider-${String(index)}`,
    })),
  };
}

async function dispatchToProvider(
  provider: InstrumentationProviderDefinition,
  event: InstrumentationEvent,
  handlerTimeoutMs: number,
  visibleEvent: () => InstrumentationEvent,
): Promise<void> {
  const startedBoundary = event.type.endsWith(".started") || event.type === "input.requested";
  const owner = stateOwner(event);
  const providerName = provider.name;
  const stateNamespace = provider.stateNamespace ?? providerName;
  if (isInstrumentationStateAbandoned(stateNamespace, event.idempotencyKey)) return;
  const handler = provider.events?.[event.type];
  if (handler === undefined) return;
  const state = instrumentationStateSlot(stateNamespace, event.idempotencyKey, owner);
  try {
    const settled = await withTimeout(
      () =>
        (handler as InstrumentationEventHandler<InstrumentationEvent>)(visibleEvent(), { state }),
      handlerTimeoutMs,
      () => {
        state.revoke();
        if (startedBoundary) {
          abandonInstrumentationState(stateNamespace, event.idempotencyKey, owner);
        }
      },
    );
    if (!settled) {
      log.warn("instrumentation provider timed out", {
        boundary: event.type,
        provider: providerName,
        timeoutMs: handlerTimeoutMs,
      });
    }
  } catch (error) {
    log.warn("instrumentation provider failed", {
      boundary: event.type,
      error: formatError(error),
      provider: providerName,
    });
  } finally {
    state.revoke();
  }
}

async function withTimeout(
  run: () => void | PromiseLike<void>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(run()).then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          onTimeout();
          resolve(false);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Model and SDK tool children are scoped to an attempt; durable pairs are not. */
function stateOwner(event: InstrumentationEvent): InstrumentationStateOwner {
  if (
    event.type === "channel.delivery.started" ||
    event.type === "channel.delivery.cancelled" ||
    event.type === "channel.delivery.completed" ||
    event.type === "channel.delivery.failed"
  ) {
    return { sessionId: event.sessionId, turnId: event.turnId };
  }
  if (!("scope" in event)) return {};
  if (event.type.startsWith("action.") || event.type.startsWith("input.")) {
    return { sessionId: event.scope.sessionId, turnId: event.scope.turnId };
  }
  return event.type.startsWith("model.call.") ||
    event.type.startsWith("tool.call.") ||
    event.type.startsWith("step.attempt.")
    ? { attemptId: event.scope.attemptId }
    : {};
}

function releaseTerminalState(event: InstrumentationEvent): void {
  if (isTerminal(event.type)) releaseAllInstrumentationState(event.idempotencyKey);
  if (event.type === "step.attempt.completed" || event.type === "step.attempt.failed") {
    releaseAllInstrumentationAttemptState(event.scope.attemptId);
  }
  if (event.type === "session.completed" || event.type === "session.failed") {
    releaseAllInstrumentationTurnState(event.sessionId);
  }
  if (event.type === "turn.cancelled" || event.type === "turn.failed") {
    releaseAllInstrumentationTurnState(event.sessionId, event.turnId);
  }
}

function terminalActionFailure(
  event:
    | InstrumentationSessionFailedEvent
    | InstrumentationSessionSettledEvent
    | InstrumentationTurnFailedEvent
    | InstrumentationTurnSettledEvent,
): Pick<InstrumentationActionFailedEvent, "error" | "errorCode" | "outcome"> {
  if (event.type === "session.failed" || event.type === "turn.failed") {
    return { error: event.error, outcome: "failed" };
  }
  if (event.type === "turn.cancelled") {
    return {
      error: new Error("The action was cancelled with its turn."),
      errorCode: "ACTION_CANCELLED",
      outcome: "cancelled",
    };
  }
  return {
    error: new Error("The session completed before the action settled."),
    errorCode: "ACTION_ABANDONED",
    outcome: "abandoned",
  };
}

function isTerminal(type: InstrumentationEvent["type"]): boolean {
  return (
    type.endsWith(".completed") ||
    type.endsWith(".failed") ||
    type.endsWith(".cancelled") ||
    type === "input.resolved"
  );
}
