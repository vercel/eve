import { contextStorage, type ContextContainer } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import type { TurnPosition } from "#harness/session-machine/view.js";
import type { HarnessEmitFn } from "#harness/types.js";
import { createRuntimeToolResultFromValue } from "#harness/action-result-helpers.js";
import { createActionResultEvent, createActionsRequestedEvent } from "#protocol/message.js";
import type { JsonObject } from "#shared/json.js";

/**
 * A call a tool made on the model's behalf, reported on the protocol as a
 * nested action of the calling tool's action. Nested actions never enter
 * model history; the model sees only the parent call and its result.
 */
export interface NestedToolAction {
  readonly input: JsonObject;
  readonly isError?: boolean;
  /** The call's result, or its error message when `isError` is set. */
  readonly output: unknown;
  readonly toolName: string;
}

/**
 * Step-local nested actions keyed by parent call id. Written while the parent
 * executes and drained when the harness emits the parent's result, so nested
 * actions always follow the parent's request and precede its result.
 */
const NestedToolActionsKey = new ContextKey<Readonly<Record<string, readonly NestedToolAction[]>>>(
  "eve.nestedToolActions",
);

/** Records a nested action of the tool call `parentCallId`. */
export function reportNestedToolAction(parentCallId: string, action: NestedToolAction): void {
  const ctx = contextStorage.getStore() as ContextContainer | undefined;
  if (ctx === undefined) return;
  const pending = ctx.get(NestedToolActionsKey) ?? {};
  ctx.setVirtualContext(NestedToolActionsKey, {
    ...pending,
    [parentCallId]: [...(pending[parentCallId] ?? []), action],
  });
}

/**
 * Emits the nested actions recorded for `parentCallId`, each as an
 * `actions.requested` and `action.result` pair. Call ids derive from the
 * parent's, so a re-run step reports the same ids.
 */
export async function emitNestedToolActions(
  emitFn: HarnessEmitFn,
  state: Pick<TurnPosition, "sequence" | "stepIndex" | "turnId">,
  parentCallId: string,
): Promise<void> {
  const ctx = contextStorage.getStore() as ContextContainer | undefined;
  const pending = ctx?.get(NestedToolActionsKey);
  const actions = pending?.[parentCallId];
  if (ctx === undefined || pending === undefined || actions === undefined) return;
  const { [parentCallId]: _drained, ...rest } = pending;
  ctx.setVirtualContext(NestedToolActionsKey, rest);

  for (const [index, action] of actions.entries()) {
    const callId = `${parentCallId}:${index + 1}`;
    const position = {
      sequence: state.sequence,
      stepIndex: state.stepIndex,
      turnId: state.turnId,
    };
    await emitFn(
      createActionsRequestedEvent({
        actions: [
          {
            callId,
            input: action.input,
            kind: "tool-call",
            parentCallId,
            toolName: action.toolName,
          },
        ],
        ...position,
      }),
    );
    await emitFn(
      createActionResultEvent({
        result: createRuntimeToolResultFromValue({
          callId,
          isError: action.isError,
          output: action.output,
          toolName: action.toolName,
        }),
        ...position,
      }),
    );
  }
}
