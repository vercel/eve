import type { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test, vi } from "vitest";

const signOff = "sign off as the Support Team";

test("lists a saved rule later in the same conversation", async () => {
  const conversation = new SessionState("session-a");
  await save(conversation, "sign-off", signOff);
  await save(conversation, "greeting", "greet customers by first name");
  const listed = JSON.stringify(await list(conversation));
  expect(listed).toContain("sign-off");
  expect(listed).toContain(signOff);
  expect(listed).toContain("greet customers by first name");
});

test("keeps rules out of other conversations", async () => {
  await save(new SessionState("session-b"), "tone", "never use exclamation marks");
  expect(JSON.stringify(await list(new SessionState("session-c")))).not.toContain("exclamation");
});

test("keeps rules across a server restart", async () => {
  const conversation = new SessionState("session-d");
  await save(conversation, "length", "keep replies under 120 words");
  // A restart loses everything held in module memory; eve restores the session's saved context.
  vi.resetModules();
  expect(JSON.stringify(await list(conversation))).toContain("keep replies under 120 words");
});

async function save(session: SessionState, name: string, rule: string) {
  const tool = await load("agent/tools/save_rule.ts");
  const parsed = await parseInput(tool, { name, rule });
  if (parsed === undefined) throw new Error("The save_rule schema rejected { name, rule }.");
  return runTool(tool, parsed, session);
}

async function list(session: SessionState) {
  const tool = await load("agent/tools/list_rules.ts");
  return runTool(tool, (await parseInput(tool, {})) ?? {}, session);
}

/** Runs a tool call the way eve does: with a call context, inside the session's saved context. */
// oxlint-disable-next-line typescript/no-explicit-any -- graded modules are untyped.
async function runTool(tool: any, input: unknown, session: SessionState): Promise<unknown> {
  const call = {
    abortSignal: new AbortController().signal,
    callId: `call-${Math.random().toString(36).slice(2)}`,
    toolName: "graded",
    messages: [],
    channel: { kind: "eve" },
    session: {
      id: session.id,
      auth: { current: null, initiator: null },
      turn: { id: `turn-${Math.random().toString(36).slice(2)}`, sequence: 0 },
    },
  };
  return (await sessionStorage()).run({ context: session }, () => tool.execute(input, call));
}

/**
 * The process-wide storage eve keeps its session context in, shared by every eve copy. eve
 * creates it when its context module loads, so load it from the project's eve first.
 */
async function sessionStorage(): Promise<AsyncLocalStorage<{ context: SessionState }>> {
  await importProjectEve("./context");
  const storage = (
    globalThis as Record<symbol, AsyncLocalStorage<{ context: SessionState }> | undefined>
  )[Symbol.for("eve.context-storage")];
  if (!storage) throw new Error("eve context storage is missing after loading eve/context.");
  return storage;
}

/** One conversation's saved context values, as `defineState` reads and writes them. */
class SessionState {
  private readonly values = new Map<string, unknown>();
  constructor(readonly id: string) {}
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
    // Saved context is serialized, so it never shares objects with module memory.
    this.values.set(key.name, structuredClone(next));
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
 * Validates input the way eve does for any accepted schema: Standard Schema
 * (Zod and others), or a plain JSON Schema object, which eve does not validate here.
 */
// oxlint-disable-next-line typescript/no-explicit-any -- graded modules are untyped.
async function parseInput(tool: any, input: unknown): Promise<unknown> {
  const standard = tool.inputSchema?.["~standard"];
  if (typeof standard?.validate === "function") {
    const result = await standard.validate(input);
    return result.issues ? undefined : result.value;
  }
  if (typeof tool.inputSchema?.safeParse === "function") {
    const result = tool.inputSchema.safeParse(input);
    return result.success ? result.data : undefined;
  }
  return input;
}

/** Imports an `eve` entry point as the authored modules resolve it, sharing their module instance. */
// oxlint-disable-next-line typescript/no-explicit-any -- eve's types aren't installed at the root.
async function importProjectEve(subpath: string): Promise<any> {
  const eveRoot = "node_modules/eve";
  const target = JSON.parse(readFileSync(`${eveRoot}/package.json`, "utf8")).exports[subpath];
  return import(pathToFileURL(resolve(eveRoot, target.import ?? target.default)).href);
}

// oxlint-disable-next-line typescript/no-explicit-any -- graded modules are untyped.
async function load(path: string): Promise<any> {
  return (await import(pathToFileURL(resolve(path)).href)).default;
}
