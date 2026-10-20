import { attemptIdempotencyKey } from "#instrumentation/lifecycle.js";
import { instrumentationScope, traceStepIndex } from "#instrumentation/scope.js";
import {
  abandonInstrumentationState,
  instrumentationStateSlot,
  isInstrumentationStateAbandoned,
  releaseAllInstrumentationAttemptState,
  releaseAllInstrumentationState,
  releaseAllInstrumentationTurnState,
  type InstrumentationStateOwner,
} from "#instrumentation/state.js";
import {
  withInstrumentationDecision,
  withoutInstrumentationContent,
} from "#instrumentation/content.js";
import { createLogger, formatError } from "#internal/logging.js";
import { resolveTracePolicy } from "#shared/trace-policy.js";
import type { TraceCaptureContext } from "#shared/trace-policy.js";

import type {
  CreateInstrumentationHooksOptions,
  InstrumentationDispatchGroups,
  InstrumentationEvent,
  InstrumentationEventHandler,
  InstrumentationHooks,
  InstrumentationHooksInput,
  InstrumentationProviderDefinition,
} from "#instrumentation/lifecycle.js";

const log = createLogger("harness.instrumentation-dispatch");
const DEFAULT_HANDLER_TIMEOUT_MS = 5_000;

export function createInstrumentationDispatcher(
  input: InstrumentationHooksInput,
  options: CreateInstrumentationHooksOptions,
): InstrumentationHooks {
  const handlerTimeoutMs = options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
  const groups = normalizeDispatchGroups(input);
  const providers = [...groups.serialBefore, ...groups.parallel, ...groups.serialAfter];
  const warnedPolicyFailures = new Set<InstrumentationProviderDefinition>();

  function forTrace(trace: TraceCaptureContext): InstrumentationHooks {
    const snapshots = new WeakMap<object, unknown>();
    const decisions = new Map(
      providers.map((provider) => [
        provider,
        resolveTracePolicy(provider.tracePolicy, trace, (error) => {
          if (warnedPolicyFailures.has(provider)) return;
          warnedPolicyFailures.add(provider);
          log.warn("instrumentation provider trace policy failed", {
            error: formatError(error),
            provider: provider.name,
          });
        }),
      ]),
    );
    const capturesInputs = [...decisions.values()].some(
      (decision) => decision.action === "record" && decision.recordInputs,
    );
    const capturesOutputs = [...decisions.values()].some(
      (decision) => decision.action === "record" && decision.recordOutputs,
    );
    const capturesContent = capturesInputs || capturesOutputs;

    const publish = async (event: InstrumentationEvent): Promise<void> => {
      const snapshot = snapshotInstrumentationEvent(
        withInstrumentationDecision(event, {
          action: "record",
          recordInputs: capturesInputs,
          recordOutputs: capturesOutputs,
        }),
        snapshots,
        event,
      );
      const projections = new Map<string, InstrumentationEvent>();
      const visibleEvent = (provider: InstrumentationProviderDefinition): InstrumentationEvent => {
        const decision = decisions.get(provider);
        if (decision === undefined || decision.action === "drop") {
          return withoutInstrumentationContent(snapshot);
        }
        if (decision.recordInputs && decision.recordOutputs) return snapshot;
        const key = `${String(decision.recordInputs)}:${String(decision.recordOutputs)}`;
        let projected = projections.get(key);
        if (projected === undefined) {
          projected = withInstrumentationDecision(snapshot, decision);
          projections.set(key, projected);
        }
        return projected;
      };
      const admitted = (provider: InstrumentationProviderDefinition): boolean =>
        decisions.get(provider)?.action === "record";

      try {
        try {
          for (const provider of groups.serialBefore) {
            if (!admitted(provider)) continue;
            await dispatchToProvider(provider, snapshot, handlerTimeoutMs, () =>
              visibleEvent(provider),
            );
          }

          const parallel = groups.parallel.filter(admitted);
          if (parallel.length === 1) {
            const provider = parallel[0]!;
            await dispatchToProvider(provider, snapshot, handlerTimeoutMs, () =>
              visibleEvent(provider),
            );
          } else if (parallel.length > 1) {
            const results = await Promise.allSettled(
              parallel.map((provider) =>
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
            if (!admitted(provider)) continue;
            await dispatchToProvider(provider, snapshot, handlerTimeoutMs, () =>
              visibleEvent(provider),
            );
          }
        }
      } finally {
        releaseTerminalState(snapshot);
      }
    };

    return {
      capturesContent,
      capturesInputs,
      capturesOutputs,
      forTrace,
      publish,
    };
  }

  let loggedUnboundPublish = false;
  return {
    capturesContent: false,
    forTrace,
    async publish(event) {
      if (!loggedUnboundPublish) {
        loggedUnboundPublish = true;
        log.debug("instrumentation event published without trace binding", {
          eventType: event.type,
        });
      }
    },
  };
}

function snapshotInstrumentationEvent(
  event: InstrumentationEvent,
  snapshots: WeakMap<object, unknown>,
  source: InstrumentationEvent,
): InstrumentationEvent {
  const existing = snapshots.get(source);
  if (existing !== undefined) return existing as InstrumentationEvent;
  const snapshot = snapshotPlainValue(event, snapshots) as InstrumentationEvent;
  if ("scope" in source && "scope" in snapshot) {
    instrumentationScope(snapshot.scope, traceStepIndex(source.scope));
  }
  snapshots.set(source, snapshot);
  return snapshot;
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
  const startedBoundary =
    event.type.endsWith(".started") ||
    event.type === "delivery.consumed" ||
    event.type === "call.requested" ||
    event.type === "interaction.opened";
  const owner = stateOwner(event);
  const providerName = provider.name;
  const stateNamespace = provider.stateNamespace ?? providerName;
  if (isInstrumentationStateAbandoned(stateNamespace, event.idempotencyKey)) return;
  const handler = provider.events?.[event.type];
  if (handler === undefined) return;
  const state = instrumentationStateSlot(stateNamespace, event.idempotencyKey, owner);
  try {
    const settled = await withTimeout(
      async () => {
        const eventForProvider = visibleEvent();
        await (handler as InstrumentationEventHandler<InstrumentationEvent>)(
          provider.projectEvent === undefined
            ? eventForProvider
            : await provider.projectEvent(eventForProvider),
          { state },
        );
      },
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

/** Model calls are attempt-scoped; tool calls and input waits can outlive an attempt. */
function stateOwner(event: InstrumentationEvent): InstrumentationStateOwner {
  if (
    event.type === "delivery.consumed" ||
    (event.type === "delivery.settled" && event.outcome === "ignored") ||
    (event.type === "delivery.settled" && event.outcome === "handled") ||
    (event.type === "delivery.settled" && event.outcome === "failed")
  ) {
    return { sessionId: event.sessionId, turnId: event.turnId };
  }
  if (
    event.type === "memory.operation.started" ||
    (event.type === "memory.operation.settled" && event.outcome === "completed") ||
    (event.type === "memory.operation.settled" && event.outcome === "failed")
  ) {
    return { sessionId: event.sessionId, turnId: event.turnId };
  }
  if (!("scope" in event)) return {};
  if (event.type.startsWith("call.") || event.type.startsWith("interaction.")) {
    return { sessionId: event.scope.sessionId, turnId: event.scope.turnId };
  }
  return event.type.startsWith("model.call.") || event.type.startsWith("model.")
    ? { attemptId: attemptIdempotencyKey(event.scope) }
    : {};
}

function releaseTerminalState(event: InstrumentationEvent): void {
  if (isTerminal(event.type)) releaseAllInstrumentationState(event.idempotencyKey);
  if (event.type === "model.settled" || event.type === "model.retried") {
    releaseAllInstrumentationAttemptState(attemptIdempotencyKey(event.scope));
  }
  if (event.type === "session.ended") releaseAllInstrumentationTurnState(event.sessionId);
  if (event.type === "turn.settled" && event.outcome !== "completed") {
    releaseAllInstrumentationTurnState(event.sessionId, event.turnId);
  }
}

function isTerminal(type: InstrumentationEvent["type"]): boolean {
  return (
    type.endsWith(".completed") ||
    type.endsWith(".failed") ||
    type.endsWith(".cancelled") ||
    type.endsWith(".settled") ||
    type === "session.ended" ||
    type === "model.retried"
  );
}
