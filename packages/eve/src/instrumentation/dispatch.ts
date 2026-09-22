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
import {
  withInstrumentationDecision,
  withoutInstrumentationContent,
} from "#instrumentation/content.js";
import { createLogger, formatError } from "#internal/logging.js";
import { parseJsonValue, type JsonValue } from "#shared/json.js";
import { resolveTracePolicy } from "#shared/trace-policy.js";
import type { TraceCaptureContext, UnclassifiedTraceCaptureContext } from "#shared/trace-policy.js";

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
const CLASSIFICATION_FAILED = Symbol("classification-failed");

export function createInstrumentationDispatcher(
  input: InstrumentationHooksInput,
  options: CreateInstrumentationHooksOptions,
): InstrumentationHooks {
  const handlerTimeoutMs = options.handlerTimeoutMs ?? DEFAULT_HANDLER_TIMEOUT_MS;
  const groups = normalizeDispatchGroups(input);
  const providers = [...groups.serialBefore, ...groups.parallel, ...groups.serialAfter];
  const classifiers = providers.filter((provider) => provider.classificationPolicy !== undefined);
  if (classifiers.length > 1) {
    throw new Error(
      `Instrumentation declares classificationPolicy more than once: ${classifiers.map((provider) => provider.name).join(", ")}.`,
    );
  }
  const classifier = classifiers[0];
  const warnedPolicyFailures = new Set<InstrumentationProviderDefinition>();

  function bindTrace(
    trace: UnclassifiedTraceCaptureContext,
    traceClassification: JsonValue | undefined,
    classificationPrepared: boolean,
  ): InstrumentationHooks {
    const snapshots = new WeakMap<object, unknown>();
    const decisions = new Map(
      providers.map((provider) => [
        provider,
        classifier !== undefined && !classificationPrepared
          ? { action: "drop" as const }
          : resolveTracePolicy(
              provider.tracePolicy,
              classifiedTrace(trace, traceClassification),
              (error) => {
                if (warnedPolicyFailures.has(provider)) return;
                warnedPolicyFailures.add(provider);
                log.warn("instrumentation provider trace policy failed", {
                  error: formatError(error),
                  provider: provider.name,
                });
              },
            ),
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
      let recordClassification = traceClassification;
      let classificationFailed = classifier !== undefined && !classificationPrepared;
      if (classifier !== undefined && classificationPrepared) {
        let classificationRecord: InstrumentationEvent;
        try {
          classificationRecord = visibleEvent(classifier);
          for (const provider of providers) {
            if (provider.projectEvent === undefined) continue;
            classificationRecord = await provider.projectEvent(classificationRecord);
          }
        } catch (error) {
          log.warn("instrumentation classification projection failed", {
            error: formatError(error),
          });
          classificationFailed = true;
          classificationRecord = withoutInstrumentationContent(snapshot);
        }
        if (!classificationFailed) {
          const classification = await classify(
            classifier,
            {
              boundary: "record",
              record: classificationRecord,
              trace,
              traceClassification: traceClassification!,
            },
            handlerTimeoutMs,
          );
          if (classification === CLASSIFICATION_FAILED) {
            classificationFailed = true;
          } else {
            recordClassification = classification;
          }
        }
      }

      try {
        try {
          if (classificationFailed) return;
          for (const provider of groups.serialBefore) {
            if (!admitted(provider)) continue;
            await dispatchToProvider(
              provider,
              snapshot,
              handlerTimeoutMs,
              () => visibleEvent(provider),
              recordClassification,
            );
          }

          const parallel = groups.parallel.filter(admitted);
          if (parallel.length === 1) {
            const provider = parallel[0]!;
            await dispatchToProvider(
              provider,
              snapshot,
              handlerTimeoutMs,
              () => visibleEvent(provider),
              recordClassification,
            );
          } else if (parallel.length > 1) {
            const results = await Promise.allSettled(
              parallel.map((provider) =>
                dispatchToProvider(
                  provider,
                  snapshot,
                  handlerTimeoutMs,
                  () => visibleEvent(provider),
                  recordClassification,
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
            if (!classificationFailed && !admitted(provider)) continue;
            await dispatchToProvider(
              provider,
              snapshot,
              handlerTimeoutMs,
              () =>
                classificationFailed
                  ? withoutInstrumentationContent(snapshot)
                  : visibleEvent(provider),
              classificationFailed ? undefined : recordClassification,
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
      classification: traceClassification,
      forTrace,
      publish,
    };
  }

  function forTrace(trace: TraceCaptureContext): InstrumentationHooks {
    return bindTrace(trace, undefined, classifier === undefined);
  }

  async function prepareTrace(trace: TraceCaptureContext): Promise<InstrumentationHooks> {
    if (classifier === undefined) return bindTrace(trace, undefined, true);
    const classification = await classify(
      classifier,
      { boundary: "trace", trace },
      handlerTimeoutMs,
    );
    return bindTrace(
      trace,
      classification === CLASSIFICATION_FAILED ? undefined : classification,
      classification !== CLASSIFICATION_FAILED,
    );
  }

  let loggedUnboundPublish = false;
  return {
    capturesContent: false,
    forTrace,
    prepareTrace,
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
  classification: JsonValue | undefined,
): Promise<void> {
  const startedBoundary = event.type.endsWith(".started") || event.type === "input.requested";
  const owner = stateOwner(event);
  const providerName = provider.name;
  const stateNamespace = provider.stateNamespace ?? providerName;
  if (isInstrumentationStateAbandoned(stateNamespace, event.idempotencyKey)) return;
  const handler = provider.events?.[event.type];
  if (handler === undefined) return;
  const state = instrumentationStateSlot(stateNamespace, event.idempotencyKey, owner);
  const controller = new AbortController();
  try {
    const settled = await withTimeout(
      async () => {
        const visible = visibleEvent();
        const eventForProvider =
          provider.projectEvent === undefined ? visible : await provider.projectEvent(visible);
        const execute = () =>
          (handler as InstrumentationEventHandler<InstrumentationEvent>)(
            eventForProvider,
            classification === undefined ? { state } : { classification, state },
          );
        if (provider.runWithClassification === undefined) {
          await execute();
        } else {
          await provider.runWithClassification(classification, execute);
        }
      },
      handlerTimeoutMs,
      () => {
        controller.abort(new Error("Instrumentation provider timed out."));
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

function classifiedTrace(
  trace: UnclassifiedTraceCaptureContext,
  classification: JsonValue | undefined,
): TraceCaptureContext<JsonValue> | UnclassifiedTraceCaptureContext {
  return classification === undefined ? trace : { ...trace, classification };
}

async function classify(
  provider: InstrumentationProviderDefinition,
  input: Parameters<NonNullable<InstrumentationProviderDefinition["classificationPolicy"]>>[0],
  timeoutMs: number,
  inheritedSignal?: AbortSignal,
): Promise<JsonValue | typeof CLASSIFICATION_FAILED> {
  const policy = provider.classificationPolicy;
  if (policy === undefined) return CLASSIFICATION_FAILED;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const abortSignal =
    inheritedSignal === undefined
      ? timeoutSignal
      : AbortSignal.any([inheritedSignal, timeoutSignal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(policy(input, { abortSignal })).then(parseJsonValue),
      new Promise<typeof CLASSIFICATION_FAILED>((resolve) => {
        timer = setTimeout(() => resolve(CLASSIFICATION_FAILED), timeoutMs);
      }),
    ]);
  } catch (error) {
    log.warn("instrumentation provider classification failed", {
      boundary: input.boundary,
      error: formatError(error),
      provider: provider.name,
    });
    return CLASSIFICATION_FAILED;
  } finally {
    clearTimeout(timer);
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
  if (
    event.type === "memory.operation.started" ||
    event.type === "memory.operation.completed" ||
    event.type === "memory.operation.failed"
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
