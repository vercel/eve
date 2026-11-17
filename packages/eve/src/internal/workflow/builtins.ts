import { installWorkflowHost } from "#execution/workflow-host/host.js";

installWorkflowHost();
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
