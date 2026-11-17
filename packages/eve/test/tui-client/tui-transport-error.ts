import { Client } from "eve/client";
import { EveTUIRunner, MockScreen, MockUserInput } from "./lib/tui.ts";

import { theme } from "./lib/theme.ts";

const UNREACHABLE_HOST = "http://127.0.0.1:49213";
process.env.EVE_TUI_UNICODE = "1";

void (async () => {
  const client = new Client({ baseUrl: UNREACHABLE_HOST });
  const screen = new MockScreen({ columns: 100, rows: 40 });
  const input = new MockUserInput();
  const runner = new EveTUIRunner({
    client,
    screen,
    userInput: input,
    name: "TUI transport error",
  });

  const runPromise = runner.run().catch((error: unknown) => {
    if (error instanceof Error && error.message === "Interrupted") {
      return;
    }
    throw error;
  });

  try {
    await screen.waitForIdlePrompt(5_000);

    input.type("Trigger a transport failure.");
    input.enter();

    await screen.waitForText("Error", 10_000);
    console.log(theme.muted("[tui-transport-error] error region rendered"));

    await screen.waitForIdlePrompt(5_000);
    console.log(theme.muted("[tui-transport-error] runner returned to prompt"));

    input.ctrlC();
    input.ctrlC();
    await runPromise;
  } catch (error) {
    input.ctrlC();
    input.ctrlC();
    await runPromise.catch(() => {});
    throw error;
  }
})().catch((error: unknown) => {
  console.error(theme.danger("\n[tui] tui-transport-error smoke test failed:"), error);
  process.exitCode = 1;
});
