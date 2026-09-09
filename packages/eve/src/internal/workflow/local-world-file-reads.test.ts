import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface FileReader {
  readJSON(path: string, decoder: { parse(value: unknown): unknown }): Promise<unknown>;
}

const readFile = vi.fn<() => Promise<string>>();
const decoder = { parse: (value: unknown) => value };
let reader: FileReader;

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const url = new URL("./fs.js", pathToFileURL(require.resolve("@workflow/world-local")));
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  // Exercise the installed patch's Windows path on every CI operating system.
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  try {
    reader = await import(/* @vite-ignore */ url.href);
  } finally {
    Object.defineProperty(process, "platform", platform);
  }
});

beforeEach(() => {
  vi.useFakeTimers();
  readFile.mockReset().mockResolvedValue('{"ready":true}');
  vi.spyOn(fs, "readFile").mockImplementation(readFile);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function read() {
  const settled = Promise.allSettled([reader.readJSON("hook.json", decoder)]);
  await vi.runAllTimersAsync();
  return (await settled)[0];
}

describe("local workflow file reads", () => {
  it.each(["EPERM", "EACCES", "EBUSY"])("recovers from transient %s reads", async (code) => {
    const error = Object.assign(new Error("temporarily busy"), { code });
    readFile.mockRejectedValueOnce(error).mockRejectedValueOnce(error);

    expect(await read()).toEqual({ status: "fulfilled", value: { ready: true } });
    expect(readFile).toHaveBeenCalledTimes(3);
    expect(readFile).toHaveBeenLastCalledWith("hook.json", "utf-8");
  });

  it("still fails when a sharing violation persists", async () => {
    const error = Object.assign(new Error("busy"), { code: "EPERM" });
    readFile.mockRejectedValue(error);

    expect(await read()).toEqual({ status: "rejected", reason: error });
    expect(readFile).toHaveBeenCalledTimes(6);
  });

  it("returns null when a concurrently deleted file disappears", async () => {
    readFile.mockRejectedValueOnce(Object.assign(new Error("busy"), { code: "EPERM" }));
    readFile.mockRejectedValueOnce(Object.assign(new Error("gone"), { code: "ENOENT" }));

    expect(await read()).toEqual({ status: "fulfilled", value: null });
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it("does not retry permanent read failures", async () => {
    const error = Object.assign(new Error("I/O failure"), { code: "EIO" });
    readFile.mockRejectedValue(error);

    expect(await read()).toEqual({ status: "rejected", reason: error });
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("does not retry malformed JSON", async () => {
    readFile.mockResolvedValue("{");

    expect(await read()).toEqual({ status: "rejected", reason: expect.any(SyntaxError) });
    expect(readFile).toHaveBeenCalledTimes(1);
  });
});
