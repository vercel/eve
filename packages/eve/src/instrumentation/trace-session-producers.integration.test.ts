import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("trace-session producers", () => {
  it.each(["native-events.ts", "runtime.ts", "channel-delivery.ts", "memory.ts"])(
    "requires explicit trace-session fields in %s identity literals",
    async (file) => {
      const source = await readFile(new URL(file, import.meta.url), "utf8");
      const identityLiterals = (
        source.match(/\{[^{}]*(?<!\.)\brootSessionId(?:\s*:|\s*,)[^{}]*\}/gu) ?? []
      ).filter((literal) => !literal.includes("readonly"));
      expect(identityLiterals.length).toBeGreaterThan(0);
      for (const literal of identityLiterals) {
        expect(literal).toMatch(/\btraceSessionId(?:\s*:|\s*[,}])/u);
      }
    },
  );
});
