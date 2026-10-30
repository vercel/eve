import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test } from "vitest";

const toolPath = "agent/tools/bar_chart.ts";
// The 8-byte PNG signature plus a marker, so the grader can find these exact bytes in the output.
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  Buffer.from("eve-grader-chart"),
]);
const bars = [
  { label: "high", value: 37 },
  { label: "medium", value: 12 },
];

test("installs matplotlib when the sandbox is prepared, not on each call", () => {
  const setup = filesUnder("agent/sandbox").filter((path) => !path.includes("/workspace/"));
  expect(setup.some((path) => /matplotlib/.test(readFileSync(path, "utf8")))).toBe(true);
  expect(readFileSync(toolPath, "utf8")).not.toMatch(/\b(?:pip3?|uv)\b[^\n]*\binstall\b/);
});

test("seeds the field reference into the sandbox", () => {
  const seeded = filesUnder("agent/sandbox/workspace").find((path) =>
    path.endsWith("reference/ticket-fields.md"),
  );
  // Or written by the sandbox's own setup code.
  const source = seeded
    ? readFileSync(seeded, "utf8")
    : filesUnder("agent/sandbox")
        .map((path) => readFileSync(path, "utf8"))
        .find((text) => /ticket-fields\.md/.test(text));
  expect(source).toBeDefined();
  expect(source).toMatch(/minutes_to_resolve/);
  expect(source).toMatch(/low, medium, high/);
});

test("renders the chart with Python in the sandbox and returns the PNG", async () => {
  const sandbox = fakeSandbox();
  const output = await chart(sandbox);

  expect(sandbox.commands.some((command) => /\bpython/.test(command))).toBe(true);
  // The bars reach the sandbox in a command, a written file, the environment, or stdin, possibly
  // base64-encoded.
  const sent = withDecodedBase64(
    [...sandbox.commands, ...sandbox.written.values(), ...sandbox.inputs].join("\n"),
  );
  expect(sent).toContain("medium");
  expect(sent).toContain("37");
  expect(JSON.stringify(output)).toContain(png.toString("base64"));
});

test("keeps the PNG out of the model's context", async () => {
  const tool = await load(toolPath);
  expect(typeof tool.toModelOutput).toBe("function");
  const output = await chart(fakeSandbox());
  const modelOutput = await tool.toModelOutput(output);
  expect(JSON.stringify(modelOutput)).not.toContain(png.toString("base64"));
});

test("fails instead of reporting a chart when Python fails", async () => {
  let output: unknown;
  try {
    output = await chart(fakeSandbox({ pythonFails: true }));
  } catch {
    return;
  }
  expect(JSON.stringify(output)).not.toContain(png.toString("base64"));
  expect(JSON.stringify(output)).toMatch(/error|fail/i);
});

async function chart(sandbox: ReturnType<typeof fakeSandbox>): Promise<unknown> {
  const tool = await load(toolPath);
  const input = await parseInput(tool, { title: "Tickets by priority", bars });
  return tool.execute(input, {
    session: { id: "session-1" },
    callId: "call-1",
    abortSignal: new AbortController().signal,
    getSandbox: async () => sandbox,
  });
}

/**
 * An in-memory eve sandbox session. Running Python "renders" the chart: from then on, any `.png`
 * path reads back as the grader's PNG, and a `base64` command prints it. Python prints it too when
 * the command or a script it could run (written now, or seeded into the workspace) encodes base64.
 */
function fakeSandbox({ pythonFails = false } = {}) {
  const commands: string[] = [];
  // Environment values and stdin passed to commands.
  const inputs: string[] = [];
  const written = new Map<string, string>();
  const seeded = filesUnder("agent/sandbox").map((path) => readFileSync(path, "utf8"));
  let rendered = false;
  const resolvePath = (path: string) => (path.startsWith("/") ? path : `/workspace/${path}`);
  const readPng = (path: string) => (rendered && path.endsWith(".png") ? png : null);
  const run = async ({ command, env }: { command: string; env?: Record<string, string> }) => {
    commands.push(command);
    inputs.push(...Object.values(env ?? {}));
    if (/\bpython/.test(command)) {
      if (pythonFails) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: "ModuleNotFoundError: No module named 'matplotlib'",
        };
      }
      rendered = true;
      // A script may print the PNG as base64 itself.
      if (/base64/.test([command, ...written.values(), ...seeded].join("\n"))) {
        return { exitCode: 0, stdout: `${png.toString("base64")}\n`, stderr: "" };
      }
    }
    if (rendered && /\bbase64\b/.test(command) && /\.png\b/.test(command)) {
      return { exitCode: 0, stdout: `${png.toString("base64")}\n`, stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };
  const stream = (text: string) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    });
  return {
    commands,
    inputs,
    written,
    run,
    async spawn(options: { command: string; env?: Record<string, string> }) {
      const result = await run(options);
      return {
        stdin: new WritableStream<Uint8Array>({
          write(chunk) {
            inputs.push(new TextDecoder().decode(chunk));
          },
        }),
        stdout: stream(result.stdout),
        stderr: stream(result.stderr),
        wait: async () => ({ exitCode: result.exitCode }),
        kill: async () => undefined,
      };
    },
    async readBinaryFile({ path }: { path: string }) {
      return readPng(path) ?? (written.has(path) ? Buffer.from(written.get(path)!) : null);
    },
    async readFile({ path }: { path: string }) {
      const bytes = readPng(path);
      if (bytes) return stream(bytes.toString("latin1"));
      return written.has(path) ? stream(written.get(path)!) : null;
    },
    async readTextFile({ path }: { path: string }) {
      return written.get(path) ?? null;
    },
    async writeTextFile({ path, content }: { path: string; content: string }) {
      written.set(path, content);
    },
    async writeBinaryFile({ path, content }: { path: string; content: Uint8Array }) {
      written.set(path, Buffer.from(content).toString("utf8"));
    },
    async writeFile({ path, content }: { path: string; content: ReadableStream<Uint8Array> }) {
      written.set(path, await new Response(content).text());
    },
    async writeFiles({ files }: { files: ReadonlyArray<{ path: string; content: Uint8Array }> }) {
      for (const file of files) written.set(file.path, Buffer.from(file.content).toString("utf8"));
    },
    resolvePath,
    async removePath() {},
  };
}

/** Text plus the decoded form of every base64 run in it. */
function withDecodedBase64(text: string): string {
  const decoded = [...text.matchAll(/[A-Za-z0-9+/]{16,}={0,2}/g)].map((match) =>
    Buffer.from(match[0], "base64").toString("utf8"),
  );
  return [text, ...decoded].join("\n");
}

function filesUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
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
    if (result.issues) throw new Error("The bar_chart schema rejected valid bars.");
    return result.value;
  }
  if (typeof tool.inputSchema?.safeParse === "function") return tool.inputSchema.parse(input);
  return input;
}

// oxlint-disable-next-line typescript/no-explicit-any -- graded modules are untyped.
async function load(path: string): Promise<any> {
  return (await import(pathToFileURL(resolve(path)).href)).default;
}
