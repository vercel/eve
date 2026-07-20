import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  discoverAndImportEvals,
  discoverEvalConfig,
  discoverEvalFiles,
  findMisplacedEvalDirs,
  matchesEvalFilter,
} from "#evals/runner/discover.js";

describe("discoverEvalFiles", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "eve-eval-discover-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns an empty array when evals/ does not exist", async () => {
    const files = await discoverEvalFiles(tempDir);
    expect(files).toEqual([]);
  });

  it("discovers *.eval.ts files under evals/", async () => {
    const evalsDir = join(tempDir, "evals");
    await mkdir(evalsDir, { recursive: true });
    await writeFile(join(evalsDir, "alpha.eval.ts"), "export default {}");
    await writeFile(join(evalsDir, "beta.eval.ts"), "export default {}");
    await writeFile(join(evalsDir, "helper.ts"), "export {}");

    const files = await discoverEvalFiles(tempDir);

    expect(files).toHaveLength(2);
    expect(files[0]).toContain("alpha.eval.ts");
    expect(files[1]).toContain("beta.eval.ts");
  });

  it("discovers nested eval files", async () => {
    const nestedDir = join(tempDir, "evals", "sub");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(join(nestedDir, "nested.eval.ts"), "export default {}");

    const files = await discoverEvalFiles(tempDir);

    expect(files).toHaveLength(1);
    expect(files[0]).toContain("nested.eval.ts");
  });

  it("ignores non-eval.ts files", async () => {
    const evalsDir = join(tempDir, "evals");
    await mkdir(evalsDir, { recursive: true });
    await writeFile(join(evalsDir, "lib.ts"), "export {}");
    await writeFile(join(evalsDir, "data.json"), "{}");
    await writeFile(join(evalsDir, "data.yaml"), "key: value");

    const files = await discoverEvalFiles(tempDir);
    expect(files).toEqual([]);
  });

  it("returns files sorted alphabetically by relative path", async () => {
    const evalsDir = join(tempDir, "evals");
    await mkdir(evalsDir, { recursive: true });
    await writeFile(join(evalsDir, "z-eval.eval.ts"), "export default {}");
    await writeFile(join(evalsDir, "a-eval.eval.ts"), "export default {}");

    const files = await discoverEvalFiles(tempDir);

    expect(files[0]).toContain("a-eval.eval.ts");
    expect(files[1]).toContain("z-eval.eval.ts");
  });

  it("imports eval files that use extensionless local TypeScript helpers", async () => {
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify(
        {
          name: "eve-eval-import-test",
          type: "module",
        },
        null,
        2,
      ),
    );

    const evalsDir = join(tempDir, "evals");
    await mkdir(join(evalsDir, "lib"), { recursive: true });
    await writeFile(
      join(evalsDir, "demo.eval.ts"),
      [
        'import { helperValue } from "./lib/utils";',
        "",
        "export default {",
        '  _tag: "EveEval",',
        "  description: helperValue,",
        "  test: async () => {},",
        "};\n",
      ].join("\n"),
    );
    await writeFile(
      join(evalsDir, "lib", "utils.ts"),
      'export const helperValue = "prompt-from-helper";\n',
    );

    const evaluations = await discoverAndImportEvals(tempDir);
    const evaluation = evaluations[0];

    expect(evaluations).toHaveLength(1);
    if (evaluation === undefined) {
      throw new Error("Expected one eval to be discovered.");
    }
    expect(evaluation.id).toBe("demo");
    expect("description" in evaluation && evaluation.description).toBe("prompt-from-helper");
  });

  it("derives nested eval ids from the path under evals/", async () => {
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({ name: "eve-eval-nested-id-test", type: "module" }, null, 2),
    );

    const evalsDir = join(tempDir, "evals");
    await mkdir(join(evalsDir, "weather"), { recursive: true });
    await writeFile(
      join(evalsDir, "weather", "forecast.eval.ts"),
      ["export default {", '  _tag: "EveEval",', "  test: async () => {},", "};\n"].join("\n"),
    );

    const evaluations = await discoverAndImportEvals(tempDir);
    expect(evaluations).toHaveLength(1);
    expect(evaluations[0]?.id).toBe("weather/forecast");
  });

  it("derives zero-padded index ids for array exports", async () => {
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({ name: "eve-eval-array-test", type: "module" }, null, 2),
    );

    const evalsDir = join(tempDir, "evals");
    await mkdir(evalsDir, { recursive: true });
    // Dataset evals build their rows with top-level await (ESM), so the
    // authored-module bundler must support it.
    await writeFile(
      join(evalsDir, "dataset.eval.ts"),
      [
        'const rows: string[] = await Promise.resolve(["one", "two", "three"]);',
        "",
        "export default rows.map((row) => ({",
        '  _tag: "EveEval",',
        "  description: row,",
        "  test: async () => {},",
        "}));\n",
      ].join("\n"),
    );

    const evaluations = await discoverAndImportEvals(tempDir);
    expect(evaluations.map((evaluation) => evaluation.id)).toEqual([
      "dataset/0000",
      "dataset/0001",
      "dataset/0002",
    ]);
  });

  it("rejects array exports containing non-eval entries", async () => {
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({ name: "eve-eval-bad-array-test", type: "module" }, null, 2),
    );

    const evalsDir = join(tempDir, "evals");
    await mkdir(evalsDir, { recursive: true });
    await writeFile(
      join(evalsDir, "broken.eval.ts"),
      'export default [{ description: "missing tag" }];\n',
    );

    await expect(discoverAndImportEvals(tempDir)).rejects.toThrow(/index 0 is not/);
  });

  it("throws on duplicate eval ids across files", async () => {
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({ name: "eve-eval-duplicate-test", type: "module" }, null, 2),
    );

    const evalsDir = join(tempDir, "evals");
    await mkdir(join(evalsDir, "weather"), { recursive: true });
    await writeFile(
      join(evalsDir, "weather.eval.ts"),
      ["export default [", '  { _tag: "EveEval", test: async () => {} },', "];\n"].join("\n"),
    );
    await writeFile(
      join(evalsDir, "weather", "0000.eval.ts"),
      'export default { _tag: "EveEval", test: async () => {} };\n',
    );

    await expect(discoverAndImportEvals(tempDir)).rejects.toThrow(
      /Duplicate eval id "weather\/0000"/,
    );
  });

  it("filters by exact id and by directory prefix", async () => {
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({ name: "eve-eval-filter-test", type: "module" }, null, 2),
    );

    const evalsDir = join(tempDir, "evals");
    await mkdir(join(evalsDir, "runtime"), { recursive: true });
    await writeFile(
      join(evalsDir, "runtime", "alpha.eval.ts"),
      'export default { _tag: "EveEval", test: async () => {} };\n',
    );
    await writeFile(
      join(evalsDir, "runtime", "beta.eval.ts"),
      'export default { _tag: "EveEval", test: async () => {} };\n',
    );
    await writeFile(
      join(evalsDir, "other.eval.ts"),
      'export default { _tag: "EveEval", test: async () => {} };\n',
    );

    const prefixed = await discoverAndImportEvals(tempDir, ["runtime"]);
    expect(prefixed.map((evaluation) => evaluation.id)).toEqual(["runtime/alpha", "runtime/beta"]);

    const exact = await discoverAndImportEvals(tempDir, ["runtime/beta"]);
    expect(exact.map((evaluation) => evaluation.id)).toEqual(["runtime/beta"]);
  });
});

describe("findMisplacedEvalDirs", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "eve-eval-misplaced-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns an empty array when agent/ does not exist", async () => {
    expect(await findMisplacedEvalDirs(tempDir)).toEqual([]);
  });

  it("returns an empty array when agent/ has no eval files", async () => {
    await mkdir(join(tempDir, "agent", "skills"), { recursive: true });
    await writeFile(join(tempDir, "agent", "agent.ts"), "export default {}");

    expect(await findMisplacedEvalDirs(tempDir)).toEqual([]);
  });

  it("detects an evals directory nested directly in agent/", async () => {
    await mkdir(join(tempDir, "agent", "evals"), { recursive: true });
    await writeFile(join(tempDir, "agent", "evals", "weather.eval.ts"), "export default {}");

    expect(await findMisplacedEvalDirs(tempDir)).toEqual(["agent/evals"]);
  });

  it("detects eval files nested deeper in the agent tree", async () => {
    await mkdir(join(tempDir, "agent", "skills", "weather"), { recursive: true });
    await writeFile(
      join(tempDir, "agent", "skills", "weather", "forecast.eval.ts"),
      "export default {}",
    );
    await mkdir(join(tempDir, "agent", "evals"), { recursive: true });
    await writeFile(join(tempDir, "agent", "evals", "alpha.eval.ts"), "export default {}");

    expect(await findMisplacedEvalDirs(tempDir)).toEqual(["agent/evals", "agent/skills/weather"]);
  });

  it("does not flag the legitimate top-level evals/ directory", async () => {
    await mkdir(join(tempDir, "agent"), { recursive: true });
    await writeFile(join(tempDir, "agent", "agent.ts"), "export default {}");
    await mkdir(join(tempDir, "evals"), { recursive: true });
    await writeFile(join(tempDir, "evals", "weather.eval.ts"), "export default {}");

    expect(await findMisplacedEvalDirs(tempDir)).toEqual([]);
  });
});

describe("discoverEvalConfig", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "eve-eval-config-"));
    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify({ name: "eve-eval-config-test", type: "module" }, null, 2),
    );
    await mkdir(join(tempDir, "evals"), { recursive: true });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("throws when evals.config.ts is missing", async () => {
    await expect(discoverEvalConfig(tempDir)).rejects.toThrow(/Missing required eval config/);
  });

  it("imports a defineEvalConfig default export", async () => {
    await writeFile(
      join(tempDir, "evals", "evals.config.ts"),
      [
        "export default {",
        '  _tag: "EveEvalConfig",',
        '  judge: { model: "openai/gpt-5.4-mini" },',
        "  maxConcurrency: 4,",
        "};\n",
      ].join("\n"),
    );

    const config = await discoverEvalConfig(tempDir);
    expect(config.judge?.model).toBe("openai/gpt-5.4-mini");
    expect(config.maxConcurrency).toBe(4);
  });

  it("throws when the default export is not a defineEvalConfig value", async () => {
    await writeFile(
      join(tempDir, "evals", "evals.config.ts"),
      'export default { model: "openai/gpt-5.4-mini" };\n',
    );

    await expect(discoverEvalConfig(tempDir)).rejects.toThrow(
      /must default-export a defineEvalConfig/,
    );
  });
});

describe("matchesEvalFilter", () => {
  it("matches everything when no filters are given", () => {
    expect(matchesEvalFilter("anything", [])).toBe(true);
  });

  it("matches exact ids and directory prefixes only at segment boundaries", () => {
    expect(matchesEvalFilter("runtime/alpha", ["runtime"])).toBe(true);
    expect(matchesEvalFilter("runtime", ["runtime"])).toBe(true);
    expect(matchesEvalFilter("runtime-extra", ["runtime"])).toBe(false);
    expect(matchesEvalFilter("other", ["runtime"])).toBe(false);
  });
});
