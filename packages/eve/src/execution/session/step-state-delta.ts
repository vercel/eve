import { readDurableSession, type DurableSessionState } from "#execution/durable-session-store.js";
import {
  enterSessionStep,
  followInterruptedAttempt,
  readOrphanedLines,
  type Entered,
} from "#execution/publish-session-events.js";
import { storedProjection } from "#harness/session-machine/view.js";
import type {
  SessionStateDelta,
  SessionStateTransition,
  SessionStateValues,
  WithSessionStateDelta,
} from "#execution/session/state-delta.js";
import { freeze, isDraftable, produce } from "#compiled/immer/index.js";
import { applyValueDelta, diffValue, snapshotValue, type ValueDelta } from "#shared/value-delta.js";

const SESSION_VALUE_KEYS = ["serializedContext", "sessionState", "history"] as const;

type StepValues = Partial<SessionStateValues> & {
  readonly sessionWritable?: WritableStream<Uint8Array>;
};

function storedByReference(): boolean {
  return process.env.WORKFLOW_VM !== "quickjs";
}

function nextVersion(given: unknown, delta: ValueDelta): unknown {
  if (delta.kind === "value" || !isDraftable(given)) {
    return freeze(applyValueDelta(given, delta), true);
  }
  return produce(given, (draft) => applyToDraft(draft, delta));
}

function applyToDraft(draft: any, delta: ValueDelta): void {
  if (delta.kind === "value") throw new Error("A whole value replaces the draft.");
  const apply = (key: string | number, change: ValueDelta) => {
    if (change.kind === "value") draft[key] = change.value;
    else applyToDraft(draft[key], change);
  };
  if (delta.kind === "array") {
    if (draft.length > delta.length) draft.length = delta.length;
    for (const [index, value] of Object.entries(delta.set ?? {})) draft[Number(index)] = value;
    for (const [index, change] of Object.entries(delta.patch ?? {})) apply(Number(index), change);
    return;
  }
  const keys = delta.keys;
  if (keys !== undefined) {
    const kept = new Set(keys);
    for (const key of Object.keys(draft)) if (!kept.has(key)) delete draft[key];
  }
  for (const [key, value] of Object.entries(delta.set ?? {})) draft[key] = value;
  for (const [key, change] of Object.entries(delta.patch ?? {})) apply(key, change);
  if (keys !== undefined && !sameOrder(Object.keys(draft), keys)) {
    for (const key of keys) {
      const value = draft[key];
      delete draft[key];
      draft[key] = value;
    }
  }
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((key, index) => key === right[index]);
}

export async function withSessionStateDelta<
  I extends Partial<SessionStateValues>,
  R extends Partial<SessionStateValues>,
>(input: I, work: (step: Entered<I>) => Promise<R>): Promise<WithSessionStateDelta<R>>;
export async function withSessionStateDelta(
  input: StepValues,
  work: (step: Entered<StepValues>) => Promise<Partial<SessionStateValues>>,
): Promise<SessionStateTransition> {
  const base = Object.fromEntries(
    SESSION_VALUE_KEYS.map((key) => [key, snapshotValue(input[key])]),
  );
  const step = enterSessionStep(input);
  const { sessionWritable } = step;
  if (sessionWritable !== undefined && base.sessionState !== undefined) {
    const checkpoint = base.sessionState as DurableSessionState;
    const session = readDurableSession(checkpoint);
    await readOrphanedLines({
      rerun: step.rerun,
      sessionId: checkpoint.sessionId,
      position: storedProjection(session.state).view.position,
      sessionWritable,
    });
  }
  const editable = <T>(value: T): T =>
    value !== null && typeof value === "object" && Object.isFrozen(value)
      ? snapshotValue(value)
      : value;
  const given = { ...step };
  if ("serializedContext" in step) given.serializedContext = editable(step.serializedContext);
  if ("sessionState" in step) given.sessionState = editable(step.sessionState);
  const { serializedContext, sessionState, history, ...result } = await work(given);
  const candidateState = sessionState ?? base.sessionState;
  const next = {
    serializedContext,
    sessionState:
      candidateState === undefined || sessionWritable === undefined
        ? sessionState
        : followInterruptedAttempt(sessionWritable, candidateState as DurableSessionState),
    history,
  };
  const stateDelta: { -readonly [K in keyof SessionStateDelta]: SessionStateDelta[K] } = {};
  const byReference = storedByReference();
  for (const key of SESSION_VALUE_KEYS) {
    const delta = next[key] === undefined ? undefined : diffValue(base[key], next[key]);
    if (delta === undefined) continue;
    stateDelta[key] = byReference
      ? { kind: "value", value: nextVersion(input[key], delta) }
      : delta;
  }
  return { ...result, stateDelta };
}
