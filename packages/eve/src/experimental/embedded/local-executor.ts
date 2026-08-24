import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { registerStepFunction } from "#compiled/@workflow/core/private.js";
import { createWorld } from "#compiled/@workflow/world-local/index.js";
import { SCHEDULE_ADAPTER } from "#channel/schedule.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import type { JsonValue } from "#shared/json.js";
import { parseJsonValue } from "#shared/json.js";
import { writeCompiledArtifactsFiles } from "#internal/application/compiled-artifacts.js";
import { resolvePackageRoot } from "#internal/application/package.js";
import { WorkflowBundleBuilder } from "#internal/workflow-bundle/builder.js";
import {
  deriveEveWorkflowQueuePrefix,
  installEveWorkflowQueueNamespace,
  restoreEveWorkflowQueueNamespace,
  WORKFLOW_QUEUE_NAMESPACE_ENV,
} from "#internal/workflow/queue-namespace.js";
import { setWorld } from "#internal/workflow/runtime.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { createRuntimeSession, withRuntimeSession } from "#runtime/sessions/runtime-session.js";
import { compileEmbeddedAgent } from "./compile.js";

const EMBEDDED_EXECUTOR_OWNER = Symbol.for("eve.experimental.embedded-local-executor-owner");
interface EmbeddedExecutorGlobal {
  [EMBEDDED_EXECUTOR_OWNER]?: boolean;
}
const embeddedExecutorGlobal = globalThis as typeof globalThis & EmbeddedExecutorGlobal;

export interface CreateEmbeddedLocalExecutorInput {
  readonly appRoot: string;
  readonly entrypoint: string;
  readonly dataDirectory?: string;
}

export interface EmbeddedLocalExecutorRunResult {
  readonly sessionId: string;
  readonly events: readonly MessageStreamEvent[];
  readonly result: JsonValue;
}

export interface EmbeddedLocalExecutor {
  run(input: { readonly input: JsonValue }): Promise<EmbeddedLocalExecutorRunResult>;
  close(): Promise<void>;
}

export class EmbeddedLocalExecutorError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "EmbeddedLocalExecutorError";
  }
}

export async function createEmbeddedLocalExecutor(
  input: CreateEmbeddedLocalExecutorInput,
): Promise<EmbeddedLocalExecutor> {
  if (embeddedExecutorGlobal[EMBEDDED_EXECUTOR_OWNER] === true) {
    throw new EmbeddedLocalExecutorError(
      "embedded_executor_already_running",
      "Only one embedded local executor can run in this process. Close the active executor before creating another.",
    );
  }
  embeddedExecutorGlobal[EMBEDDED_EXECUTOR_OWNER] = true;

  let workspace: string;
  try {
    workspace = await mkdtemp(join(tmpdir(), "eve-embedded-executor-"));
  } catch (error) {
    embeddedExecutorGlobal[EMBEDDED_EXECUTOR_OWNER] = false;
    throw error;
  }
  const dataDirectory = input.dataDirectory
    ? resolve(input.dataDirectory)
    : join(workspace, "workflow-world");
  const previousQueueNamespace = process.env[WORKFLOW_QUEUE_NAMESPACE_ENV];
  let world: Awaited<ReturnType<typeof createWorld>> | undefined;
  let installedQueueNamespace: string | undefined;
  let closed = false;

  try {
    await mkdir(dataDirectory, { recursive: true });
    const compileResult = await compileEmbeddedAgent({
      appRoot: resolve(input.appRoot),
      artifactLocations: {
        publishedRoot: join(workspace, "compiler"),
        writeRoot: join(workspace, "compiler"),
      },
      entrypoint: input.entrypoint,
    });
    const agentName = compileResult.manifest.config.name;
    installedQueueNamespace = installEveWorkflowQueueNamespace(agentName);

    const generated = await writeCompiledArtifactsFiles({
      compileResult,
      defaultWorkflowWorld: "local",
      outDir: join(workspace, "artifacts"),
    });
    const workflowBuildDirectory = join(workspace, "workflow");
    await new WorkflowBundleBuilder({
      agentName,
      appRoot: compileResult.project.appRoot,
      compiledArtifactsBootstrapPath: generated.bootstrapPath,
      outDir: workflowBuildDirectory,
      rootDir: resolvePackageRoot(),
      watch: false,
    }).build();
    await registerEmbeddedWorkflowSteps(workflowBuildDirectory);

    const runtimeSession = createRuntimeSession(`embedded-local-${crypto.randomUUID()}`);
    world = createWorld({ dataDir: dataDirectory, tag: `embedded-${crypto.randomUUID()}` });
    await world.start?.();
    setWorld(world);

    await withRuntimeSession(runtimeSession, async () => {
      const bundleUrl = pathToFileURL(join(workflowBuildDirectory, "workflows.mjs"));
      const module = (await import(bundleUrl.href)) as {
        readonly POST?: (request: Request) => Promise<Response>;
      };
      if (typeof module.POST !== "function") {
        throw new EmbeddedLocalExecutorError(
          "embedded_workflow_handler_missing",
          "The generated eve Workflow bundle did not export its POST flow handler.",
        );
      }
      world!.registerHandler(
        deriveEveWorkflowQueuePrefix(agentName),
        async (request) =>
          await withRuntimeSession(runtimeSession, async () => await module.POST!(request)),
      );
    });

    return {
      async run(runInput) {
        if (closed) {
          throw new EmbeddedLocalExecutorError(
            "embedded_executor_closed",
            "This embedded local executor is closed. Create a new executor before running another task.",
          );
        }
        return await withRuntimeSession(runtimeSession, async () => {
          const runtime = createWorkflowRuntime({
            compiledArtifactsSource: createBundledRuntimeCompiledArtifactsSource(),
          });
          const handle = await runtime.createSession({
            adapter: SCHEDULE_ADAPTER,
            auth: null,
            input: { message: canonicalizeEmbeddedInput(runInput.input) },
            mode: "task",
          });
          const projected = await projectEmbeddedRunEvents(handle.events);
          await new Promise((resolve) => setTimeout(resolve, 250));
          return { sessionId: handle.sessionId, ...projected };
        });
      },
      async close() {
        if (closed) return;
        closed = true;
        setWorld(undefined);
        let cleanupError: unknown;
        try {
          await world?.close?.();
        } catch (error) {
          cleanupError = error;
        }
        restoreEveWorkflowQueueNamespace(previousQueueNamespace, {
          ifCurrent: installedQueueNamespace,
        });
        try {
          await rm(workspace, {
            force: true,
            maxRetries: 5,
            recursive: true,
            retryDelay: 100,
          });
        } catch (error) {
          cleanupError ??= error;
        } finally {
          embeddedExecutorGlobal[EMBEDDED_EXECUTOR_OWNER] = false;
        }
        if (cleanupError !== undefined) {
          throw new EmbeddedLocalExecutorError(
            "embedded_executor_cleanup_failed",
            "The embedded local executor closed, but eve could not remove all owned runtime resources.",
            { cause: cleanupError },
          );
        }
      },
    };
  } catch (error) {
    setWorld(undefined);
    await world?.close?.().catch(() => {});
    restoreEveWorkflowQueueNamespace(previousQueueNamespace, {
      ifCurrent: installedQueueNamespace,
    });
    try {
      await rm(workspace, {
        force: true,
        maxRetries: 5,
        recursive: true,
        retryDelay: 100,
      });
    } finally {
      embeddedExecutorGlobal[EMBEDDED_EXECUTOR_OWNER] = false;
    }
    throw error;
  }
}

export async function projectEmbeddedRunEvents(
  stream: ReadableStream<MessageStreamEvent>,
): Promise<{ readonly events: readonly MessageStreamEvent[]; readonly result: JsonValue }> {
  const reader = stream.getReader();
  const events: MessageStreamEvent[] = [];
  let result: JsonValue | undefined;
  let resultCount = 0;

  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        throw new EmbeddedLocalExecutorError(
          "embedded_run_nonterminal",
          "The embedded eve task event stream ended without session.completed or session.failed.",
        );
      }
      const event = next.value;
      events.push(event);

      if (event.type === "result.completed") {
        resultCount += 1;
        if (resultCount > 1) {
          throw new EmbeddedLocalExecutorError(
            "embedded_run_duplicate_result",
            "The embedded eve task emitted more than one result.completed event.",
          );
        }
        try {
          result = parseJsonValue(event.data.result);
        } catch (error) {
          throw new EmbeddedLocalExecutorError(
            "embedded_run_invalid_result",
            "The embedded eve task emitted a result.completed event whose result was not valid JSON.",
            { cause: error },
          );
        }
      } else if (event.type === "session.waiting" || event.type === "input.requested") {
        throw new EmbeddedLocalExecutorError(
          "embedded_run_waiting",
          "The embedded eve task requested human input, but embedded local tasks cannot wait for input.",
        );
      } else if (event.type === "session.failed") {
        throw new EmbeddedLocalExecutorError(
          "embedded_run_failed",
          `The embedded eve task failed (${event.data.code}): ${event.data.message}`,
        );
      } else if (event.type === "session.completed") {
        if (resultCount !== 1 || result === undefined) {
          throw new EmbeddedLocalExecutorError(
            "embedded_run_missing_result",
            "The embedded eve task completed without exactly one result.completed event. Configure an output schema that produces one structured result.",
          );
        }
        return { events, result };
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function canonicalizeEmbeddedInput(value: JsonValue): string {
  return JSON.stringify(sortJsonValue(parseJsonValue(value)));
}

async function registerEmbeddedWorkflowSteps(workflowBuildDirectory: string): Promise<void> {
  const manifest = JSON.parse(
    await readFile(join(workflowBuildDirectory, "manifest.json"), "utf8"),
  ) as {
    readonly steps?: Readonly<
      Record<string, Readonly<Record<string, { readonly stepId?: string }>>>
    >;
  };

  for (const [modulePath, exports] of Object.entries(manifest.steps ?? {})) {
    const module = (await import(
      pathToFileURL(join(resolvePackageRoot(), modulePath)).href
    )) as Readonly<Record<string, unknown>>;
    for (const [exportName, metadata] of Object.entries(exports)) {
      const step = module[exportName];
      if (typeof step === "function" && typeof metadata.stepId === "string") {
        registerStepFunction(metadata.stepId, step as Parameters<typeof registerStepFunction>[1]);
      }
    }
  }
}

function sortJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value !== null && typeof value === "object") {
    const object = value as { readonly [key: string]: JsonValue };
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((key) => [key, sortJsonValue(object[key]!)]),
    );
  }
  return value;
}
