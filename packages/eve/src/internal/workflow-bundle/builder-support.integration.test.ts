import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { atomicWriteFile } from "./builder-support.js";

describe("atomicWriteFile", () => {
  it("writes the requested contents to the target path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eve-atomic-write-"));
    const target = join(dir, "output.txt");

    try {
      await atomicWriteFile(target, "hello");
      const result = await readFile(target, "utf8");

      expect(result).toBe("hello");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("replaces an existing file without leaving a tmp artifact behind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eve-atomic-write-"));
    const target = join(dir, "output.txt");

    try {
      await atomicWriteFile(target, "first");
      await atomicWriteFile(target, "second");

      expect(await readFile(target, "utf8")).toBe("second");

      const entries = await import("node:fs/promises").then((fs) => fs.readdir(dir));
      const tmpLeftovers = entries.filter((name) => name.startsWith("output.txt.tmp-"));
      expect(tmpLeftovers).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Windows rejects rename-over-open-file when an active handle does not allow
  // delete/rename sharing. That preserves the no-partial-visibility invariant,
  // but it does not provide POSIX's progress guarantee under continuous reads.
  it.skipIf(process.platform === "win32")(
    "never exposes a partial file to a concurrent reader",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "eve-atomic-write-"));
      const target = join(dir, "workflows.mjs");

      const payloadA = `${"a".repeat(64 * 1024)}\nexport const POST = "A";\n`;
      const payloadB = `${"b".repeat(64 * 1024)}\nexport const POST = "B";\n`;
      const allowedLengths = new Set([payloadA.length, payloadB.length]);

      try {
        await atomicWriteFile(target, payloadA);

        let stop = false;
        const observedLengths = new Set<number>();

        const reader = (async () => {
          while (!stop) {
            try {
              const contents = await readFile(target, "utf8");
              observedLengths.add(contents.length);
            } catch (error) {
              if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
                throw error;
              }
              observedLengths.add(-1);
            }
          }
        })();

        try {
          for (let i = 0; i < 50; i += 1) {
            await atomicWriteFile(target, i % 2 === 0 ? payloadB : payloadA);
          }
        } finally {
          stop = true;
          await reader;
        }

        for (const length of observedLengths) {
          expect(allowedLengths.has(length)).toBe(true);
        }

        const finalStat = await stat(target);
        expect(allowedLengths.has(finalStat.size)).toBe(true);
        expect(dirname(target)).toBe(dir);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
