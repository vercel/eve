const WORKFLOW_CONTEXT_SYMBOL = Symbol.for("WORKFLOW_CONTEXT");
const WORKFLOW_CREATE_HOOK = Symbol.for("WORKFLOW_CREATE_HOOK");
const WORKFLOW_GET_STREAM_ID = Symbol.for("WORKFLOW_GET_STREAM_ID");
const WORKFLOW_USE_STEP = Symbol.for("WORKFLOW_USE_STEP");
const STREAM_NAME_SYMBOL = Symbol.for("WORKFLOW_STREAM_NAME");
const workflowGlobal = globalThis as typeof globalThis & Record<symbol, unknown>;

export class RetryableError extends Error {}

export class FatalError extends Error {}

/**
 * Creates a Workflow hook from inside a durable workflow body.
 */
export function createHook<T = unknown>(
  options?: unknown,
): AsyncIterable<T> & {
  readonly token: string;
} {
  const createHookFn = workflowGlobal[WORKFLOW_CREATE_HOOK] as
    | ((hookOptions?: unknown) => AsyncIterable<T> & { readonly token: string })
    | undefined;

  if (createHookFn === undefined) {
    throw new Error("`createHook()` can only be called inside a workflow function");
  }

  return createHookFn(options);
}

/**
 * Returns metadata for the current durable workflow body.
 */
export function getWorkflowMetadata(): Record<string, unknown> {
  const ctx = workflowGlobal[WORKFLOW_CONTEXT_SYMBOL] as Record<string, unknown> | undefined;

  if (ctx === undefined) {
    throw new Error(
      "`getWorkflowMetadata()` can only be called inside a workflow or step function",
    );
  }

  return ctx;
}

/**
 * Creates a Workflow writable stream handle from inside a durable workflow body.
 */
export function getWritable<T = unknown>(options: { namespace?: string } = {}): WritableStream<T> {
  const getStreamId = workflowGlobal[WORKFLOW_GET_STREAM_ID] as
    | ((namespace?: string) => string)
    | undefined;

  if (getStreamId === undefined) {
    throw new Error("`getWritable()` can only be called inside a workflow function");
  }

  const name = getStreamId(options.namespace);

  return Object.create(globalThis.WritableStream.prototype, {
    [STREAM_NAME_SYMBOL]: {
      value: name,
      writable: false,
    },
  }) as WritableStream<T>;
}

/**
 * Creates a Workflow webhook from inside a durable workflow body.
 */
export function createWebhook<T = unknown>(
  options?: unknown,
): AsyncIterable<T> & {
  readonly token: string;
  url?: string;
} {
  const hook = createHook<T>(options) as AsyncIterable<T> & {
    readonly token: string;
    url?: string;
  };
  const metadata = getWorkflowMetadata();
  const baseUrl = typeof metadata.url === "string" ? metadata.url : "";

  hook.url = `${baseUrl}/.well-known/workflow/v1/webhook/${encodeURIComponent(hook.token)}`;
  return hook;
}

/**
 * Defines a Workflow hook factory for workflow-body code.
 */
export function defineHook<T = unknown>(): {
  readonly create: (options?: unknown) => AsyncIterable<T> & { readonly token: string };
  readonly resume: () => never;
} {
  return {
    create: createHook,
    resume() {
      throw new Error("`defineHook().resume()` can only be called from external contexts.");
    },
  };
}

/**
 * Sleeps from inside workflow-body code.
 */
export function sleep(): never {
  throw new Error("`sleep()` is not available in eve workflow body bundles");
}

/**
 * `resumeHook()` is an external/runtime API and must not run in workflow bodies.
 */
export function resumeHook(): never {
  throw new Error("`resumeHook()` can only be called from outside a workflow function");
}

/**
 * Step metadata is only available in step functions.
 */
export function getStepMetadata(): never {
  throw new Error("`getStepMetadata()` can only be called inside a step function");
}

/**
 * Options accepted by {@link experimental_setAttributes}.
 *
 * Mirrors `ExperimentalSetAttributesOptions` from `@workflow/core` so the
 * eve workflow-body bundle does not have to pull the real type in.
 */
export interface ExperimentalSetAttributesOptions {
  /**
   * Permit attribute keys that start with the reserved `$` prefix. eve
   * framework code passes `true` so it can write the `$eve.*` namespace;
   * authored agent code never calls this shim directly.
   */
  allowReservedAttributes?: boolean;
}

/**
 * Workflow-body implementation of `experimental_setAttributes` for the eve
 * bundle. Mirrors the dispatch path of `@workflow/core`'s workflow-body
 * export (`dist/workflow/set-attributes.js`):
 *
 * 1. Convert the attribute map into the `AttributeChange[]` shape the
 *    runtime expects (`undefined` -> `null` to clear a key).
 * 2. Resolve the workflow runtime's step dispatcher from
 *    `globalThis[Symbol.for("WORKFLOW_USE_STEP")]` (the same global symbol
 *    eve already relies on to materialize `"use step"` proxies).
 * 3. Invoke the builtin `__builtin_set_attributes` step with the changes,
 *    which the runtime records on the active workflow run.
 *
 * Validation is intentionally skipped here. The only caller, `setEveAttributes`,
 * already normalizes keys/values and is the sole entry point for the
 * `$eve.*` reserved namespace; bouncing through the runtime's full
 * validator would require pulling `@workflow/world` into the workflow body
 * bundle.
 */
export async function experimental_setAttributes(
  attrs: Record<string, string | undefined>,
  options: ExperimentalSetAttributesOptions = {},
): Promise<void> {
  const entries = Object.entries(attrs);
  if (entries.length === 0) {
    return;
  }
  const useStep = workflowGlobal[WORKFLOW_USE_STEP] as
    | ((
        stepId: string,
      ) => (
        changes: ReadonlyArray<{ key: string; value: string | null }>,
        options: { allowReservedAttributes?: boolean },
      ) => Promise<void>)
    | undefined;

  if (useStep === undefined) {
    throw new Error(
      "`experimental_setAttributes()` can only be called inside a workflow runtime context",
    );
  }

  const changes = entries.map(([key, value]) => ({
    key,
    value: value === undefined ? null : value,
  }));
  const dispatchOptions =
    options.allowReservedAttributes === true ? { allowReservedAttributes: true } : {};
  await useStep("__builtin_set_attributes")(changes, dispatchOptions);
}
