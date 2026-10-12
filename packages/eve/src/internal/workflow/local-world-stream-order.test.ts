import { promises as fs } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assert, expect, it, vi } from "vitest";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each(["initial", "poll"])(
  "delivers chunks once and in order during a %s disk read",
  async (phase) => {
    const require = createRequire(import.meta.url);
    const url = new URL("./streamer.js", pathToFileURL(require.resolve("@workflow/world-local")));
    const { createStreamer } = await import(/* @vite-ignore */ url.href);
    const directory = await fs.mkdtemp(join(tmpdir(), "eve-stream-order-"));
    const { streams } = createStreamer(directory);
    const persisted = deferred();
    const notify = deferred();
    const reading = deferred();
    const finishRead = deferred();
    const rename = fs.rename.bind(fs);
    const readFile = fs.readFile.bind(fs);
    let firstPath: string | undefined;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      await rename(from, to);
      if (String(to).endsWith(".bin") && firstPath === undefined) {
        firstPath = String(to);
        persisted.resolve();
        await notify.promise;
      }
    });
    vi.spyOn(fs, "readFile").mockImplementation(async (...args) => {
      if (String(args[0]) === firstPath) {
        reading.resolve();
        await finishRead.promise;
      }
      return readFile(...args);
    });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      if (phase === "poll") {
        reader = (await streams.get("run", "stream")).getReader();
        // Wait for the initial snapshot before making the first file visible.
        const readdir = fs.readdir.bind(fs);
        const listed = deferred();
        vi.spyOn(fs, "readdir").mockImplementation(async (...args) => {
          try {
            return await readdir(...args);
          } finally {
            listed.resolve();
          }
        });
        await listed.promise;
      }
      const firstWrite = streams.write("run", "stream", new TextEncoder().encode("first"));
      await persisted.promise;
      if (phase === "initial") {
        await streams.write("run", "stream", new TextEncoder().encode("second"));
        reader = (await streams.get("run", "stream")).getReader();
      }
      await reading.promise;
      if (phase === "poll")
        await streams.write("run", "stream", new TextEncoder().encode("second"));
      notify.resolve();
      await firstWrite;
      await streams.close("run", "stream");
      finishRead.resolve();
      assert(reader !== undefined);
      const chunks = [];
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        chunks.push(new TextDecoder().decode(next.value));
      }
      expect(chunks).toEqual(["first", "second"]);
    } finally {
      notify.resolve();
      finishRead.resolve();
      await reader?.cancel();
      vi.restoreAllMocks();
      await fs.rm(directory, { recursive: true, force: true });
    }
  },
);
