import assert from "node:assert/strict";
import test from "node:test";

globalThis[Symbol.for("eve.ext-config-scope")] = "@eve/agent-desktop.setup";
const { default: extension } = await import("@eve/agent-desktop");
const tools = await import("@eve/agent-desktop/tools");
const { AGENT_DESKTOP_VERSION } = await import("@eve/agent-desktop/sandbox");

function result(stdout = "", exitCode = 0) {
  const stream = (text) => new Response(text).body;
  return {
    stdout: stream(stdout),
    stderr: stream(""),
    wait: async () => ({ exitCode }),
    kill: async () => {},
  };
}

/** A sandbox from a prepared template whose desktop is not running yet. */
function coldSandbox() {
  const starting = Promise.withResolvers();
  const continueStart = Promise.withResolvers();
  const state = { desktopUp: false, starting: false, starts: 0, actions: 0 };
  const sandbox = {
    async spawn({ command }) {
      if (command.endsWith(" --version 2>/dev/null")) {
        return result(`agent-desktop ${AGENT_DESKTOP_VERSION}`);
      }
      if (command.startsWith("xdpyinfo")) return result("", state.desktopUp ? 0 : 1);
      if (command.includes("setsid -f Xvfb")) {
        // A second concurrent start would race dbus-launch and overwrite the session-bus address.
        if (state.starting) return result("display already starting", 1);
        state.starts++;
        state.starting = true;
        if (state.starts === 1) {
          starting.resolve();
          await continueStart.promise;
        }
        state.starting = false;
        state.desktopUp = true;
        return result();
      }
      state.actions++;
      return result(JSON.stringify({ ok: true, data: { apps: [] } }));
    },
  };
  return {
    sandbox,
    state,
    starting: starting.promise,
    continueStart: continueStart.resolve,
  };
}

const context = (sandbox, id) => ({ session: { id }, getSandbox: async () => ({ ...sandbox }) });

test("parallel cold calls serialize desktop startup, then restart it after resume", async () => {
  extension({});
  const cold = coldSandbox();
  const ctx = context(cold.sandbox, "parallel-cold-start");
  const first = tools.list_apps.execute({}, ctx);
  await cold.starting;
  const second = tools.list_apps.execute({}, ctx);
  const completed = Promise.all([first, second]);
  cold.continueStart();
  await completed;
  assert.equal(cold.state.starts, 1);
  assert.equal(cold.state.actions, 2);

  cold.state.desktopUp = false;
  await tools.list_apps.execute({}, ctx);
  assert.equal(cold.state.starts, 2, "a resumed sandbox must restart its desktop");
});

test("cancelling a queued call does not cancel setup or actions for other calls", async () => {
  extension({});
  const cold = coldSandbox();
  const ctx = context(cold.sandbox, "cancel-queued-setup");
  const first = tools.list_apps.execute({}, ctx);
  await cold.starting;
  const controller = new AbortController();
  const cancelled = tools.list_apps.execute({}, { ...ctx, abortSignal: controller.signal });
  const rejection = assert.rejects(cancelled, /cancelled in queue/);
  controller.abort(new Error("cancelled in queue"));
  const third = tools.list_apps.execute({}, ctx);
  cold.continueStart();
  await Promise.all([first, rejection, third]);
  assert.equal(cold.state.starts, 1);
  assert.equal(cold.state.actions, 2);
});
