const FRAMEWORK_TOOL = Symbol.for("eve.framework-tool");

/** Keeps framework identity on definitions even when their runtime names change. */
export function frameworkTool<T extends object>(definition: T): T {
  Object.defineProperty(definition, FRAMEWORK_TOOL, { enumerable: true, value: true });
  return definition;
}

export function isFrameworkTool(definition: object): boolean {
  return Reflect.get(definition, FRAMEWORK_TOOL) === true;
}
