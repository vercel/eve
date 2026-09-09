import assert from "node:assert/strict";
import { test } from "node:test";

import { parseToml } from "./toml.ts";

const TASK_TOML = `schema_version = "1.1"
artifacts = []

[task]
name = "terminal-bench/adaptive-rejection-sampler"
keywords = ["applied-statistics", "simulation"] # trailing comment
[[task.authors]]
name = "jvpoulos"
email = "poulos@berkeley.edu"

[metadata]
expert_time_estimate_min = 180.0

[verifier]
timeout_sec = 900.0

[environment]
build_timeout_sec = 600.0
docker_image = "alexgshaw/adaptive-rejection-sampler:20251031"
cpus = 1
memory_mb = 2048
allow_internet = true
mcp_servers = []

[verifier.env]

[environment.env]
`;

test("parses the Terminal-Bench task.toml subset", () => {
  const parsed = parseToml(TASK_TOML);
  assert.equal(parsed.schema_version, "1.1");
  assert.deepEqual(parsed.artifacts, []);
  const task = parsed.task as Record<string, unknown>;
  assert.equal(task.name, "terminal-bench/adaptive-rejection-sampler");
  assert.deepEqual(task.keywords, ["applied-statistics", "simulation"]);
  assert.deepEqual(task.authors, [{ name: "jvpoulos", email: "poulos@berkeley.edu" }]);
  const environment = parsed.environment as Record<string, unknown>;
  assert.equal(environment.docker_image, "alexgshaw/adaptive-rejection-sampler:20251031");
  assert.equal(environment.cpus, 1);
  assert.equal(environment.allow_internet, true);
  assert.deepEqual(environment.env, {});
  assert.deepEqual((parsed.verifier as Record<string, unknown>).timeout_sec, 900);
});

test("handles dotted tables, escapes, and nested arrays", () => {
  const parsed = parseToml(`
[a.b]
text = "line\\nbreak \\"quoted\\" # not a comment"
nested = [[1, 2], ["x, y"], []]
literal = 'C:\\path'
`);
  const table = (parsed.a as Record<string, unknown>).b as Record<string, unknown>;
  assert.equal(table.text, 'line\nbreak "quoted" # not a comment');
  assert.deepEqual(table.nested, [[1, 2], ["x, y"], []]);
  assert.equal(table.literal, "C:\\path");
});

test("rejects unsupported syntax with the line number", () => {
  assert.throws(() => parseToml(`ok = 1\nbad = { inline = true }`), /line 2: inline tables/u);
  assert.throws(() => parseToml(`ok = 1\nbad = 2024-01-01`), /line 2: unsupported value/u);
  assert.throws(() => parseToml(`no equals sign`), /line 1: expected key = value/u);
});
