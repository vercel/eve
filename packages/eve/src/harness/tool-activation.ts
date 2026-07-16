import type { JsonObject } from "#shared/json.js";

declare const toolActivationIdBrand: unique symbol;

/** Framework-owned identity shared by one tool loader and its loaded tools. */
export type ToolActivationId = string & {
  readonly [toolActivationIdBrand]: true;
};

/** Provider-neutral snapshot of one tool introduced by a loader result. */
export interface ActivatedToolDefinition {
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly name: string;
}

/** Tools introduced by one loader result. */
export interface ToolActivationProjection {
  readonly tools: readonly ActivatedToolDefinition[];
}

/** Internal relationship between a loader and the tools its result introduces. */
export type HarnessToolActivation =
  | {
      readonly kind: "loader";
      readonly id: ToolActivationId;
      readonly project: (output: unknown) => ToolActivationProjection;
    }
  | {
      readonly kind: "target";
      readonly id: ToolActivationId;
    };

const activations = new WeakMap<object, HarnessToolActivation>();

/** Creates a typed activation identity from a framework-owned stable name. */
export function createToolActivationId(value: string): ToolActivationId {
  return value as ToolActivationId;
}

/** Attaches internal activation metadata without changing the model-facing tool. */
export function attachToolActivation<T extends object>(
  tool: T,
  activation: HarnessToolActivation,
): T {
  activations.set(tool, activation);
  return tool;
}

/** Reads framework-owned activation metadata, when present. */
export function getToolActivation(tool: unknown): HarnessToolActivation | undefined {
  return typeof tool === "object" && tool !== null ? activations.get(tool) : undefined;
}

/** Copies activation metadata while lowering or cloning a tool definition. */
export function copyToolActivation<T extends object>(source: unknown, target: T): T {
  const activation = getToolActivation(source);
  if (activation !== undefined) {
    activations.set(target, activation);
  }
  return target;
}
