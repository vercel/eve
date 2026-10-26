import { describe, expect, it, vi } from "vitest";

import { createConnectionSession } from "#execution/sandbox/session.js";
import { bufferToStream, streamToBuffer } from "#execution/sandbox/stream-utils.js";
import type { SandboxConnection } from "#sandbox/provider.js";
import type { SandboxProcess } from "#shared/sandbox-session.js";

function syntheticProcess(input: { exitCode?: number; stdout?: string }): SandboxProcess {
  return {
    stdout: bufferToStream(Buffer.from(input.stdout ?? "", "utf8")),
    stderr: bufferToStream(new Uint8Array()),
    async wait() {
      return { exitCode: input.exitCode ?? 0 };
    },
    async kill() {},
  };
}

/** A connection over an in-memory file map; every primitive is a spy. */
function memoryConnection(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial).map(([path, text]) => [path, Buffer.from(text)]));
  const connection = {
    extensions: { ping: async () => "pong" },
    readFile: vi.fn(
      async ({ path }: { readonly path: string }): Promise<Uint8Array | null> =>
        files.get(path) ?? null,
    ),
    removePath: vi.fn(async () => {}),
    spawn: vi.fn(async () => syntheticProcess({ stdout: "hello" })),
    stop: vi.fn(async () => {}),
    writeFiles: vi.fn(
      async (options: { readonly files: readonly { content: Uint8Array; path: string }[] }) => {
        for (const file of options.files) files.set(file.path, Buffer.from(file.content));
      },
    ),
  } satisfies SandboxConnection<{ ping(): Promise<string> }>;
  return { connection, files };
}

describe("createConnectionSession", () => {
  it("resolves every path and working directory from /workspace", async () => {
    const { connection, files } = memoryConnection();
    const session = createConnectionSession(connection);

    await session.writeTextFile({ content: "hi", path: "notes/./a.txt" });
    await session.writeFiles({ files: [{ content: new Uint8Array([1]), path: "/tmp/b.bin" }] });
    await session.run({ command: "ls", workingDirectory: "src" });
    await session.run({ command: "pwd" });
    await session.removePath({ force: true, path: "../tmp/x", recursive: true });

    expect(session.resolvePath("notes/todo.txt")).toBe("/workspace/notes/todo.txt");
    expect([...files.keys()]).toEqual(["/workspace/notes/a.txt", "/tmp/b.bin"]);
    expect(connection.spawn.mock.calls).toEqual([
      [{ abortSignal: undefined, command: "ls", env: {}, workingDirectory: "/workspace/src" }],
      [{ abortSignal: undefined, command: "pwd", env: {}, workingDirectory: "/workspace" }],
    ]);
    expect(connection.removePath).toHaveBeenCalledWith({
      abortSignal: undefined,
      force: true,
      path: "/tmp/x",
      recursive: true,
    });
  });

  it("resolves from the connection's declared workspaceRoot, which must be absolute", async () => {
    const { connection, files } = memoryConnection();
    const session = createConnectionSession({ ...connection, workspaceRoot: "/srv/app/" });

    await session.writeTextFile({ content: "hi", path: "a.txt" });
    await session.run({ command: "pwd" });

    expect(session.resolvePath(".")).toBe("/srv/app");
    expect([...files.keys()]).toEqual(["/srv/app/a.txt"]);
    expect(connection.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ workingDirectory: "/srv/app" }),
    );
    expect(() => createConnectionSession({ ...connection, workspaceRoot: "srv/app" })).toThrow(
      'Sandbox connection workspaceRoot must be an absolute path, but received "srv/app".',
    );
  });

  it("implements run over spawn and merges the connection's extensions", async () => {
    const session = createConnectionSession(memoryConnection().connection);

    await expect(session.run({ command: "echo hello" })).resolves.toEqual({
      exitCode: 0,
      stderr: "",
      stdout: "hello",
    });
    await expect(session.ping()).resolves.toBe("pong");
  });

  it("rejects connection extensions that would replace a session member", () => {
    const { connection } = memoryConnection();
    expect(() =>
      createConnectionSession({ ...connection, extensions: { run: async () => "mine" } } as never),
    ).toThrow(
      "Sandbox connection extensions cannot replace the session members eve provides: run.",
    );
  });

  it("reads bytes or a stream from the connection in every read variant", async () => {
    const { connection } = memoryConnection({ "/workspace/a.bin": "\u0000\u0001" });
    const session = createConnectionSession(connection);

    await expect(session.readBinaryFile({ path: "a.bin" })).resolves.toEqual(
      Buffer.from([0x00, 0x01]),
    );
    await expect(session.readBinaryFile({ path: "missing.bin" })).resolves.toBeNull();
    connection.readFile.mockResolvedValueOnce(new Blob(["streamed"]).stream() as never);
    await expect(session.readTextFile({ path: "b.txt" })).resolves.toBe("streamed");
    const stream = await session.readFile({ path: "a.bin" });
    expect(await streamToBuffer(stream!)).toEqual(Buffer.from([0x00, 0x01]));
  });

  it("writes stream, binary, and encoded text content as bytes", async () => {
    const { connection, files } = memoryConnection();
    const session = createConnectionSession(connection);
    const bytes = new Uint8Array([0x00, 0x01, 0x02, 0xff]);

    await session.writeFile({ content: bufferToStream(Buffer.from("buy milk")), path: "a.txt" });
    await session.writeBinaryFile({ content: bytes, path: "b.bin" });
    await session.writeTextFile({ content: "aGk=", encoding: "base64", path: "c.txt" });

    expect(files.get("/workspace/a.txt")?.toString()).toBe("buy milk");
    expect(files.get("/workspace/b.bin")).toEqual(Buffer.from(bytes));
    expect(files.get("/workspace/c.txt")?.toString()).toBe("hi");
  });

  it.each([
    ["one line", "alpha\nbeta\ngamma\n", { endLine: 2, startLine: 2 }, "beta\n"],
    ["a range", "one\ntwo\nthree\nfour\n", { endLine: 3, startLine: 2 }, "two\nthree\n"],
    ["through EOF", "a\nb\nc", { startLine: 2 }, "b\nc"],
    ["a clamped end", "a\nb\n", { endLine: 999, startLine: 1 }, "a\nb\n"],
    ["a start past EOF", "only\n", { startLine: 5 }, ""],
    ["from line 1", "a\nb\nc\n", { endLine: 2 }, "a\nb\n"],
    [
      "CRLF endings",
      "alpha\r\nbeta\r\ngamma\r\n",
      { endLine: 2, startLine: 1 },
      "alpha\r\nbeta\r\n",
    ],
    ["bare CR endings", "alpha\rbeta\rgamma\r", { endLine: 2, startLine: 2 }, "beta\r"],
    ["no trailing newline", "first\nsecond", { endLine: 2, startLine: 2 }, "second"],
  ])("reads %s of a text file", async (_, content, range, expected) => {
    const session = createConnectionSession(
      memoryConnection({ "/workspace/f.txt": content }).connection,
    );
    await expect(session.readTextFile({ path: "f.txt", ...range })).resolves.toBe(expected);
  });

  it.each([
    [{ startLine: 1.5 }, "startLine must be a positive integer (1-based)."],
    [{ startLine: 0 }, "startLine must be a positive integer (1-based)."],
    [{ endLine: -1 }, "endLine must be a positive integer (1-based)."],
    [{ endLine: 3, startLine: 5 }, "startLine must not be greater than endLine."],
  ])("rejects the line range %j", async (range, message) => {
    const session = createConnectionSession(memoryConnection().connection);
    await expect(session.readTextFile({ path: "f.txt", ...range })).rejects.toThrow(message);
  });
});
