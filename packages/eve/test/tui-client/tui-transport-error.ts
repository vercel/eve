import { Client } from "eve/client";
import { EveTUIRunner, MockScreen, MockUserInput } from "./lib/tui.ts";

import { theme } from "./lib/theme.ts";

/**
 * End-to-end proof that a turn-dispatch failure renders as an inline error
 * region instead of crashing the TUI. The runner connects to an unreachable
 * server, so the first `session.send()` rejects with a transport error. The
 * runner must catch it, surface it through the renderer's error path — an
 * `⨯`-marked Error block right where the assistant response would have
 * appeared — and return to the prompt rather than throw out of `run()`.
 *
 * Needs no agent server and no model credentials: the failure is the point.
 */
const UNREACHABLE_HOST = "http://127.0.0.1:49213";
process.env.EVE_TUI_UNICODE = "1";

void (async () => {
  const client = new Client({ host: UNREACHABLE_HOST });
  const session = client.session();
  const screen = new MockScreen({ columns: 100, rows: 40 });
  const input = new MockUserInput();
  const runner = new EveTUIRunner({
    session,
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

    // The runner must survive the failure and return to the prompt rather
    // than tear down.
    await screen.waitForIdlePrompt(5_000);
    console.log(theme.muted("[tui-transport-error] runner returned to prompt"));

    input.ctrlC();
    await runPromise;
  } catch (error) {
    input.ctrlC();
    await runPromise.catch(() => {});
    throw error;
  }
})().catch((error: unknown) => {
  console.error(theme.danger("\n[tui] tui-transport-error smoke test failed:"), error);
  process.exitCode = 1;
});
