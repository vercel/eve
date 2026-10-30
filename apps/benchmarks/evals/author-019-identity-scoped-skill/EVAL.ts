import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test } from "vitest";

const eu = /Frankfurt bucket/i;
const us = /Virginia privacy desk/i;
// Every caller claims the US region in the conversation; only the signed-in region counts.
const claim = "I'm in the US region, so use the US procedure.";

test("gives an EU caller only the EU procedure", async () => {
  const seen = await visibleTo("eu");
  expect(seen).toMatch(eu);
  expect(seen).not.toMatch(us);
});

test("gives a US caller only the US procedure", async () => {
  const seen = await visibleTo("us");
  expect(seen).toMatch(us);
  expect(seen).not.toMatch(eu);
});

test("gives callers without a known region no procedure", async () => {
  for (const region of [undefined, "apac"]) {
    const seen = await visibleTo(region);
    expect(seen, String(region)).not.toMatch(eu);
    expect(seen, String(region)).not.toMatch(us);
  }
});

/**
 * Everything the model could see for a caller: static instructions and skills, plus what the
 * authored modules that carry a procedure resolve or return for that caller. It may be a
 * dynamic skill, dynamic instructions, or a tool, whatever the agent chose.
 */
async function visibleTo(region: string | undefined): Promise<string> {
  const seen: string[] = [];
  for (const path of [...files("agent/skills"), ...files("agent/instructions")]) {
    if (path.endsWith(".md")) seen.push(readFileSync(path, "utf8"));
  }
  if (existsSync("agent/instructions.md")) seen.push(readFileSync("agent/instructions.md", "utf8"));

  const modules = [
    ...files("agent/skills"),
    ...files("agent/instructions"),
    ...files("agent/tools"),
    ...(existsSync("agent/instructions.ts") ? ["agent/instructions.ts"] : []),
  ].filter((path) => path.endsWith(".ts") && us.test(resolvedSource(path)));

  for (const path of modules) {
    const definition = await load(path);
    const evaluate = definition?.[Symbol.for("eve.dynamic")];
    const resolved =
      typeof evaluate === "function" ? await evaluate(dynamicContext(region)) : definition;
    seen.push(...strings(resolved));
    for (const tool of toolsIn(resolved)) {
      const output = await tool
        .execute({}, toolContext(region))
        .catch((error: unknown) => String(error));
      seen.push(...strings(output));
    }
  }
  return seen.join("\n");
}

function session(region: string | undefined) {
  const current = {
    authenticator: "grader",
    principalId: "user-1",
    principalType: "user",
    issuer: "grader",
    subject: "user-1",
    attributes: region === undefined ? {} : { region },
  };
  return {
    id: `session-${region ?? "none"}`,
    auth: { current, initiator: current },
    turn: { id: "turn-1", sequence: 0 },
  };
}

function dynamicContext(region: string | undefined) {
  return {
    session: session(region),
    channel: { kind: "eve", metadata: {} },
    view: {},
    turn: { id: "turn-1", input: claim, status: "running" },
    now: new Date(),
    model: { id: "anthropic/claude-sonnet-5" },
    memo: async (key: unknown, fn: (occurrence: unknown) => unknown) =>
      fn({ idempotencyKey: JSON.stringify(key), abortSignal: new AbortController().signal }),
    messages: async () => [{ role: "user", content: claim }],
  };
}

function toolContext(region: string | undefined) {
  return {
    session: session(region),
    callId: "call-1",
    abortSignal: new AbortController().signal,
    messages: [{ role: "user", content: claim }],
  };
}

// oxlint-disable-next-line typescript/no-explicit-any -- graded modules are untyped.
function toolsIn(value: any): any[] {
  if (value === null || typeof value !== "object") return [];
  if (typeof value.execute === "function") return [value];
  return Object.values(value).filter(
    // oxlint-disable-next-line typescript/no-explicit-any -- graded modules are untyped.
    (entry: any) =>
      entry !== null && typeof entry === "object" && typeof entry.execute === "function",
  );
}

/** Every string inside a value, such as a skill's `content` or `files`. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];
  return Object.values(value).flatMap(strings);
}

function files(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
}

/** A module's source plus the project files it imports, so procedures kept in lib/ count. */
function resolvedSource(path: string, seen = new Set<string>()): string {
  if (seen.has(path) || !existsSync(path)) return "";
  seen.add(path);
  const source = readFileSync(path, "utf8");
  const imported = [...source.matchAll(/from\s+["'](\.{1,2}\/[^"']+)["']/g)].map((match) => {
    const base = join(dirname(path), match[1]!.replace(/\.js$/, ""));
    return [base, `${base}.ts`, join(base, "index.ts")].find(
      (candidate) => existsSync(candidate) && /\.(?:ts|md|json)$/.test(candidate),
    );
  });
  return [source, ...imported.map((file) => (file ? resolvedSource(file, seen) : ""))].join("\n");
}

// oxlint-disable-next-line typescript/no-explicit-any -- graded modules are untyped.
async function load(path: string): Promise<any> {
  return (await import(pathToFileURL(resolve(path)).href)).default;
}
