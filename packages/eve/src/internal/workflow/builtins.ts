/**
 * Built-in Workflow response body steps used by eve-owned workflow bundles.
 *
 * These mirror Workflow's tiny `workflow/internal/builtins` module without
 * requiring eve to depend on Workflow's umbrella package.
 */
export async function __builtin_response_array_buffer(
  this: Request | Response,
): Promise<ArrayBuffer> {
  "use step";
  return await this.arrayBuffer();
}

export async function __builtin_response_json(this: Request | Response): Promise<unknown> {
  "use step";
  return await this.json();
}

export async function __builtin_response_text(this: Request | Response): Promise<string> {
  "use step";
  return await this.text();
}

const EVE_INTERNAL_ATTRIBUTES_MAX_ATTEMPTS = 3;
const EVE_UNSUPPORTED_WORLD_WARNED = Symbol.for("@workflow/setAttributes//unsupportedWorldWarned");

function formatUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  return String(error);
}

/**
 * Step bridge for `experimental_setAttributes`.
 *
 * Mirrors the `__builtin_set_attributes` step from
 * `@workflow/workflow/internal/builtins`. The workflow-body shim's
 * `experimental_setAttributes` (in `internal/workflow-bundle/workflow-core-shim.ts`)
 * dispatches into the workflow runtime with the step id
 * `"__builtin_set_attributes"`; the runtime walks the deployment's step
 * registry to resolve it, so the step has to live inside an
 * eve-vendored builtins module that the registry visits. The eve bundler
 * already pulls this file in via `resolveWorkflowModulePath("workflow/internal/builtins")`,
 * so adding the function here is sufficient to register it.
 *
 * Implementation notes — kept intentionally close to the upstream:
 * - Reads world and run id directly from the runtime's `globalThis`
 *   symbols rather than importing `@workflow/core`. Importing the
 *   compiled core from a step file would re-introduce the bundling
 *   chain we want to keep out of step bodies.
 * - Treats missing world support as a silent best-effort no-op with a
 *   single process-wide warning, matching upstream behaviour and the
 *   contract on `setEveAttributes`.
 * - On any other error, retries up to `EVE_INTERNAL_ATTRIBUTES_MAX_ATTEMPTS - 1`
 *   times via the runtime's normal step retry path, then degrades to a
 *   `console.error` so failed attribute writes never escalate into a
 *   `FatalError` and tear down the user's agent run.
 */
export async function __builtin_set_attributes(
  changes: Array<{ key: string; value: string | null }>,
  options?: { allowReservedAttributes?: boolean },
): Promise<void> {
  "use step";
  if (changes.length === 0) return;
  const g = globalThis as Record<symbol, unknown>;

  const contextStorage = g[Symbol.for("WORKFLOW_STEP_CONTEXT_STORAGE")] as
    | {
        getStore: () =>
          | {
              stepMetadata?: { attempt?: number };
              workflowMetadata?: { workflowRunId?: string };
            }
          | undefined;
      }
    | undefined;
  const store = contextStorage?.getStore?.();
  const attempt =
    typeof store?.stepMetadata?.attempt === "number"
      ? store.stepMetadata.attempt
      : EVE_INTERNAL_ATTRIBUTES_MAX_ATTEMPTS;

  const world = g[Symbol.for("@workflow/world//cache")] as
    | {
        name?: string;
        runs?: {
          experimentalSetAttributes?: (
            runId: string,
            changes: Array<{ key: string; value: string | null }>,
            options?: { allowReservedAttributes?: boolean },
          ) => Promise<unknown>;
        };
      }
    | undefined;
  if (typeof world?.runs?.experimentalSetAttributes !== "function") {
    if (g[EVE_UNSUPPORTED_WORLD_WARNED] !== true) {
      g[EVE_UNSUPPORTED_WORLD_WARNED] = true;
      const worldName = world?.name === undefined ? "" : ` (${world.name})`;
      console.warn(
        `[eve] setAttributes: the current world implementation${worldName} does not implement experimentalSetAttributes; this call (and any subsequent setAttributes calls in this process) is a no-op. Attributes will become available once the world adapter adds support.`,
      );
    }
    return;
  }

  try {
    const runId = store?.workflowMetadata?.workflowRunId;
    if (runId === undefined) {
      throw new Error("__builtin_set_attributes: no workflow run id available in step context");
    }
    await world.runs.experimentalSetAttributes(runId, changes, options);
  } catch (error) {
    if (attempt < EVE_INTERNAL_ATTRIBUTES_MAX_ATTEMPTS) {
      throw error;
    }
    console.error(
      `[eve] setAttributes: failed to post tags after ${EVE_INTERNAL_ATTRIBUTES_MAX_ATTEMPTS} attempts; dropping the internal attribute write. ${formatUnknownError(error)}`,
    );
  }
}

(
  __builtin_set_attributes as typeof __builtin_set_attributes & {
    maxRetries: number;
  }
).maxRetries = EVE_INTERNAL_ATTRIBUTES_MAX_ATTEMPTS - 1;
