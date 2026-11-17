import {
  FatalError as SdkFatalError,
  HookConflictError,
  RetryableError as SdkRetryableError,
} from "#compiled/@workflow/errors/index.js";

const WORKFLOW_CONTEXT_SYMBOL = Symbol.for("WORKFLOW_CONTEXT");
const WORKFLOW_CREATE_HOOK = Symbol.for("WORKFLOW_CREATE_HOOK");
const WORKFLOW_GET_STREAM_ID = Symbol.for("WORKFLOW_GET_STREAM_ID");
const WORKFLOW_SLEEP = Symbol.for("WORKFLOW_SLEEP");
const WORKFLOW_USE_STEP = Symbol.for("WORKFLOW_USE_STEP");
const STREAM_NAME_SYMBOL = Symbol.for("WORKFLOW_STREAM_NAME");
const workflowGlobal = globalThis as typeof globalThis & Record<symbol, unknown>;

export const FatalError = (workflowGlobal[Symbol.for("@workflow/errors//FatalError")] ??
  SdkFatalError) as typeof SdkFatalError;
export const RetryableError = (workflowGlobal[Symbol.for("@workflow/errors//RetryableError")] ??
  SdkRetryableError) as typeof SdkRetryableError;

interface WorkflowHook<T> extends AsyncIterable<T> {
  readonly token: string;
  getConflict(): Promise<{ readonly runId: string } | null>;
}

export function createHook<T = unknown>(options?: unknown): WorkflowHook<T> {
  const createHookFn = workflowGlobal[WORKFLOW_CREATE_HOOK] as
    | ((hookOptions?: unknown) => WorkflowHook<T>)
    | undefined;

  if (createHookFn === undefined) {
    throw new Error("`createHook()` can only be called inside a workflow function");
  }

  const hook = createHookFn(options);
  const getConflict = hook.getConflict.bind(hook);
  hook.getConflict = async () => {
    try {
      return await getConflict();
    } catch (error) {
      if (HookConflictError.is(error) && typeof error.conflictingRunId === "string") {
        return { runId: error.conflictingRunId };
      }
      throw error;
    }
  };
  return hook;
}

export function getWorkflowMetadata(): Record<string, unknown> {
  const ctx = workflowGlobal[WORKFLOW_CONTEXT_SYMBOL] as Record<string, unknown> | undefined;

  if (ctx === undefined) {
    throw new Error(
      "`getWorkflowMetadata()` can only be called inside a workflow or step function",
    );
  }

  return ctx;
}

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

export function createWebhook<T = unknown>(options?: unknown): WorkflowHook<T> & { url?: string } {
  const { respondWith, token, ...rest } = (options ?? {}) as Record<string, unknown>;
  if (token !== undefined) {
    throw new Error(
      "`createWebhook()` does not accept a `token` option. Use `createHook()` with `resumeHook()` for deterministic tokens.",
    );
  }
  const hook = createHook<T>({
    ...rest,
    metadata: respondWith === undefined ? undefined : { respondWith },
    isWebhook: true,
  }) as WorkflowHook<T> & { url?: string };
  const metadata = getWorkflowMetadata();
  const baseUrl = typeof metadata.url === "string" ? metadata.url : "";

  hook.url = `${baseUrl}/.well-known/workflow/v1/webhook/${encodeURIComponent(hook.token)}`;
  return hook;
}

export function defineHook<T = unknown>(): {
  readonly create: (options?: unknown) => WorkflowHook<T>;
  readonly resume: () => never;
} {
  return {
    create: createHook,
    resume() {
      throw new Error("`defineHook().resume()` can only be called from external contexts.");
    },
  };
}

export function sleep(duration: string | number | Date): Promise<void> {
  const sleepFn = workflowGlobal[WORKFLOW_SLEEP] as
    | ((sleepDuration: string | number | Date) => Promise<void>)
    | undefined;

  if (sleepFn === undefined) {
    throw new Error("`sleep()` can only be called inside a workflow function");
  }

  return sleepFn(duration);
}

export function resumeHook(): never {
  throw new Error("`resumeHook()` can only be called from outside a workflow function");
}

export function getStepMetadata(): never {
  throw new Error("`getStepMetadata()` can only be called inside a step function");
}

export interface SetAttributesOptions {
  allowReservedAttributes?: boolean;
}

export async function setAttributes(
  attrs: Record<string, string | undefined>,
  options: SetAttributesOptions = {},
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
    throw new Error("`setAttributes()` can only be called inside a workflow runtime context");
  }

  const changes = entries.map(([key, value]) => ({
    key,
    value: value === undefined ? null : value,
  }));
  const dispatchOptions =
    options.allowReservedAttributes === true ? { allowReservedAttributes: true } : {};
  await useStep("__builtin_set_attributes")(changes, dispatchOptions);
}
