import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stripTypeScriptTypes } from "node:module";
import { discover, extractMigration, generateCatalog, scaffold } from "./migratew.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "eve-migratew-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const wire = join(root, "packages/eve/src/execution/wire");
  await mkdir(join(wire, "session-inbox/migrations"), { recursive: true });
  await writeFile(
    join(wire, "session-inbox-wire.v1.ts"),
    "export const sessionInboxWireV1Schema = {};\n",
  );
  return { root, wire, migrations: join(wire, "session-inbox/migrations") };
}

test("scaffolds only a migration and test, and automatically registers the next version", async (t) => {
  const { root, wire, migrations } = await fixture(t);
  await scaffold(root, "session-inbox");
  assert.deepEqual((await readdir(migrations)).sort(), ["v1-to-v2.test.ts", "v1-to-v2.ts"]);
  const catalog = await discover(root, "session-inbox");
  assert.deepEqual(catalog.versions, [1, 2]);
  assert.match(
    await readFile(join(migrations, "v1-to-v2.ts"), "utf8"),
    /satisfies Migration<1, 2>/,
  );
  assert.match(await readFile(join(migrations, "v1-to-v2.test.ts"), "utf8"), /Replace this test/);
  const generated = await readFile(join(wire, "session-inbox/generated/v1-to-v2.ts"), "utf8");
  assert.match(generated, /export const migration/);
  assert.doesNotMatch(generated, /zod|previousSchema|z\.literal|export const schema/);
  const code = stripTypeScriptTypes(generated);
  const { migration } = await import(`data:text/javascript,${encodeURIComponent(code)}`);
  const before = { kind: "cancel", version: 1, turnId: "turn-1" };
  assert.deepEqual(migration.up(before), { ...before, version: 2 });
  assert.deepEqual(migration.down(migration.up(before)), before);
  await generateCatalog(root, "session-inbox", true);
  await scaffold(root, "session-inbox");
  assert.deepEqual((await discover(root, "session-inbox")).versions, [1, 2, 3]);
});

test("reports stale generated transforms after an authored migration changes", async (t) => {
  const { root, migrations } = await fixture(t);
  await scaffold(root, "session-inbox");
  const path = join(migrations, "v1-to-v2.ts");
  await writeFile(
    path,
    (await readFile(path, "utf8")).replace(
      "({ ...wire, version: 1 })",
      '({ ...wire, version: 1, marker: "changed" })',
    ),
  );
  await assert.rejects(generateCatalog(root, "session-inbox", true), /catalog is stale/);
  await generateCatalog(root, "session-inbox");
  await generateCatalog(root, "session-inbox", true);
});

test("rejects missing tests, missing transitions, and conflicting schema definitions", async (t) => {
  const { root, wire, migrations } = await fixture(t);
  await scaffold(root, "session-inbox");
  await writeFile(
    join(wire, "session-inbox-wire.v2.ts"),
    "export const sessionInboxWireV2Schema = {};\n",
  );
  await assert.rejects(discover(root, "session-inbox"), /Duplicate schema/);
  await rm(join(wire, "session-inbox-wire.v2.ts"));
  await rm(join(migrations, "v1-to-v2.test.ts"));
  await assert.rejects(discover(root, "session-inbox"), /missing migration test/);
  await rm(join(migrations, "v1-to-v2.ts"));
  await writeFile(
    join(wire, "session-inbox-wire.v2.ts"),
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

test("extracts helper dependencies without confusing object keys with schema variables", () => {
  const source = `
import { z } from "#compiled/zod/index.js";
import { SessionInboxWireError } from "#execution/wire/session-inbox-contract.js";
const version = z.literal(2);
export const schema = z.object({ version });
function down(wire) { if (wire.unsupported) throw new SessionInboxWireError("unsupported"); return { ...wire, version: 1 }; }
export const migration = { from: 1, to: 2, up: (wire) => ({ ...wire, version: 2 }), down };
`;
  const result = extractMigration("/migration.ts", source, "migration");
  assert.match(result, /function down/);
  assert.match(result, /SessionInboxWireError/);
  assert.doesNotMatch(result, /zod|z\.literal|export const schema/);
});

test("rejects a transform that depends on the schema or a filesystem import", () => {
  assert.throws(
    () =>
      extractMigration(
        "/migration.ts",
        `
export const schema = {};
export const migration = { up: () => schema };
`,
        "migration",
      ),
    /must not depend on schema/,
  );
  assert.throws(
    () =>
      extractMigration(
        "/migration.ts",
        `
import { readFileSync } from "node:fs";
export const migration = { up: () => readFileSync("x") };
`,
        "migration",
      ),
    /not workflow-safe/,
  );
});

test("removes obsolete generated transforms when an unshipped version is removed", async (t) => {
  const { root, wire, migrations } = await fixture(t);
  await scaffold(root, "session-inbox");
  await rm(join(migrations, "v1-to-v2.ts"));
  await rm(join(migrations, "v1-to-v2.test.ts"));
  await assert.rejects(generateCatalog(root, "session-inbox", true), /catalog is stale/);
  await generateCatalog(root, "session-inbox");
  assert.deepEqual((await readdir(join(wire, "session-inbox/generated"))).sort(), [
    "catalog.ts",
    "schemas.ts",
    "versions.ts",
  ]);
});

test("rejects unsupported import forms rather than dropping a runtime dependency", () => {
  for (const source of [
    'import * as guards from "#shared/guards.js"; export const migration = { up: () => guards.isObject({}) };',
    'import guards from "#shared/guards.js"; export const migration = { up: () => guards({}) };',
  ])
    assert.throws(
      () => extractMigration("/migration.ts", source, "migration"),
      /must use named imports/,
    );
  assert.throws(
    () =>
      extractMigration(
        "/migration.ts",
        'import "side-effects"; export const migration = {};',
        "migration",
      ),
    /side-effect imports/,
  );
});
