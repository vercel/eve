import type { CommandLifecycle } from "#cli/shutdown.js";
import type { DevelopmentServer, DevelopmentServerHandle } from "#internal/nitro/host/types.js";

type WaitableServer = DevelopmentServer & { wait?: () => Promise<void> };

export async function waitForServerOrStop(
  server: WaitableServer,
  lifecycle: CommandLifecycle,
): Promise<void> {
  await Promise.race([lifecycle.stopped, server.wait?.() ?? new Promise<void>(() => {})]);
}

export async function waitForUiOrServer(input: {
  readonly handle: DevelopmentServerHandle;
  readonly lifecycle: CommandLifecycle;
  readonly runUi: () => Promise<void>;
  readonly server: WaitableServer;
}): Promise<void> {
  const ui = input.runUi();
  if (input.handle.kind === "existing" || input.server.wait === undefined) {
    await ui;
    return;
  }
  const result = await Promise.race([
    ui.then(() => ({ type: "ui" as const })),
    input.server.wait().then(
      () => ({ type: "server" as const, error: undefined }),
      (error: unknown) => ({ type: "server" as const, error }),
    ),
  ]);
  if (result.type === "server") {
    input.lifecycle.requestStop();
    await ui;
    if (result.error !== undefined) throw result.error;
  }
}
