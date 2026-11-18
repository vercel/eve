// How eve runs authored code, faked the same way in every authoring grader: tool calls with
// their context and session state, approvals, dynamic definitions, and the project's own eve.
// Most false failures in new graders came from a hand-rolled copy of one of these missing
// something eve provides, so they live here once.
//
// agent-eval hides only files named EVAL.ts (and PROMPT.md) from the agent, so a grader can't
// import a sibling module. `pnpm grader-kit:sync` copies this file between the grader-kit
// markers of every EVAL.ts that has them, and `scripts/grader-kit.test.mjs` fails when a copy
// drifts. Edit it here, never in an EVAL.ts.
//
// Imports are namespaced so they can't clash with a grader's own, and the file has no other
// imports: a copy has to stand alone in the grader's workspace.
import type { AsyncLocalStorage as GraderKitAsyncLocalStorage } from "node:async_hooks";
import * as graderKitFs from "node:fs";
import * as graderKitPath from "node:path";
import * as graderKitUrl from "node:url";

/** Whether an approval policy's decision asks a person first. */
export function requiresApproval(decision: unknown): boolean {
  if (decision === true || decision === "user-approval") return true;
  return (
    typeof decision === "object" &&
    decision !== null &&
    "type" in decision &&
    decision.type === "user-approval"
  );
}

/** Validates tool input the way eve does: Standard Schema first, then Zod's `safeParse`. */
// oxlint-disable-next-line typescript/no-explicit-any -- graded modules are untyped.
export async function parseInput(
  tool: any,
  input: unknown,
): Promise<{ success: boolean; data?: any }> {
  const standard = tool.inputSchema?.["~standard"];
  if (typeof standard?.validate === "function") {
    const result = await standard.validate(input);
    return result.issues ? { success: false } : { success: true, data: result.value };
  }
  if (typeof tool.inputSchema?.safeParse === "function") return tool.inputSchema.safeParse(input);
  return { success: true, data: input };
}

/**
 * Runs a call that may be refused, ignoring the refusal. A tool can refuse by rejecting or by
 * throwing synchronously (a non-async `execute`); eve treats both as the call failing.
 */
export async function settle(call: () => unknown): Promise<void> {
  try {
    await call();
  } catch {}
}

/**
 * Imports an `eve` entry point as the authored modules resolve it, sharing their module
 * instance. `projectRoot` is the directory whose `node_modules/eve` the project uses.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- eve's types aren't installed at the root.
export async function importProjectEve(subpath: string, projectRoot = "."): Promise<any> {
  const eveRoot = graderKitPath.join(projectRoot, "node_modules/eve");
  const target = JSON.parse(
    graderKitFs.readFileSync(graderKitPath.join(eveRoot, "package.json"), "utf8"),
  ).exports[subpath];
  return import(
    graderKitUrl.pathToFileURL(graderKitPath.resolve(eveRoot, target.import ?? target.default)).href
  );
}

/** A session's context values, as `defineState` reads and writes them. */
export class SessionState {
  private readonly values = new Map<string, unknown>();
  get(key: { name: string }) {
    return this.values.get(key.name);
  }
  require(key: { name: string }) {
    if (!this.values.has(key.name)) throw new Error(`Context key "${key.name}" is not set.`);
    return this.values.get(key.name);
  }
  has(key: { name: string }) {
    return this.values.has(key.name);
  }
  set(key: { name: string }, value: unknown) {
    const next = typeof value === "function" ? value(this.values.get(key.name)) : value;
    this.values.set(key.name, next);
    return next;
  }
  ensure(key: { name: string }, create: () => unknown) {
    return this.has(key) ? this.values.get(key.name) : this.set(key, create());
  }
  delete(key: { name: string }) {
    return this.values.delete(key.name);
  }
  setVirtualContext(key: { name: string }, value: unknown) {
    this.values.set(key.name, value);
  }
  *entries() {}
}

/**
 * The process-wide storage eve keeps its session context in, shared by every eve copy. eve
 * creates it when its context module loads, and `eve/tools` and `eve/extension` don't load
 * that module, so a solution that never imports `eve/context` would leave it missing. Load
 * it from the project's eve first.
 */
export async function sessionStorage(
  projectRoot = ".",
): Promise<GraderKitAsyncLocalStorage<{ context: SessionState }>> {
  await importProjectEve("./context", projectRoot);
  const key = Symbol.for("eve.context-storage");
  const global = globalThis as Record<
    symbol,
    GraderKitAsyncLocalStorage<{ context: SessionState }> | undefined
  >;
  const storage = global[key];
  if (!storage) throw new Error("eve context storage is missing after loading eve/context.");
  return storage;
}

/** The session eve hands tools, hooks, and approval policies: one conversation, in its first turn. */
export const graderSession = {
  id: "session-1",
  auth: { current: null, initiator: null },
  turn: { id: "turn-1", sequence: 0 },
};

/** The person who approves calls in the grader, as eve hands them to an approved call. */
export const graderApprover = {
  authenticator: "grader",
  issuer: "grader",
  principalId: "approver-1",
  principalType: "user",
  subject: "approver-1",
  attributes: {},
  getToken: async () => {
    throw new Error("The grader has no provider tokens.");
  },
};

/**
 * Runs a tool call the way eve does: input validated, a call context with a fresh ID and the
 * session, inside a session whose state the tools can read and write. Pass the same
 * `SessionState` to calls that belong to one conversation. eve only runs a tool that asks for
 * approval once a person approves, and tells the call who did, so those calls get an approver.
 */
export async function runTool(
  // oxlint-disable-next-line typescript/no-explicit-any -- graded modules are untyped.
  tool: any,
  input: unknown,
  session = new SessionState(),
  projectRoot = ".",
): Promise<unknown> {
  const parsed = tool.inputSchema?.parse ? tool.inputSchema.parse(input) : input;
  const call: Record<string, unknown> = {
    abortSignal: new AbortController().signal,
    callId: `call-${Math.random().toString(36).slice(2)}`,
    toolName: "graded",
    messages: [],
    channel: { kind: "eve" },
    session: graderSession,
  };
  if (tool.approval !== undefined) call.approval = { responder: graderApprover };
  return (await sessionStorage(projectRoot)).run({ context: session }, () =>
    tool.execute(parsed, call),
  );
}

/**
 * The function behind a `defineDynamic()` value, or undefined for anything else. eve keeps it
 * under a cross-instance brand; packages before the pre-1.0 cleanup exposed it as
 * `{ kind: "eve:dynamic", evaluate }`.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- graded modules are untyped.
export function dynamicEvaluator(definition: any): ((context: unknown) => unknown) | undefined {
  const evaluate =
    definition?.[Symbol.for("eve.dynamic")] ??
    (definition?.kind === "eve:dynamic" ? definition.evaluate : undefined);
  return typeof evaluate === "function" ? evaluate : undefined;
}

/** The context eve resolves a dynamic definition with, for one session and channel. */
export function dynamicContext(
  session: unknown,
  channel: unknown = { kind: "http", metadata: {} },
) {
  return {
    session,
    channel,
    // eve's view is opaque; a gate has no reason to read it here.
    view: {},
    turn: null,
    now: new Date(),
    model: { id: "anthropic/claude-sonnet-5" },
    memo: async (key: unknown, fn: (occurrence: unknown) => unknown) =>
      fn({ idempotencyKey: JSON.stringify(key), abortSignal: new AbortController().signal }),
    messages: async () => [],
  };
}
