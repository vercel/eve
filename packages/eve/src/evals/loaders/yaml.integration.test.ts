import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadYaml } from "#evals/loaders/index.js";

describe("loadYaml", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "eve-eval-yaml-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("loads and parses a YAML file", async () => {
    const filePath = join(tempDir, "test.yaml");
    await writeFile(filePath, "name: test\nvalue: 42\n");

    const result = await loadYaml(filePath);
    expect(result).toEqual({ name: "test", value: 42 });
  });

  it("loads a YAML file with frontmatter delimiters", async () => {
    const filePath = join(tempDir, "test.yaml");
    await writeFile(filePath, "---\nname: test\n---\n");

    const result = await loadYaml(filePath);
    expect(result).toEqual({ name: "test" });
  });

  it("loads nested YAML structures", async () => {
    const filePath = join(tempDir, "test.yaml");
    await writeFile(
      filePath,
      "cases:\n  - id: case-1\n    prompt: hello\n  - id: case-2\n    prompt: world\n",
    );

    const result = await loadYaml(filePath);
    expect(result).toEqual({
      cases: [
        { id: "case-1", prompt: "hello" },
        { id: "case-2", prompt: "world" },
      ],
    });
  });

  it("throws on missing file", async () => {
    const filePath = join(tempDir, "nonexistent.yaml");
    await expect(loadYaml(filePath)).rejects.toThrow();
  });
});
