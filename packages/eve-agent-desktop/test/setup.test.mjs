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

function coldSandbox() {
  const installing = Promise.withResolvers();
  const continueInstall = Promise.withResolvers();
  const state = { installed: false, desktopUp: false, installs: 0, starts: 0, actions: 0 };
  const sandbox = {
    async spawn({ command }) {
      if (command.endsWith(" --version 2>/dev/null")) {
        return result(`agent-desktop ${AGENT_DESKTOP_VERSION}`, state.installed ? 0 : 127);
      }
      if (command.startsWith("xdpyinfo")) return result("", state.desktopUp ? 0 : 1);
      if (command.includes("apt-get update")) {
        state.installs++;
        if (state.installs > 1) return result("apt lock held", 100);
        installing.resolve();
        await continueInstall.promise;
        return result();
      }
      if (command.includes("npm install -g")) {
        state.installed = true;
        return result();
      }
      if (command.includes("setsid -f Xvfb")) {
        state.starts++;
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
    installing: installing.promise,
    continueInstall: continueInstall.resolve,
  };
}

const context = (sandbox, id) => ({ session: { id }, getSandbox: async () => ({ ...sandbox }) });

test("parallel cold calls serialize installation and desktop startup, then recheck after resume", async () => {
  extension({});
  const cold = coldSandbox();
  const ctx = context(cold.sandbox, "parallel-cold-start");
  const first = tools.list_apps.execute({}, ctx);
  await cold.installing;
  const second = tools.list_apps.execute({}, ctx);
  const completed = Promise.all([first, second]);
  cold.continueInstall();
  await completed;
  assert.equal(cold.state.installs, 1);
  assert.equal(cold.state.starts, 1);
  assert.equal(cold.state.actions, 2);

  cold.state.desktopUp = false;
  await tools.list_apps.execute({}, ctx);
  assert.equal(cold.state.starts, 2, "a resumed sandbox must restart its desktop");
  assert.equal(cold.state.installs, 1);
});

test("cancelling a queued call does not cancel setup or actions for other calls", async () => {
  extension({});
  const cold = coldSandbox();
  const ctx = context(cold.sandbox, "cancel-queued-setup");
  const first = tools.list_apps.execute({}, ctx);
  await cold.installing;
  const controller = new AbortController();
  const cancelled = tools.list_apps.execute({}, { ...ctx, abortSignal: controller.signal });
  const rejection = assert.rejects(cancelled, /cancelled in queue/);
  controller.abort(new Error("cancelled in queue"));
  const third = tools.list_apps.execute({}, ctx);
  cold.continueInstall();
  await Promise.all([first, rejection, third]);
  assert.equal(cold.state.installs, 1);
  assert.equal(cold.state.starts, 1);
  assert.equal(cold.state.actions, 2);
});
