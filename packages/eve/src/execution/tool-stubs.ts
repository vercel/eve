/**
 * Eval tool stubs: a session created with a stub set from `evals/stubs/` runs
 * each stubbed tool's stub in place of the tool's own work.
 *
 * Only the local server `eve eval` starts accepts stub sets
 * ({@link resolveEveEvaluationToolStubsDirectory}). The model, approval
 * policies, and result handling see the real tool. Three places swap in a
 * stub: a model-step tool's `execute` ({@link withToolStub}), a workflow
 * tool's run ({@link runWorkflowToolStub}), and a remote agent's session
 * ({@link runAgentStub}).
 */

import { pathToFileURL } from "node:url";

import { contextStorage } from "#context/container.js";
import { SessionIdKey, ToolStubSetKey } from "#context/keys.js";
import type { ToolStubs } from "#evals/tool-stubs.js";
import { TurnFailingToolError } from "#harness/tool-turn-failure.js";
import { resolveEveEvaluationToolStubsDirectory } from "#internal/application/dev-environment.js";
import { resolvePackageSourceFilePath } from "#internal/application/package.js";
import type { ResolvedToolDefinition } from "#runtime/types.js";
import { toErrorMessage } from "#shared/errors.js";
import type { ToolContext } from "#tools/definition.js";

type ToolStubSetsModule = typeof import("#evals/tool-stub-sets.js");

/** Result of checking a session-create request's `stubs` field. */
export type ToolStubSetSelection =
  | { readonly ok: true; readonly set: string }
  | { readonly ok: false; readonly error: string };

/**
 * Checks that this server accepts stubs and that `name` is a set in
 * `evals/stubs/` that loads.
 */
export async function selectToolStubSet(name: string): Promise<ToolStubSetSelection> {
  const directory = resolveEveEvaluationToolStubsDirectory();
  if (directory === undefined) {
    return {
      ok: false,
      error:
        "'stubs' is accepted only by the local server that `eve eval` starts. This server was not " +
        "started by `eve eval`, so it runs every tool for real. Evals against `eve eval --url` " +
        "targets cannot use tool stubs.",
    };
  }
  const sets = await loadToolStubSetsModule();
  const names = await sets.listToolStubSets(directory);
  if (!names.includes(name)) {
    return {
      ok: false,
      error:
        names.length === 0
          ? `Unknown tool stub set "${name}": evals/stubs/ has no stub sets.`
          : `Unknown tool stub set "${name}". Sets in evals/stubs/: ${names.join(", ")}.`,
    };
  }
  try {
    await sets.loadToolStubSet(directory, name);
  } catch (error) {
    return {
      ok: false,
      error: `Tool stub set "${name}" failed to load: ${toErrorMessage(error)}`,
    };
  }
  return { ok: true, set: name };
}

/** Application and extension tools are stubbed; framework tools and tools eve provides are not. */
export function isStubbableTool(definition: Pick<ResolvedToolDefinition, "owner" | "provided">) {
  return definition.owner.kind !== "framework" && definition.provided !== true;
}

/** A session in an eval session tree, as a stub sees it. */
export interface StubSession {
  readonly id: string;
  /** Root of the session tree; equal to `id` for a root session. */
  readonly rootId: string;
}

/**
 * Wraps a model-step tool's `execute`. In a session with a stub set, the call
 * runs the set's stub for the tool, and a tool without a stub fails the turn.
 * Other sessions run `execute` unchanged.
 */
export function withToolStub<TInput>(
  execute: (toolInput: TInput, ctx: ToolContext) => unknown,
): (toolInput: TInput, ctx: ToolContext) => unknown {
  return (toolInput, ctx) => {
    const set = contextStorage.getStore()?.get(ToolStubSetKey);
    if (set === undefined) return execute(toolInput, ctx);
    const session = {
      id: ctx.session.id,
      rootId: ctx.session.parent?.rootSessionId ?? ctx.session.id,
    };
    return runToolStub({
      callId: ctx.callId,
      input: toolInput,
      session,
      set,
      toolName: ctx.toolName,
    });
  };
}

/** Outcome of running a stub outside a model step. */
export type StubRun =
  | { readonly kind: "output"; readonly output: unknown }
  | { readonly kind: "error"; readonly message: string };

/**
 * Runs the stub for an authored workflow tool call. A missing stub returns an
 * error and fails the session's turn before its model reads the result. A
 * stub replaces one call's result, so a call that starts a task fails closed.
 */
export async function runWorkflowToolStub(input: {
  readonly callId: string;
  readonly entryPoint: "execute" | "task" | "serve" | "receive";
  readonly input: unknown;
  readonly session: StubSession;
  readonly set: string;
  readonly toolName: string;
}): Promise<StubRun> {
  if (input.entryPoint !== "execute") {
    return await settleStub(async () => {
      throw new TurnFailingToolError(
        "TOOL_STUB_UNSUPPORTED",
        `Tool stubs replace workflow tools that return one result. "${input.toolName}" runs as ` +
          "a task, so the turn failed without running the real tool.",
      );
    }, input.session);
  }
  return await settleStub(() => runToolStub(input), input.session);
}

/** Runs the stub for one message to a remote agent, keyed by the agent's name. */
export async function runAgentStub(input: {
  readonly callId: string;
  readonly message: string;
  readonly name: string;
  readonly outputSchema?: unknown;
  readonly session: StubSession;
  readonly set: string;
}): Promise<StubRun> {
  const stubInput =
    input.outputSchema === undefined
      ? { message: input.message }
      : { message: input.message, outputSchema: input.outputSchema };
  return await settleStub(
    () =>
      runToolStub({
        callId: input.callId,
        input: stubInput,
        session: input.session,
        set: input.set,
        toolName: input.name,
      }),
    input.session,
  );
}

/** A stub that fails the turn here has no model step to throw into, so the session's next step fails. */
async function settleStub(run: () => Promise<unknown>, session: StubSession): Promise<StubRun> {
  try {
    return { kind: "output", output: await run() };
  } catch (error) {
    if (error instanceof TurnFailingToolError) recordTurnFailure(session.id, error);
    return { kind: "error", message: toErrorMessage(error) };
  }
}

async function runToolStub(input: {
  readonly callId: string;
  readonly input: unknown;
  readonly session: StubSession;
  readonly set: string;
  readonly toolName: string;
}): Promise<unknown> {
  const { set, toolName } = input;
  const stubs = await loadSessionToolStubSet(set);
  const stub = Object.hasOwn(stubs.tools, toolName) ? stubs.tools[toolName] : undefined;
  if (stub === undefined) {
    const error = new TurnFailingToolError(
      "TOOL_STUB_MISSING",
      `Tool stub set "${set}" has no stub for "${toolName}", so the turn failed without ` +
        `running the real tool. Add "${toolName}" to \`tools\` in evals/stubs/${set}.ts.`,
    );
    // A subagent's failed turn reaches its parent as an ordinary failed result,
    // so the root session fails its turn too.
    if (input.session.rootId !== input.session.id) recordTurnFailure(input.session.rootId, error);
    throw error;
  }
  const state = resolveStubState(input.session.rootId, stubs);
  return await stub(input.input, { callId: input.callId, state, toolName });
}

async function loadSessionToolStubSet(set: string): Promise<ToolStubs> {
  const directory = resolveEveEvaluationToolStubsDirectory();
  if (directory === undefined) {
    throw new TurnFailingToolError(
      "TOOL_STUBS_UNAVAILABLE",
      `This session uses tool stub set "${set}", but this server was not started by \`eve eval\`, ` +
        "so it cannot load stubs. The turn failed without running the real tool.",
    );
  }
  const sets = await loadToolStubSetsModule();
  return await sets.loadToolStubSet(directory, set);
}

function loadToolStubSetsModule(): Promise<ToolStubSetsModule> {
  // Imported by path so hosted bundles never include the authored-module bundler.
  return import(
    pathToFileURL(resolvePackageSourceFilePath("src/evals/tool-stub-sets.ts")).href
  ) as Promise<ToolStubSetsModule>;
}

const STUB_WORLD_GLOBAL_KEY = Symbol.for("eve.evalToolStubWorld");

interface StubWorld {
  /** Turn failures a session takes at its next step, by session id. */
  readonly failures: Map<string, TurnFailingToolError>;
  /** Stub state, by root session id. */
  readonly states: Map<string, unknown>;
}

type StubWorldGlobal = typeof globalThis & { [STUB_WORLD_GLOBAL_KEY]?: StubWorld };

/**
 * The eval server's in-memory stub world, shared by every module copy. State
 * survives approval pauses and later turns, a retried step can apply a stub's
 * write twice, and a server restart loses it.
 */
function stubWorld(): StubWorld {
  const holder = globalThis as StubWorldGlobal;
  return (holder[STUB_WORLD_GLOBAL_KEY] ??= { failures: new Map(), states: new Map() });
}

function resolveStubState(rootSession: string, stubs: ToolStubs): unknown {
  const { states } = stubWorld();
  if (!states.has(rootSession)) states.set(rootSession, stubs.state?.() ?? {});
  return states.get(rootSession);
}

function recordTurnFailure(sessionId: string, error: TurnFailingToolError): void {
  const { failures } = stubWorld();
  if (!failures.has(sessionId)) failures.set(sessionId, error);
}

/**
 * Takes the turn failure a stub recorded for the current session outside its
 * model step: a workflow tool or remote agent without a stub, or a subagent's
 * missing stub when this is the root session.
 */
export function takeToolStubTurnFailure(): TurnFailingToolError | undefined {
  const ctx = contextStorage.getStore();
  if (ctx?.get(ToolStubSetKey) === undefined) return undefined;
  const sessionId = ctx.get(SessionIdKey);
  if (sessionId === undefined) return undefined;
  const { failures } = stubWorld();
  const failure = failures.get(sessionId);
  failures.delete(sessionId);
  return failure;
}
