import { Buffer } from "node:buffer";
import { setTimeout as sleep } from "node:timers/promises";

import { Client } from "eve/client";
import { EveTUIRunner, MockScreen, MockUserInput } from "./lib/tui.ts";

import {
  hotAddAppRoot,
  installApprovalSubagent,
  removeApprovalSubagent,
} from "./hot-add-fixture.ts";
import { runEnvironment } from "./lib/run.ts";
import { theme } from "./lib/theme.ts";

/** Control for the hot-add regression: the same child approval works when the
 * subagent is present before `eve dev` starts. */

process.env.EVE_TUI_UNICODE = "1";

runEnvironment("preinstalled subagent approval", async ({ cleanup, target }) => {
  await installApprovalSubagent();
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
    client,
    name: "Preinstalled subagent approval",
    screen,
    serverUrl: resolvedTarget.baseUrl,
    userInput: input,
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
    input.emit("data", Buffer.from("y"));
    await screen.waitForText("installed", 30_000);
    await screen.waitForIdlePrompt(30_000);
    console.log(theme.muted("[tui-preinstalled] approval completed through the parent TUI"));
  } catch (error) {
    throw new Error(`Preinstalled child approval failed.\n\n${screen.snapshot()}`, {
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
