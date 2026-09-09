import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stripTypeScriptTypes } from "node:module";
import { discover, generateCatalog, scaffold } from "./migratew.mjs";
import { checkWireChanges } from "./guard-wire-changes.mjs";

async function fixture(t, legacySchema = false) {
  const repoRoot = await mkdtemp(join(tmpdir(), "eve-migratew-"));
  t.after(() => rm(repoRoot, { recursive: true, force: true }));
  const root = join(repoRoot, "packages/eve");
  const wire = join(root, "src/execution/wire");
  const family = join(wire, "session-inbox");
  await mkdir(join(family, "migrations"), { recursive: true });
  await writeFile(
    join(legacySchema ? wire : family, "session-inbox-wire.v1.ts"),
    "export const sessionInboxWireV1Schema = {};\n",
  );
  return { repoRoot, root, wire, family, migrations: join(family, "migrations") };
}

async function gitFixture(t, legacySchema = false) {
  const files = await fixture(t, legacySchema);
  const git = (...args) => execFileSync("git", args, { cwd: files.repoRoot, stdio: "pipe" });
  const commit = () =>
    git(
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "fixture",
    );
  await mkdir(join(files.wire, "session-inbox/generated"));
  await writeFile(join(files.wire, "session-inbox/migration.ts"), "// interface\n");
  await writeFile(join(files.migrations, ".gitkeep"), "");
  git("init", "--initial-branch=main");
  git("add", ".");
  commit();
  git("switch", "-c", "ruiconti/migration-test");
  return { ...files, git, commit };
}

test("allows a scaffolded version addition before and after committing", async (t) => {
  const { repoRoot, root, git, commit } = await gitFixture(t);
  await scaffold(root, "session-inbox");
  await checkWireChanges(repoRoot, "main");
  git("add", ".");
  await checkWireChanges(repoRoot, "main");
  commit();
  await checkWireChanges(repoRoot, "main");
  await generateCatalog(root, "session-inbox", true);
});

test("rejects interface edits alongside an untracked, staged, or committed new version", async (t) => {
  const { repoRoot, root, wire, git, commit } = await gitFixture(t);
  await scaffold(root, "session-inbox");
  await writeFile(join(wire, "session-inbox/migration.ts"), "// changed interface\n");
  await assert.rejects(checkWireChanges(repoRoot, "main"), /Forbidden changes:\n.*migration\.ts/);
  git("add", ".");
  await assert.rejects(checkWireChanges(repoRoot, "main"), /Forbidden changes:\n.*migration\.ts/);
  commit();
  await assert.rejects(checkWireChanges(repoRoot, "main"), /Forbidden changes:\n.*migration\.ts/);
});

test("rejects runner, encoder, decoder, generator, and guard changes with a new version", async (t) => {
  const { repoRoot, root, wire } = await gitFixture(t);
  await scaffold(root, "session-inbox");
  const paths = [
    "packages/eve/src/execution/wire/session-inbox/migrations.ts",
    "packages/eve/src/execution/wire/session-inbox/session-inbox-encoder.ts",
    "packages/eve/src/execution/wire/session-inbox/session-inbox-wire.ts",
    "packages/eve/src/execution/wire/session-inbox/new-helper.ts",
    "packages/eve/src/execution/durable-session-migrations/chain.ts",
    "packages/eve/scripts/migratew.mjs",
    "packages/eve/scripts/migratew.test.mjs",
    "packages/eve/scripts/guard-wire-changes.mjs",
    "scripts/guard-invariants.mjs",
  ];
  await mkdir(join(wire, "../durable-session-migrations"));
  await mkdir(join(root, "scripts"));
  await mkdir(join(repoRoot, "scripts"));
  for (const path of paths) {
    await writeFile(join(repoRoot, path), "// machinery\n");
    await assert.rejects(checkWireChanges(repoRoot, "main"), (error) =>
      error.message.includes(path),
    );
    await rm(join(repoRoot, path));
  }
});

test("rejects machinery deletions and renames with a new version", async (t) => {
  const { repoRoot, root, wire } = await gitFixture(t);
  await scaffold(root, "session-inbox");
  await rename(join(wire, "session-inbox/migration.ts"), join(wire, "session-inbox/renamed.ts"));
  await assert.rejects(checkWireChanges(repoRoot, "main"), /migration\.ts/);
  await rm(join(wire, "session-inbox/renamed.ts"));
  await assert.rejects(checkWireChanges(repoRoot, "main"), /migration\.ts/);
});

test("allows machinery-only fixes but rejects edits to existing pairs with a new version", async (t) => {
  const { repoRoot, root, wire, migrations, git, commit } = await gitFixture(t);
  await scaffold(root, "session-inbox");
  git("add", ".");
  commit();
  git("branch", "--force", "main", "HEAD");
  await writeFile(join(wire, "session-inbox/migration.ts"), "// machinery fix\n");
  await checkWireChanges(repoRoot, "main");
  // Historical immutability is checked separately; this check only governs new versions.
  await writeFile(join(migrations, "v1-to-v2.test.ts"), "// changed test\n");
  await checkWireChanges(repoRoot, "main");
  await scaffold(root, "session-inbox");
  await assert.rejects(checkWireChanges(repoRoot, "main"), /v1-to-v2\.test\.ts/);
});

test("uses the branch merge base even when main has advanced to the same new version", async (t) => {
  const { repoRoot, root, wire, git, commit } = await gitFixture(t);
  git("switch", "main");
  await scaffold(root, "session-inbox");
  git("add", ".");
  commit();
  git("switch", "ruiconti/migration-test");
  await scaffold(root, "session-inbox");
  await writeFile(join(wire, "session-inbox/migration.ts"), "// changed interface\n");
  await assert.rejects(checkWireChanges(repoRoot, "main"), /migration\.ts/);
});

test("requires base history instead of silently skipping the scope check", async (t) => {
  const { repoRoot } = await gitFixture(t);
  await assert.rejects(checkWireChanges(repoRoot, "missing-main"), /Fetch the base branch/);
});

test("recognizes legacy schema paths while moving the family directory", async (t) => {
  const { repoRoot, wire, family } = await gitFixture(t, true);
  await rename(join(wire, "session-inbox-wire.v1.ts"), join(family, "session-inbox-wire.v1.ts"));
  await checkWireChanges(repoRoot, "main");
});

test("allows callers and documentation to change alongside a new wire version", async (t) => {
  const { repoRoot, root } = await gitFixture(t);
  await scaffold(root, "session-inbox");
  await writeFile(join(repoRoot, "CONTRIBUTING.md"), "New protocol documentation\n");
  await writeFile(join(root, "src/execution/caller.ts"), "// use the new protocol\n");
  await checkWireChanges(repoRoot, "main");
});

test("scaffolds a schema, migration, and test, with direct migration imports", async (t) => {
  const { root, family, migrations } = await fixture(t);
  await scaffold(root, "session-inbox");
  assert.deepEqual((await readdir(migrations)).sort(), [
    "v1-to-v2.test.ts",
    "v1-to-v2.ts",
    "v2.schema.ts",
  ]);
  const catalog = await discover(root, "session-inbox");
  assert.deepEqual(catalog.versions, [1, 2]);
  assert.match(
    await readFile(join(migrations, "v1-to-v2.ts"), "utf8"),
    /satisfies Migration<1, 2>/,
  );
  assert.match(await readFile(join(migrations, "v1-to-v2.test.ts"), "utf8"), /Replace this test/);
  const authored = await readFile(join(migrations, "v1-to-v2.ts"), "utf8");
  assert.doesNotMatch(authored, /zod|previousSchema|z\.literal|export const schema/);
  const generated = join(family, "generated");
  assert.deepEqual((await readdir(generated)).sort(), ["catalog.ts", "schemas.ts", "versions.ts"]);
  assert.match(await readFile(join(generated, "catalog.ts"), "utf8"), /migrations\/v1-to-v2\.js/);
  assert.match(await readFile(join(generated, "schemas.ts"), "utf8"), /migrations\/v2\.schema\.js/);
  const code = stripTypeScriptTypes(authored);
  const { v1ToV2: migration } = await import(`data:text/javascript,${encodeURIComponent(code)}`);
  const before = { kind: "cancel", version: 1, turnId: "turn-1" };
  assert.deepEqual(migration.up(before), { ...before, version: 2 });
  assert.deepEqual(migration.down(migration.up(before)), before);
  await generateCatalog(root, "session-inbox", true);
  await scaffold(root, "session-inbox");
  assert.deepEqual((await discover(root, "session-inbox")).versions, [1, 2, 3]);
});

test("migration edits need no regeneration; manual catalog edits are rejected", async (t) => {
  const { root, family, migrations } = await fixture(t);
  await scaffold(root, "session-inbox");
  const path = join(migrations, "v1-to-v2.ts");
  await writeFile(
    path,
    (await readFile(path, "utf8")).replace(
      "({ ...wire, version: 1 })",
      '({ ...wire, version: 1, marker: "changed" })',
    ),
  );
  await generateCatalog(root, "session-inbox", true);
  await writeFile(join(family, "generated/catalog.ts"), "// changed registry\n");
  await assert.rejects(generateCatalog(root, "session-inbox", true), /catalog is stale/);
  await generateCatalog(root, "session-inbox");
  await generateCatalog(root, "session-inbox", true);
});

test("rejects missing tests, missing transitions, and conflicting schema definitions", async (t) => {
  const { root, family, migrations } = await fixture(t);
  await scaffold(root, "session-inbox");
  await writeFile(
    join(family, "session-inbox-wire.v2.ts"),
    "export const sessionInboxWireV2Schema = {};\n",
  );
  await assert.rejects(discover(root, "session-inbox"), /Duplicate schema/);
  await rm(join(family, "session-inbox-wire.v2.ts"));
  await rm(join(migrations, "v1-to-v2.test.ts"));
  await assert.rejects(discover(root, "session-inbox"), /missing migration test/);
  await rm(join(migrations, "v1-to-v2.ts"));
  await rm(join(migrations, "v2.schema.ts"));
  await writeFile(
    join(family, "session-inbox-wire.v2.ts"),
    "export const sessionInboxWireV2Schema = {};\n",
  );
  await assert.rejects(discover(root, "session-inbox"), /exactly one adjacent migration/);
});

test("does not overwrite an existing test when scaffolding", async (t) => {
  const { root, migrations } = await fixture(t);
  const path = join(migrations, "v1-to-v2.test.ts");
  await writeFile(path, "keep this");
  await assert.rejects(scaffold(root, "session-inbox"), /already exists/);
  assert.equal(await readFile(path, "utf8"), "keep this");
  assert.deepEqual(await readdir(migrations), ["v1-to-v2.test.ts"]);
});

test("rejects unknown families without creating paths", async (t) => {
  const { root } = await fixture(t);
  await assert.rejects(scaffold(root, "../escape"), /Unknown wire family/);
});

test("removes obsolete generated transforms when an unshipped version is removed", async (t) => {
  const { root, family, migrations } = await fixture(t);
  await scaffold(root, "session-inbox");
  await rm(join(migrations, "v1-to-v2.ts"));
  await rm(join(migrations, "v1-to-v2.test.ts"));
  await rm(join(migrations, "v2.schema.ts"));
  await writeFile(
    join(family, "generated/v1-to-v2.ts"),
    "// Generated by pnpm run migratew --sync. Do not edit.\n// obsolete copy\n",
  );
  await assert.rejects(generateCatalog(root, "session-inbox", true), /catalog is stale/);
  await generateCatalog(root, "session-inbox");
  assert.deepEqual((await readdir(join(family, "generated"))).sort(), [
    "catalog.ts",
    "schemas.ts",
    "versions.ts",
  ]);
});

test("rejects missing schemas and migration endpoints that disagree with the filename", async (t) => {
  const { root, migrations } = await fixture(t);
  await scaffold(root, "session-inbox");
  const path = join(migrations, "v1-to-v2.ts");
  const source = await readFile(path, "utf8");
  await writeFile(path, source.replace("to: 2", "to: 3"));
  await assert.rejects(discover(root, "session-inbox"), /to must be the literal 2/);
  await writeFile(path, source);
  await rm(join(migrations, "v2.schema.ts"));
  await assert.rejects(discover(root, "session-inbox"), /exactly one adjacent migration/);
});
