import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createJiti } from "jiti";

const setupsRoot = dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { imessageSetup } = await jiti.import(resolve(setupsRoot, "imessage.ts"));

const phoneNumber = "+15551234567";

test("serves the deterministic iMessage registry item", async () => {
  const writes = new Map();
  const commands = [];
  const context = {
    artifactsRoot: "/tmp/photon-test",
    run: async (command) => commands.push(command),
    write: async (path, content) => writes.set(path, content),
  };

  await imessageSetup.onBootstrap(context);
  await imessageSetup.onSession(context);

  const registry = JSON.parse(writes.get("/tmp/photon-test/registry/registry.json"));
  const item = JSON.parse(writes.get("/tmp/photon-test/registry/channel/photon-imessage.json"));
  assert.deepEqual(registry.items, [
    {
      name: "channel/photon-imessage",
      type: "registry:item",
      description: "Connect an eve agent to iMessage through a deterministic provider setup flow.",
      registry: "http://127.0.0.1:4173/registry.json",
      addCommandArgument: "http://127.0.0.1:4173/channel/photon-imessage.json",
    },
  ]);
  assert.equal(item.meta.eve.setup.command, "mock-imessage-setup");
  // The absolute path must reach pnpm unprefixed; `./` in front of it would
  // normalize to a relative path and link a directory that does not exist.
  assert.ok(
    commands.some((command) => command === "pnpm add /tmp/photon-test/mock-imessage-setup"),
  );
  assert.ok(commands.some((command) => command.includes("python3 -m http.server 4173")));
});

test("completes the deterministic iMessage setup with the supplied phone number", () => {
  const artifactsRoot = mkdtempSync(resolve(tmpdir(), "eve-imessage-setup-"));
  const cliPath = resolve(setupsRoot, "mock-imessage-setup/cli.mjs");

  execFileSync(
    process.execPath,
    [cliPath, "--non-interactive", "--answer", `phoneNumber=${JSON.stringify(phoneNumber)}`],
    {
      env: { ...process.env, EVE_AUTHORING_EVAL_DIRECTORY: artifactsRoot },
    },
  );

  const events = readFileSync(resolve(artifactsRoot, "world-events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    events.map((event) => event.type),
    ["setup.started", "project.created", "phone.registered", "setup.completed"],
  );
  assert.equal(events[2].data.phoneNumber, phoneNumber);
});
