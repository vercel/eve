import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadJson } from "#evals/loaders/index.js";

describe("loadJson", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "eve-eval-json-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("loads and parses a JSON file", async () => {
    const filePath = join(tempDir, "test.json");
    await writeFile(filePath, JSON.stringify({ name: "test", value: 42 }));

    const result = await loadJson(filePath);
    expect(result).toEqual({ name: "test", value: 42 });
  });

  it("loads a JSON array", async () => {
    const filePath = join(tempDir, "test.json");
    await writeFile(filePath, JSON.stringify([1, 2, 3]));

    const result = await loadJson(filePath);
    expect(result).toEqual([1, 2, 3]);
  });

  it("throws on missing file", async () => {
    const filePath = join(tempDir, "nonexistent.json");
    await expect(loadJson(filePath)).rejects.toThrow();
  });

  it("throws on invalid JSON", async () => {
    const filePath = join(tempDir, "invalid.json");
    await writeFile(filePath, "not valid json");
    await expect(loadJson(filePath)).rejects.toThrow();
  });
});
