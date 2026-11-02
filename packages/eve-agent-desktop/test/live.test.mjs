// End-to-end check against a real desktop in this machine, the same code path a
// tool takes inside an eve sandbox. Opt in with AGENT_DESKTOP_LIVE=1 on an
// Ubuntu 24.04+ host with passwordless sudo; it installs packages.
import assert from "node:assert/strict";
import test from "node:test";

import { createProcessSandbox } from "./support/process-sandbox.mjs";

globalThis[Symbol.for("eve.ext-config-scope")] = "@eve/agent-desktop.live";

const live = process.env.AGENT_DESKTOP_LIVE === "1";

test(
  "drives gnome-calculator through the desktop tools",
  { skip: !live, timeout: 600_000 },
  async () => {
    const { default: extension } = await import("@eve/agent-desktop");
    const tools = await import("@eve/agent-desktop/tools");
    extension({ extraPackages: ["gnome-calculator"] });

    const sandbox = createProcessSandbox();
    const { installAgentDesktop } = await import("@eve/agent-desktop/sandbox");
    await installAgentDesktop(sandbox, {
      extraPackages: ["gnome-calculator"],
      signal: AbortSignal.timeout(300_000),
    });
    const ctx = { session: { id: "live-desktop" }, getSandbox: async () => sandbox };

    const launched = await tools.launch.execute({ app: "gnome-calculator", activate: true }, ctx);
    assert.equal(launched.app, "gnome-calculator");

    const press = async (name) => {
      // Button names differ across gnome-calculator versions ("7" on Ubuntu,
      // "7 7" elsewhere), so match a name substring instead of an exact one.
      const found = await tools.find.execute(
        { app: "gnome-calculator", role: "button", name, first: true },
        ctx,
      );
      assert.ok(found.match, `no button whose name contains "${name}"`);
      await tools.click.execute({ ref: found.match.ref_id }, ctx);
      await tools.wait.execute({ condition: "time", ms: 300 }, ctx);
    };
    for (const key of ["7", "×", "6", "="]) await press(key);

    const tree = JSON.stringify(
      await tools.snapshot.execute(
        { app: "gnome-calculator", interactiveOnly: false, compact: true },
        ctx,
      ),
    );
    assert.match(tree, /42/);

    const shot = await tools.screenshot.execute({ app: "gnome-calculator" }, ctx);
    assert.ok(shot.imageDataUrl?.startsWith("data:image/png;base64,"));

    await tools.close_app.execute({ app: "gnome-calculator" }, ctx);
  },
);
