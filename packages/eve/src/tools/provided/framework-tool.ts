const FRAMEWORK_TOOL = Symbol.for("eve.framework-tool");

/** Keeps framework identity on definitions even when their runtime names change. */
export function frameworkTool<T extends object>(definition: T): T {
  Object.defineProperty(definition, FRAMEWORK_TOOL, { enumerable: true, value: true });
  return definition;
}

export function isFrameworkTool(definition: object): boolean {
  return Reflect.get(definition, FRAMEWORK_TOOL) === true;
}

const INTERACTION_ONLY = Symbol.for("eve.interaction-only");

/**
 * Marks a built-in executor that acts only on the conversation: asking a question, ending the
 * turn, waiting. The mark sits on the function, so a definition keeps it only while it runs that
 * exact executor, whatever it is named or spread into.
 */
export function interactionOnly<F extends (...args: never[]) => unknown>(execute: F): F {
  Object.defineProperty(execute, INTERACTION_ONLY, { value: true });
  return execute;
}

/** Whether `value` is, or is a definition resolved from, an {@link interactionOnly} executor. */
export function isInteractionOnly(value: unknown): boolean {
  return (
    (typeof value === "function" || (typeof value === "object" && value !== null)) &&
    Reflect.get(value, INTERACTION_ONLY) === true
  );
}

/** Carries an executor's {@link interactionOnly} mark onto its resolved definition. */
export function markInteractionOnly<T extends object>(definition: T): T {
  Object.defineProperty(definition, INTERACTION_ONLY, { enumerable: true, value: true });
  return definition;
}
