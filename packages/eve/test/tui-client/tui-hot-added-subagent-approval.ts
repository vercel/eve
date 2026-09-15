import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

import { Client } from "eve/client";
import {
  resumeDevelopmentRuntimeArtifacts,
  suspendDevelopmentRuntimeArtifacts,
} from "../../src/services/dev-client/runtime-artifacts.ts";
import { EveTUIRunner, MockScreen, MockUserInput } from "./lib/tui.ts";

import {
  hotAddAppRoot,
  installApprovalSubagent,
  removeApprovalSubagent,
} from "./hot-add-fixture.ts";
import { runEnvironment } from "./lib/run.ts";
import { theme } from "./lib/theme.ts";

/**
 * Reproduces the fresh-onboarding path where `/add` installs a background
 * subagent into the same live dev process that immediately delegates to it.
 * The child's first approval must wake the idle parent TUI without a restart.
 */

process.env.EVE_TUI_UNICODE = "1";

runEnvironment("hot-added subagent approval", async ({ cleanup, target }) => {
  await removeApprovalSubagent();
  cleanup(removeApprovalSubagent);

  const resolvedTarget = await target({
    app: "agent-tui-hot-add",
    kind: "local-dev",
    startEnv: { ...process.env, EVE_E2E_MODEL: "mock" },
  });

  const client = new Client({ host: resolvedTarget.baseUrl });
  const screen = new MockScreen({ columns: 140, rows: 60 });
  const input = new MockUserInput();
  const runner = new EveTUIRunner({
    appRoot: hotAddAppRoot,
    bootDetections: [],
    client,
    name: "Hot-added subagent approval",
    onboard: true,
    promptCommandHandler: {
      async handle(command, context) {
        if (command.name === "model") return { message: "Model ready" };
        if (command.name !== "add") return { message: `/${command.name} dismissed.` };
        await context.withExclusiveTerminal?.(installApprovalSubagent);
        return { message: "Added Self-modification", tone: "success" };
      },
    },
    screen,
    serverUrl: resolvedTarget.baseUrl,
    userInput: input,
    withExclusiveTerminal: (task) => withSuspendedRuntime(resolvedTarget.baseUrl, task),
  });

  const runPromise = runner.run().catch((error: unknown) => {
    if (error instanceof Error && error.message === "Interrupted") return;
    throw error;
  });

  try {
    await screen.waitForIdlePrompt(30_000);
    input.type("HOT-ADD-APPROVAL");
    input.enter();

    await screen.waitForText("Approve selfmod__registry_add?", 15_000);
    await sleep(500);
    input.emit("data", Buffer.from("n"));
    await screen.waitForIdlePrompt(30_000);
    console.log(theme.muted("[tui-hot-add] approval reached the parent TUI"));
  } catch (error) {
    throw new Error(`Hot-added child approval did not reach the TUI.\n\n${screen.snapshot()}`, {
      cause: error,
    });
  } finally {
    input.type("/exit");
    input.enter();
    await runPromise;
    await resolvedTarget.stop();
    await removeApprovalSubagent();
  }
});

async function withSuspendedRuntime<T>(serverUrl: string, task: () => Promise<T>): Promise<T> {
  const leaseId = randomUUID();
  let suspended = false;
  for (let attempt = 0; attempt < 20 && !suspended; attempt += 1) {
    suspended = await suspendDevelopmentRuntimeArtifacts({ leaseId, serverUrl });
    if (!suspended) await sleep(100);
  }
  if (!suspended) throw new Error("Could not suspend development runtime artifacts.");
  let outcome: { ok: true; value: T } | { error: unknown; ok: false };
  try {
    outcome = { ok: true, value: await task() };
  } catch (error) {
    outcome = { error, ok: false };
  }
  const resumed =
    (await resumeDevelopmentRuntimeArtifacts({ leaseId, serverUrl, silent: true })) ??
    (await resumeDevelopmentRuntimeArtifacts({ leaseId, serverUrl, silent: true }));
  if (resumed === undefined) {
    throw new Error("Could not resume development runtime artifacts.", {
      cause: outcome.ok ? undefined : outcome.error,
    });
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
