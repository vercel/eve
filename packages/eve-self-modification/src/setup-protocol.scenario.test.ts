import { fork } from "node:child_process";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { REGISTRY_SETUP_PROTOCOL_VERSION, type RegistrySetupOutcome } from "eve/setup";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const setupPath = resolve(packageRoot, "scaffold/setup.js");

async function runSetupChild(executable: string): Promise<{
  readonly messages: readonly unknown[];
  readonly outcome: RegistrySetupOutcome;
}> {
  return new Promise((resolveResult, reject) => {
    const messages: unknown[] = [];
    let outcome: RegistrySetupOutcome | undefined;
    const child = fork(executable, ["--yes"], {
      cwd: packageRoot,
      env: {
        ...process.env,
        EVE_SETUP: "1",
        EVE_SETUP_ITEM: "experimental/self-modification",
        EVE_SETUP_PROTOCOL: String(REGISTRY_SETUP_PROTOCOL_VERSION),
      },
      silent: true,
    });
    child.on("message", (message) => {
      messages.push(message);
      if (
        typeof message === "object" &&
        message !== null &&
        (message as { type?: unknown }).type === "result"
      ) {
        outcome = (message as { outcome: RegistrySetupOutcome }).outcome;
      }
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Setup child exited with code ${code}.`));
      } else if (outcome === undefined) {
        reject(new Error("Setup child exited before reporting a result."));
      } else {
        resolveResult({ messages, outcome });
      }
    });
  });
}

function expectDevelopmentSetup(result: {
  readonly messages: readonly unknown[];
  readonly outcome: RegistrySetupOutcome;
}): void {
  expect(result.messages[0]).toEqual({
    type: "ready",
    version: REGISTRY_SETUP_PROTOCOL_VERSION,
  });
  expect(result.outcome).toEqual({
    kind: "completed",
    facts: [{ label: "Self-modification", value: "local editing" }],
  });
}

describe("self-modification setup protocol", () => {
  it("runs the installed setup child non-interactively with local editing only", async () => {
    expectDevelopmentSetup(await runSetupChild(setupPath));
  }, 30_000);

  it("runs through a linked package path", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-self-modification-setup-link-"));
    try {
      const linkedPackageRoot = join(root, "selfModification");
      await symlink(
        packageRoot,
        linkedPackageRoot,
        process.platform === "win32" ? "junction" : "dir",
      );

      expectDevelopmentSetup(await runSetupChild(resolve(linkedPackageRoot, "scaffold/setup.js")));
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 30_000);
});
