import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { prepareSelfModification } from "../scripts/prepare.mjs";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

async function temporaryFixture(t) {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "eve-selfmod-scaffold-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  return fixtureRoot;
}

async function put(root, path, content) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

async function files(root, directory = "") {
  const result = [];
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    const path = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...(await files(root, path)));
    else result.push(path);
  }
  return result.sort();
}

test("preparation copies the canonical registry targets and removes stale generated files", async (t) => {
  const fixtureRoot = await temporaryFixture(t);
  const registry = JSON.parse(await readFile(join(repoRoot, "apps/docs/registry.json"), "utf8"));
  const item = registry.items.find((item) => item.name === "eve/self-modification");
  await put(fixtureRoot, "agent/tools/keep.ts", "authored tool");
  await put(fixtureRoot, "agent/extensions/self-modification/instructions.md", "stale override");

  await prepareSelfModification({ fixtureRoot });
  for (const file of item.files) {
    assert.deepEqual(
      await readFile(join(fixtureRoot, file.target)),
      await readFile(join(repoRoot, "apps/docs", file.path)),
    );
  }
  assert.deepEqual(
    await files(join(fixtureRoot, "agent/extensions/self-modification")),
    item.files.map((file) => file.target.replace("agent/extensions/self-modification/", "")).sort(),
  );
  assert.equal(await readFile(join(fixtureRoot, "agent/tools/keep.ts"), "utf8"), "authored tool");

  await put(fixtureRoot, item.files[0].target, "modified by previous eval");
  await prepareSelfModification({ fixtureRoot });
  assert.deepEqual(
    await readFile(join(fixtureRoot, item.files[0].target)),
    await readFile(join(repoRoot, "apps/docs", item.files[0].path)),
  );
});

test("invalid registry targets fail before replacing the existing scaffold", async (t) => {
  const root = await temporaryFixture(t);
  const fixtureRoot = join(root, "fixture");
  const sourceRepo = join(root, "repo");
  await put(fixtureRoot, "agent/extensions/self-modification/agent.ts", "existing");
  await put(sourceRepo, "apps/docs/registry/example.ts", "source");
  await put(
    sourceRepo,
    "apps/docs/registry.json",
    JSON.stringify({
      items: [
        {
          name: "eve/self-modification",
          files: [{ path: "registry/example.ts", target: "agent/tools/outside.ts" }],
        },
      ],
    }),
  );
  await assert.rejects(prepareSelfModification({ fixtureRoot, repoRoot: sourceRepo }), /outside/);
  assert.equal(
    await readFile(join(fixtureRoot, "agent/extensions/self-modification/agent.ts"), "utf8"),
    "existing",
  );
});

test("missing source files fail before replacing the existing scaffold", async (t) => {
  const root = await temporaryFixture(t);
  const fixtureRoot = join(root, "fixture");
  const sourceRepo = join(root, "repo");
  await put(fixtureRoot, "agent/extensions/self-modification/agent.ts", "existing");
  await put(
    sourceRepo,
    "apps/docs/registry.json",
    JSON.stringify({
      items: [
        {
          name: "eve/self-modification",
          files: [
            { path: "registry/missing.ts", target: "agent/extensions/self-modification/agent.ts" },
          ],
        },
      ],
    }),
  );
  await assert.rejects(prepareSelfModification({ fixtureRoot, repoRoot: sourceRepo }), /ENOENT/);
  assert.equal(
    await readFile(join(fixtureRoot, "agent/extensions/self-modification/agent.ts"), "utf8"),
    "existing",
  );
});
