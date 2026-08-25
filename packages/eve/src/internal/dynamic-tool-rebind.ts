import type { DynamicSentinel } from "#shared/dynamic-tool-definition.js";

const REBIND_MISSING_CALLBACKS = Symbol.for("eve:dynamic-rebind-missing-callbacks");

export function markDynamicCallbackRebind<TResult>(
  sentinel: DynamicSentinel<TResult>,
): DynamicSentinel<TResult> {
  Object.defineProperty(sentinel, REBIND_MISSING_CALLBACKS, { value: true });
  return sentinel;
}

export function shouldRebindDynamicCallbacks(value: DynamicSentinel): boolean {
  return Reflect.get(value, REBIND_MISSING_CALLBACKS) === true;
}
