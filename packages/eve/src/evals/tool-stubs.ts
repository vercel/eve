import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

import type { ToolStubsSelection } from "#channel/types.js";
import { contextStorage } from "#context/container.js";
import { ParentSessionKey, ToolStubsKey } from "#context/keys.js";
import { createToolExecuteWithAuth } from "#execution/tool-auth.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { ToolStubsDefinition } from "#evals/define-tool-stubs.js";
import {
  recordTurnFailingToolError,
  TurnFailingToolError,
} from "#harness/turn-failing-tool-error.js";
import { resolveEveEvaluationToolStubsDirectory } from "#internal/application/dev-environment.js";
import { resolvePackageSourceFilePath } from "#internal/application/package.js";
import type { ToolContext } from "#tools/definition.js";

const TOOL_STUB_SET_FILE = /\.[cm]?[jt]s$/u;

/** A session create named a stub set this server cannot provide. */
export class ToolStubsSelectionError extends Error {}

interface LoadedToolStubSet {
  readonly definition: ToolStubsDefinition;
  /** Path relative to the app, for error messages: `evals/stubs/two-workflows.ts`. */
  readonly displayPath: string;
}

interface ToolStubsProcessState {
  /** Stub set loads by file path without the extension. */
  readonly sets: Map<string, Promise<LoadedToolStubSet>>;
  /** Stub sets whose load finished, by the same key. */
  readonly loaded: Map<string, LoadedToolStubSet>;
  /**
   * Stub state by world id. One world holds a root session's and its
   * subagents' state. Worlds live as long as the `eve eval` server.
   */
  readonly worlds: Map<string, { readonly state: unknown }>;
  /** A missing stub a subagent hit, by world id, until the root session's next step. */
  readonly subagentFailures: Map<string, TurnFailingToolError>;
}

// Shared on globalThis so every copy of eve loaded into the eval server sees the same worlds.
const processState = ((globalThis as Record<symbol, unknown>)[Symbol.for("eve.toolStubs")] ??= {
  loaded: new Map(),
  sets: new Map(),
  subagentFailures: new Map(),
  worlds: new Map(),
}) as ToolStubsProcessState;

/**
 * Resolves the `stubs` field of a session create. Throws
 * {@link ToolStubsSelectionError} when this server is not the one `eve eval`
 * started, or when the set does not exist or does not load.
 */
export async function selectToolStubs(set: string): Promise<ToolStubsSelection> {
  await loadToolStubSet(set);
  return { set, worldId: randomUUID() };
}

type ToolExecute<TInput> = (toolInput: TInput, ctx: ToolContext) => unknown;

/**
 * Wraps one tool's `execute` for stubbed eval sessions. A session with a stub
 * set runs the set's stub for the tool. Without a stub, `withoutStub: "run"`
 * runs the real tool, and `"fail"` fails the turn. Sessions without a stub set
 * run the real tool.
 */
export function withToolStubs<TInput>(
  execute: ToolExecute<TInput>,
  withoutStub: "fail" | "run",
): ToolExecute<TInput> {
  return (toolInput, ctx) => {
    const selection = contextStorage.getStore()?.get(ToolStubsKey);
    if (selection === undefined) return execute(toolInput, ctx);
    const runReal = withoutStub === "run" ? () => execute(toolInput, ctx) : undefined;
    return runSelectedStub({ ctx, runReal, selection, toolInput });
  };
}

/**
 * Runs the selected set's stub for one call. Without a stub, `runReal` runs
 * the real tool, and its absence fails the turn.
 */
function runSelectedStub(input: {
  readonly ctx: ToolContext;
  readonly runReal: (() => unknown) | undefined;
  readonly selection: ToolStubsSelection;
  readonly toolInput: unknown;
}): unknown {
  // The set loaded at session create, so the result normally passes through unwrapped.
  const loaded = processState.loaded.get(toolStubSetKey(input.selection.set));
  return loaded === undefined
    ? loadToolStubSet(input.selection.set).then((set) => runToolStub(set, input))
    : runToolStub(loaded, input);
}

function runToolStub(
  loaded: LoadedToolStubSet,
  input: Parameters<typeof runSelectedStub>[0],
): unknown {
  const { ctx, selection } = input;
  const stub = loaded.definition.tools[ctx.toolName];
  if (stub !== undefined) {
    return stub(input.toolInput, { ...ctx, state: readWorldState(selection, loaded) });
  }
  if (input.runReal !== undefined) return input.runReal();
  const failure = new TurnFailingToolError({
    code: "TOOL_STUB_MISSING",
    message:
      `Stub set "${selection.set}" has no stub for tool "${ctx.toolName}", so the real tool did not run. ` +
      `Add tools.${ctx.toolName} to ${loaded.displayPath}.`,
  });
  if (contextStorage.getStore()?.get(ParentSessionKey) !== undefined) {
    processState.subagentFailures.set(selection.worldId, failure);
  }
  throw failure;
}

/**
 * Prepares a tool that runs outside the model step (a workflow tool, a
 * subagent, or a remote agent) for a stubbed session. When the stub set
 * stubs the tool by name, the stub answers the call in the model step. A
 * remote agent without a stub fails the turn, because it cannot use the
 * session's stubs; other tools run as usual.
 */
export function withDispatchToolStubs(definition: HarnessToolDefinition): HarnessToolDefinition {
  const selection = contextStorage.getStore()?.get(ToolStubsKey);
  if (selection === undefined) return definition;
  const loaded = processState.loaded.get(toolStubSetKey(selection.set));
  const handling = definition.behavior?.handling;
  const remote = handling?.kind === "dispatch" && handling.target.kind === "remote-agent-call";
  if (loaded?.definition.tools[definition.name] === undefined && !remote) return definition;
  return {
    ...definition,
    behavior: definition.behavior && { ...definition.behavior, handling: undefined },
    execute: createToolExecuteWithAuth({
      execute: (toolInput, ctx) =>
        runSelectedStub({ ctx, runReal: undefined, selection, toolInput }),
      scope: definition.name,
    }),
    executeInput: undefined,
    workflowId: undefined,
  };
}

/**
 * Fails a root session's turn when one of its subagents called a tool the
 * stub set does not stub. Runs before each harness step.
 */
export function recordSubagentToolStubFailure(): void {
  const ctx = contextStorage.getStore();
  const selection = ctx?.get(ToolStubsKey);
  if (selection === undefined || ctx?.get(ParentSessionKey) !== undefined) return;
  const failure = processState.subagentFailures.get(selection.worldId);
  if (failure === undefined) return;
  processState.subagentFailures.delete(selection.worldId);
  recordTurnFailingToolError(failure);
}

function readWorldState(selection: ToolStubsSelection, loaded: LoadedToolStubSet): unknown {
  let world = processState.worlds.get(selection.worldId);
  if (world === undefined) {
    world = { state: loaded.definition.state?.() };
    processState.worlds.set(selection.worldId, world);
  }
  return world.state;
}

function loadToolStubSet(set: string): Promise<LoadedToolStubSet> {
  const directory = resolveEveEvaluationToolStubsDirectory();
  if (directory === undefined) {
    return Promise.reject(
      new ToolStubsSelectionError(
        "'stubs' is accepted only by the agent server that `eve eval` starts. " +
          "Stub sets are not available to `eve eval --url` targets or deployed agents.",
      ),
    );
  }
  const key = toolStubSetKey(set);
  let loading = processState.sets.get(key);
  if (loading === undefined) {
    loading = importToolStubSet(directory, set);
    processState.sets.set(key, loading);
    loading.then(
      (loaded) => processState.loaded.set(key, loaded),
      // A failed load is not cached, so fixing the file fixes the next session.
      () => processState.sets.delete(key),
    );
  }
  return loading;
}

function toolStubSetKey(set: string): string {
  return join(resolveEveEvaluationToolStubsDirectory() ?? "", set);
}

async function importToolStubSet(directory: string, set: string): Promise<LoadedToolStubSet> {
  const files = await listToolStubSetFiles(directory);
  const filePath = files.get(set);
  if (filePath === undefined) {
    const found = [...files.keys()];
    throw new ToolStubsSelectionError(
      found.length === 0
        ? `Unknown stub set "${set}": ${displayDirectory(directory)} has no stub sets.`
        : `Unknown stub set "${set}". Stub sets in ${displayDirectory(directory)}: ${found.join(", ")}.`,
    );
  }
  const displayPath = `${displayDirectory(directory)}${relative(directory, filePath).split("\\").join("/")}`;
  // Loaded by path so deployed builds, which never select a stub set, do not bundle the loader.
  const loader = (await import(
    pathToFileURL(resolvePackageSourceFilePath("src/internal/authored-module-loader.ts")).href
  )) as typeof import("#internal/authored-module-loader.js");
  const namespace = await loader.loadAuthoredModuleNamespace(filePath);
  const definition = namespace.default as Partial<ToolStubsDefinition> | undefined;
  if (definition?._tag !== "EveToolStubs") {
    throw new ToolStubsSelectionError(
      `${displayPath} must default-export defineToolStubs({ ... }) from "eve/evals".`,
    );
  }
  return { definition: definition as ToolStubsDefinition, displayPath };
}

/** Maps each stub set name (`slack/two-channels`) to its file. */
async function listToolStubSetFiles(directory: string): Promise<Map<string, string>> {
  let entries;
  try {
    entries = await readdir(directory, { recursive: true, withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  const files = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.isFile() || !TOOL_STUB_SET_FILE.test(entry.name) || entry.name.endsWith(".d.ts")) {
      continue;
    }
    const filePath = join(entry.parentPath, entry.name);
    const name = relative(directory, filePath)
      .split("\\")
      .join("/")
      .replace(TOOL_STUB_SET_FILE, "");
    files.set(name, filePath);
  }
  return new Map([...files].sort(([a], [b]) => a.localeCompare(b)));
}

function displayDirectory(directory: string): string {
  return `${relative(join(directory, "..", ".."), directory)
    .split("\\")
    .join("/")}/`;
}
