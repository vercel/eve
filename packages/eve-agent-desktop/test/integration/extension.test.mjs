import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

// The eve runtime sets this ambient scope while it loads an extension's modules so
// `defineExtension` can bind config; emulate it before importing the built dist.
globalThis[Symbol.for("eve.ext-config-scope")] = "@eve/agent-desktop.test";

const { default: extension } = await import("@eve/agent-desktop");
const tools = await import("@eve/agent-desktop/tools");
const { AGENT_DESKTOP_REVALIDATION_KEY, AGENT_DESKTOP_VERSION, DESKTOP_APT_PACKAGES } =
  await import("@eve/agent-desktop/sandbox");

const OK = (data, command = "x") => JSON.stringify({ version: "2.5", ok: true, command, data });

function streamOf(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

/** A sandbox process that has already produced `result` and exits immediately. */
function fakeProcess({ stdout = "", stderr = "", exitCode = 0 } = {}) {
  return {
    stdout: streamOf(stdout),
    stderr: streamOf(stderr),
    async wait() {
      return { exitCode };
    },
    async kill() {},
  };
}

/**
 * A sandbox where agent-desktop is installed, the desktop is up, and every
 * command succeeds. `respond` may override the result of a command;
 * `intercept` may replace the process for one, which the abort tests use.
 */
function fakeSandbox({
  respond,
  version = AGENT_DESKTOP_VERSION,
  desktopUp = true,
  intercept,
} = {}) {
  const commands = [];
  return {
    commands,
    async spawn({ command }) {
      commands.push(command);
      const replaced = intercept?.(command);
      if (replaced !== undefined) return replaced;
      if (command.endsWith(" --version 2>/dev/null")) {
        return version === undefined
          ? fakeProcess({ exitCode: 127 })
          : fakeProcess({ stdout: `agent-desktop ${version}\n` });
      }
      if (command.startsWith("xdpyinfo")) return fakeProcess({ exitCode: desktopUp ? 0 : 1 });
      const result = respond?.(command);
      return fakeProcess({ stdout: OK({}), ...result });
    },
  };
}

let nextSession = 0;
const ctx = (sandbox) => ({
  session: { id: (sandbox.sessionId ??= `test-session-${nextSession++}`) },
  getSandbox: async () => sandbox,
});
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** The argv after the binary in the last agent-desktop command. */
function lastArgv(sandbox) {
  const command = sandbox.commands.at(-1);
  const invocation = command.slice(command.lastIndexOf("; ") + 2);
  return [...invocation.matchAll(/'((?:[^']|'"'"')*)'/g)].map((m) => m[1].replaceAll(`'"'"'`, "'"));
}

function resetConfig(overrides = {}) {
  extension(overrides);
}

test("ships the expected tools and defers the advanced ones", () => {
  const files = readdirSync(new URL("../../extension/tools", import.meta.url)).map((f) =>
    f.replace(/\.ts$/, ""),
  );
  assert.deepEqual(Object.keys(tools).sort(), files.sort());
  for (const name of [
    "snapshot",
    "find",
    "click",
    "type",
    "press",
    "launch",
    "screenshot",
    "wait",
    "list_apps",
  ]) {
    assert.ok(name in tools, `missing ${name}`);
    assert.notEqual(tools[name].deferred, true, `${name} should be listed up front`);
  }
  for (const name of [
    "drag",
    "hover",
    "mouse_click",
    "scroll",
    "clipboard_get",
    "resize_window",
    "status",
  ]) {
    assert.equal(tools[name].deferred, true, `${name} should be deferred`);
  }
});

test("instructions name only tools the extension ships", () => {
  const text = readFileSync(new URL("../../extension/instructions.md", import.meta.url), "utf8");
  for (const [, name] of text.matchAll(/`([a-z_]+)`/g)) {
    if (
      ["eve__search", "root", "skeleton", "return", "mouse_"].includes(name) ||
      name.endsWith("_")
    )
      continue;
    assert.ok(name in tools, `instructions mention missing tool ${name}`);
  }
});

test("click runs one agent-desktop command inside the desktop session and returns data", async () => {
  resetConfig();
  const sandbox = fakeSandbox({ respond: () => ({ stdout: OK({ action: "click" }) }) });
  const result = await tools.click.execute({ ref: "@s1:e2" }, ctx(sandbox));
  assert.deepEqual(result, { action: "click" });
  const command = sandbox.commands.at(-1);
  assert.match(command, /^export DISPLAY=':100'; /);
  assert.match(
    command,
    /DBUS_SESSION_BUS_ADDRESS="\$\(cat \/tmp\/agent-desktop-eve\/dbus-session-address/,
  );
  assert.deepEqual(lastArgv(sandbox), ["agent-desktop", "click", "@s1:e2"]);
});

test("snapshot maps camelCase input to CLI flags", async () => {
  resetConfig();
  const sandbox = fakeSandbox();
  await tools.snapshot.execute(
    { app: "gnome-calculator", interactiveOnly: true, compact: true, skeleton: true, maxDepth: 4 },
    ctx(sandbox),
  );
  assert.deepEqual(lastArgv(sandbox), [
    "agent-desktop",
    "snapshot",
    "--app=gnome-calculator",
    "--skeleton",
    "--interactive-only",
    "--compact",
    "--max-depth=4",
  ]);
});

test("free text goes after -- so leading dashes are not read as flags", async () => {
  resetConfig();
  const sandbox = fakeSandbox();
  await tools.type.execute({ ref: "@s1:e4", text: "it's -5 $HOME" }, ctx(sandbox));
  assert.deepEqual(lastArgv(sandbox), ["agent-desktop", "type", "@s1:e4", "--", "it's -5 $HOME"]);
  await tools.select.execute({ ref: "@s1:e3", value: "--none--", timeoutMs: 100 }, ctx(sandbox));
  assert.deepEqual(lastArgv(sandbox), [
    "agent-desktop",
    "select",
    "--timeout-ms=100",
    "@s1:e3",
    "--",
    "--none--",
  ]);
  await tools.clipboard_set.execute({ text: "-1" }, ctx(sandbox));
  assert.deepEqual(lastArgv(sandbox), ["agent-desktop", "clipboard-set", "--", "-1"]);
});

test("negative coordinates use = so clap does not read them as flags", async () => {
  resetConfig();
  const sandbox = fakeSandbox();
  await tools.move_window.execute({ app: "xterm", x: -100, y: 20 }, ctx(sandbox));
  assert.deepEqual(lastArgv(sandbox), [
    "agent-desktop",
    "move-window",
    "--app=xterm",
    "--x=-100",
    "--y=20",
  ]);
});

test("wait takes exactly one condition", async () => {
  resetConfig();
  const sandbox = fakeSandbox();
  await tools.wait.execute(
    { condition: "window", target: "Calculator", app: "gnome-calculator" },
    ctx(sandbox),
  );
  assert.deepEqual(lastArgv(sandbox), [
    "agent-desktop",
    "wait",
    "--window=Calculator",
    "--app=gnome-calculator",
  ]);
  await tools.wait.execute({ condition: "time", ms: 300 }, ctx(sandbox));
  assert.deepEqual(lastArgv(sandbox), ["agent-desktop", "wait", "300"]);
  await tools.wait.execute({ condition: "menu_closed" }, ctx(sandbox));
  assert.deepEqual(lastArgv(sandbox), ["agent-desktop", "wait", "--menu-closed"]);
  await assert.rejects(
    () => tools.wait.execute({ condition: "text" }, ctx(sandbox)),
    /needs target/,
  );
});

test("the wait schema rejects a mode's missing or stray fields", async () => {
  const valid = async (input) =>
    (await tools.wait.inputSchema["~standard"].validate(input)).issues === undefined;
  assert.equal(await valid({ condition: "time", ms: 300 }), true);
  assert.equal(await valid({ condition: "window", target: "Calculator" }), true);
  assert.equal(await valid({ condition: "element", target: "@s1:e2", predicate: "enabled" }), true);
  assert.equal(await valid({ condition: "menu" }), true);
  assert.equal(await valid({ condition: "time" }), false);
  assert.equal(await valid({ condition: "text" }), false);
  assert.equal(await valid({ condition: "menu", target: "File" }), false);
  assert.equal(await valid({ condition: "window", target: "Calculator", ms: 300 }), false);
  assert.equal(await valid({ condition: "text", target: "Done", predicate: "value" }), false);
});

test("a wait with invalid input fails before any sandbox work", async () => {
  resetConfig();
  const sandbox = fakeSandbox();
  await assert.rejects(() => tools.wait.execute({ condition: "time" }, ctx(sandbox)), /needs ms/);
  assert.deepEqual(sandbox.commands, []);
});

test("physical-input tools refuse before any sandbox work when headless", async () => {
  resetConfig();
  const sandbox = fakeSandbox();
  for (const [name, input] of [
    ["scroll", { ref: "@s1:e2" }],
    ["hover", { target: "@s1:e2" }],
    ["mouse_wheel", { xy: "10,20" }],
    ["double_click", { ref: "@s1:e2" }],
  ]) {
    await assert.rejects(() => tools[name].execute(input, ctx(sandbox)), /headed: true/, name);
  }
  assert.deepEqual(sandbox.commands, []);
});

test("pointer targets take a ref or x,y", async () => {
  resetConfig({ headed: true });
  const sandbox = fakeSandbox();
  await tools.hover.execute({ target: "@s1:e2" }, ctx(sandbox));
  assert.deepEqual(lastArgv(sandbox), ["agent-desktop", "--headed", "hover", "@s1:e2"]);
  await tools.drag.execute({ from: "@s1:e2", to: "-10,40" }, ctx(sandbox));
  assert.deepEqual(lastArgv(sandbox), [
    "agent-desktop",
    "--headed",
    "drag",
    "--from=@s1:e2",
    "--to-xy=-10,40",
  ]);
  await tools.mouse_wheel.execute({ xy: "-10,40", dy: -3 }, ctx(sandbox));
  assert.deepEqual(lastArgv(sandbox), [
    "agent-desktop",
    "--headed",
    "mouse-wheel",
    "--x=-10",
    "--y=40",
    "--dy=-3",
  ]);
  resetConfig();
});

test("coordinate inputs take one x,y shape", async () => {
  const valid = async (tool, input) =>
    (await tools[tool].inputSchema["~standard"].validate(input)).issues === undefined;
  assert.equal(await valid("mouse_wheel", { xy: "-10,40" }), true);
  assert.equal(await valid("mouse_wheel", { x: -10, y: 40 }), false);
  assert.equal(await valid("mouse_click", { xy: "10, 40" }), false);
  assert.equal(await valid("hover", { target: "@s1:e2" }), true);
  assert.equal(await valid("hover", { target: "middle" }), false);
});

test("structured errors keep the code, suggestion and retry disposition", async () => {
  resetConfig();
  const error = {
    code: "STALE_REF",
    message: "@s1:e7 not found",
    suggestion: "Re-run a snapshot",
    disposition: { delivery: "not_delivered", retry: "safe" },
  };
  const sandbox = fakeSandbox({
    respond: () => ({
      exitCode: 1,
      stdout: JSON.stringify({ version: "2.5", ok: false, command: "click", error }),
    }),
  });
  await assert.rejects(
    () => tools.click.execute({ ref: "@s1:e7" }, ctx(sandbox)),
    (err) => {
      assert.match(err.message, /STALE_REF: @s1:e7 not found/);
      assert.match(err.message, /Suggestion: Re-run a snapshot/);
      assert.match(err.message, /retry: safe\.$/);
      return true;
    },
  );
});

test("an unsafe failure warns against repeating the action", async () => {
  resetConfig();
  const error = {
    code: "TIMEOUT",
    message: "slow",
    disposition: { delivery: "unknown", retry: "unknown" },
  };
  const sandbox = fakeSandbox({
    respond: () => ({ exitCode: 1, stdout: JSON.stringify({ ok: false, error }) }),
  });
  await assert.rejects(
    () => tools.click.execute({ ref: "@s1:e7" }, ctx(sandbox)),
    /Do not repeat this action blindly/,
  );
});

test("a cancelled call kills its command and waits for its exit before it rejects", async () => {
  resetConfig();
  const events = [];
  let exit;
  const exited = new Promise((resolve) => {
    exit = resolve;
  });
  const sandbox = fakeSandbox({
    intercept: (command) =>
      command.includes("'click'")
        ? {
            stdout: streamOf(""),
            stderr: streamOf(""),
            wait: () => exited.then(() => ({ exitCode: 137 })),
            async kill() {
              events.push("kill-started");
              await tick(20);
              events.push("kill-finished");
              exit();
            },
          }
        : undefined,
  });
  const controller = new AbortController();
  const call = tools.click.execute(
    { ref: "@s1:e2" },
    { ...ctx(sandbox), abortSignal: controller.signal },
  );
  setTimeout(() => controller.abort(new Error("stopped")), 10);
  await assert.rejects(
    call,
    /stopped Its command exited; anything it completed may already have landed/,
  );
  assert.deepEqual(events, ["kill-started", "kill-finished"]);
});

test("a kill that fails is reported as an unstoppable command", async () => {
  resetConfig();
  const sandbox = fakeSandbox({
    intercept: (command) =>
      command.includes("'click'")
        ? {
            stdout: streamOf(""),
            stderr: streamOf(""),
            wait: () => new Promise(() => {}),
            async kill() {
              throw new Error("kill refused");
            },
          }
        : undefined,
  });
  const controller = new AbortController();
  const call = tools.click.execute(
    { ref: "@s1:e2" },
    { ...ctx(sandbox), abortSignal: controller.signal },
  );
  setTimeout(() => controller.abort(new Error("stopped")), 10);
  await assert.rejects(call, /could not be stopped, so treat the action as possibly delivered/);
});

test("screenshot readback shares the call signal and its cleanup is inside the deadline", async () => {
  resetConfig();
  const sandbox = screenshotSandbox();
  let readSignal;
  const reading = Promise.withResolvers();
  sandbox.readBinaryFile = ({ signal }) => {
    readSignal = signal;
    reading.resolve();
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
  const controller = new AbortController();
  const call = tools.screenshot.execute({}, { ...ctx(sandbox), abortSignal: controller.signal });
  await reading.promise;
  assert.equal(readSignal?.aborted, false, "the read should still be running before the abort");
  controller.abort(new Error("stopped"));
  await assert.rejects(call, /stopped/);
  assert.equal(readSignal.aborted, true, "the read should be told the call was cancelled");
});

test("starts the desktop when it is not running", async () => {
  resetConfig();
  const sandbox = fakeSandbox({ desktopUp: false });
  await tools.list_apps.execute({}, ctx(sandbox));
  assert.ok(
    sandbox.commands.some((command) =>
      command.includes("setsid -f Xvfb ':100' -screen 0 1280x800x24"),
    ),
  );
});

test("manageDesktop false keeps the image's own session environment", async () => {
  resetConfig({ manageDesktop: false, display: ":0" });
  const sandbox = fakeSandbox({ desktopUp: false });
  await tools.list_apps.execute({}, ctx(sandbox));
  assert.ok(
    !sandbox.commands.some((command) => command.startsWith("xdpyinfo") || command.includes("Xvfb")),
  );
  const command = sandbox.commands.at(-1);
  assert.match(command, /^export DISPLAY=':0'; /);
  assert.ok(
    !command.includes("DBUS_SESSION_BUS_ADDRESS") && !command.includes("XDG_RUNTIME_DIR"),
    command,
  );
  resetConfig();
});

/** A sandbox whose version probe answers from `versions` in order (undefined: missing). */
function versionSandbox(versions, options) {
  const sandbox = fakeSandbox(options);
  const spawn = sandbox.spawn;
  sandbox.spawn = (opts) => {
    if (!opts.command.endsWith(" --version 2>/dev/null")) return spawn(opts);
    sandbox.commands.push(opts.command);
    const version = versions.shift();
    return Promise.resolve(
      version === undefined
        ? fakeProcess({ exitCode: 127 })
        : fakeProcess({ stdout: `agent-desktop ${version}\n` }),
    );
  };
  return sandbox;
}

const installed = (sandbox) =>
  sandbox.commands.some(
    (command) => command.includes("npm install") || command.includes("apt-get"),
  );

test("a missing CLI points at prepare and never installs at tool time", async () => {
  resetConfig();
  const sandbox = versionSandbox([undefined]);
  await assert.rejects(
    () => tools.list_apps.execute({}, ctx(sandbox)),
    (error) => {
      assert.match(error.message, /agent-desktop \(agent-desktop\) was not found in the sandbox/);
      assert.match(error.message, /installAgentDesktop\(sandbox\).*prepare/);
      assert.match(error.message, /AGENT_DESKTOP_REVALIDATION_KEY/);
      return true;
    },
  );
  assert.equal(installed(sandbox), false);
  assert.equal(sandbox.commands.length, 1, "nothing runs after the failed probe");
});

test("a different agent-desktop minor is reported with the rebuild hint", async () => {
  resetConfig({ binary: "/opt/agent-desktop/bin/agent-desktop" });
  const sandbox = fakeSandbox({ version: "0.9.0" });
  await assert.rejects(
    () => tools.list_apps.execute({}, ctx(sandbox)),
    /agent-desktop 0\.9\.0 in the sandbox does not match[\s\S]*AGENT_DESKTOP_REVALIDATION_KEY/,
  );
  assert.equal(installed(sandbox), false);
  resetConfig();
});

test("the revalidation key changes with the CLI version and the desktop packages", () => {
  assert.ok(AGENT_DESKTOP_REVALIDATION_KEY.includes(AGENT_DESKTOP_VERSION));
  for (const name of DESKTOP_APT_PACKAGES) assert.ok(AGENT_DESKTOP_REVALIDATION_KEY.includes(name));
});

function screenshotSandbox() {
  const sandbox = fakeSandbox({
    respond: (command) => {
      const path = /'(\/tmp\/agent-desktop-eve\/screenshots\/[^']+\.png)'$/.exec(command)?.[1];
      return path ? { stdout: OK({ format: "png", path, width: 370, height: 616 }) } : undefined;
    },
  });
  sandbox.removed = [];
  sandbox.removePath = async (options) => sandbox.removed.push(options);
  sandbox.readBinaryFile = async () => Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  return sandbox;
}

test("screenshot hands channels and the model the pixels, then deletes the file", async () => {
  resetConfig();
  const sandbox = screenshotSandbox();
  const output = await tools.screenshot.execute({ app: "gnome-calculator" }, ctx(sandbox));
  assert.equal(
    output.imageDataUrl,
    `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64")}`,
  );
  assert.equal(output.path, undefined);
  assert.equal(sandbox.removed.length, 1);
  assert.match(sandbox.removed[0].path, /^\/tmp\/agent-desktop-eve\/screenshots\/.+\.png$/);
  assert.equal(sandbox.removed[0].force, true);
  assert.equal(sandbox.removed[0].signal.aborted, false);
  const model = await tools.screenshot.toModelOutput(output);
  assert.equal(model.type, "content");
  assert.ok(!JSON.stringify(model).includes("/tmp/agent-desktop-eve"));
});

test("inlineScreenshots false keeps the file and sends no pixels anywhere", async () => {
  resetConfig({ inlineScreenshots: false });
  const sandbox = screenshotSandbox();
  const output = await tools.screenshot.execute({ app: "gnome-calculator" }, ctx(sandbox));
  assert.equal(output.imageDataUrl, undefined);
  assert.match(output.path, /^\/tmp\/agent-desktop-eve\/screenshots\/.+\.png$/);
  assert.equal(sandbox.removed.length, 0);
  assert.equal((await tools.screenshot.toModelOutput(output)).type, "json");
  resetConfig();
});

test("an unreadable capture keeps its path and says why the model has no pixels", async () => {
  resetConfig();
  const sandbox = screenshotSandbox();
  sandbox.readBinaryFile = async () => {
    throw new Error("read failed");
  };
  const output = await tools.screenshot.execute({ app: "gnome-calculator" }, ctx(sandbox));
  assert.match(output.path, /\.png$/);
  assert.equal(output.imageOmitted, "unreadable");
  assert.ok(sandbox.removed.length === 0, "a capture we could not read is left in place");
  const model = await tools.screenshot.toModelOutput(output);
  assert.match(JSON.stringify(model), /were not inlined/);
  assert.ok(
    !JSON.stringify(model).includes("/tmp/agent-desktop-eve"),
    "the model never sees the sandbox path",
  );
  resetConfig();
});

test("a capture too large to inline keeps its path instead of being dropped", async () => {
  resetConfig();
  const sandbox = screenshotSandbox();
  sandbox.readBinaryFile = async () => Buffer.alloc(4 * 1024 * 1024);
  const output = await tools.screenshot.execute({ app: "gnome-calculator" }, ctx(sandbox));
  assert.equal(output.imageDataUrl, undefined);
  assert.equal(output.imageOmitted, "too_large");
  assert.match(output.path, /\.png$/);
  resetConfig();
});
