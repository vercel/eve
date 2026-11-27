import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const directory = dirname(fileURLToPath(import.meta.url));

const INTERNAL_ALLOWED: Readonly<Record<string, readonly string[]>> = {
  "checkpoint-prompt.ts": ["#internal/attachments/sandbox-refs.js"],
  "default.ts": ["#internal/logging.js"],
  "openai.ts": ["#internal/logging.js"],
};

describe("what the shipped compaction strategies import", () => {
  const sources = readdirSync(directory).filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
  );

  const importsOf = (name: string) =>
    [
      ...readFileSync(join(directory, name), "utf8").matchAll(
        /from "(#(?:harness|internal)\/[^"]+)"/g,
      ),
    ].map((match) => match[1]!);

  it.each(sources)("%s imports nothing from the harness", (name) => {
    expect(importsOf(name).filter((path) => path.startsWith("#harness/"))).toEqual([]);
  });

  it.each(sources)("%s imports only the internal modules it lists", (name) => {
    expect(
      importsOf(name).filter(
        (path) => path.startsWith("#internal/") && !(INTERNAL_ALLOWED[name] ?? []).includes(path),
      ),
    ).toEqual([]);
  });
});
