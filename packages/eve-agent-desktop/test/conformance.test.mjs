// Every tool is a thin wrapper over one agent-desktop command, so the CLI's
// argument surface is this package's real contract. Each tool's argv is built
// here through the shipped code and handed to the real binary: the CLI exits 2
// only for an argument or parse error, so any nonzero-2 exit means a flag or a
// flag's spelling drifted away from the CLI this package claims to target.
//
// Point AGENT_DESKTOP_BIN (or a `agent-desktop` on PATH) at a built CLI to run
// it; without one the test skips.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import test from "node:test";

import { createProcessSandbox } from "./support/process-sandbox.mjs";

globalThis[Symbol.for("eve.ext-config-scope")] = "@eve/agent-desktop.conformance";

const { default: extension } = await import("@eve/agent-desktop");
const tools = await import("@eve/agent-desktop/tools");

const binary = process.env.AGENT_DESKTOP_BIN || "agent-desktop";
const available = (() => {
  if (binary.includes("/")) return existsSync(binary);
  return spawnSync("sh", ["-c", `command -v ${binary}`]).status === 0;
})();

/** One valid input per tool. Every tool must appear here; the test below enforces it. */
const INPUTS = {
  check: { ref: "@s1:e1" },
  clear: { ref: "@s1:e1" },
  click: { ref: "@s1:e1" },
  clipboard_clear: {},
  clipboard_get: {},
  clipboard_set: { text: "-1" },
  close_app: { app: "gnome-calculator", force: true },
  collapse: { ref: "@s1:e1" },
  double_click: { ref: "@s1:e1" },
  drag: { from: "@s1:e1", to: "-10,40" },
  expand: { ref: "@s1:e1" },
  find: { app: "gnome-calculator", role: "button", name: "7", exact: true, first: true },
  focus: { ref: "@s1:e1" },
  focus_window: { app: "gnome-calculator" },
  get: { ref: "@s1:e1", property: "value" },
  hover: { target: "@s1:e1" },
  is: { ref: "@s1:e1", property: "enabled" },
  launch: { app: "gnome-calculator", args: ["--foo"], activate: true, timeout: 1000 },
  list_apps: { app: "gnome" },
  list_displays: {},
  list_surfaces: { app: "gnome-calculator" },
  list_windows: { app: "gnome-calculator" },
  maximize: { app: "gnome-calculator" },
  minimize: { app: "gnome-calculator" },
  mouse_click: { xy: "-10,40", button: "middle", count: 2 },
  mouse_move: { xy: "-10,40" },
  mouse_wheel: { x: -10, y: 40, dy: -3, dx: -2 },
  move_window: { app: "gnome-calculator", x: -100, y: 20 },
  press: { combo: "ctrl+s", app: "gnome-calculator" },
  resize_window: { app: "gnome-calculator", width: 800, height: 600 },
  restore: { app: "gnome-calculator" },
  right_click: { ref: "@s1:e1" },
  screenshot: { app: "gnome-calculator" },
  scroll: { ref: "@s1:e1", direction: "up", amount: 2 },
  scroll_to: { ref: "@s1:e1" },
  select: { ref: "@s1:e1", value: "--none--" },
  set_value: { ref: "@s1:e1", value: "-1" },
  snapshot: {
    app: "gnome-calculator",
    skeleton: true,
    maxDepth: 3,
    includeBounds: true,
    timeoutMs: 1000,
  },
  status: {},
  toggle: { ref: "@s1:e1" },
  triple_click: { ref: "@s1:e1" },
  type: { ref: "@s1:e1", text: "-1" },
  uncheck: { ref: "@s1:e1" },
  wait: { condition: "element", target: "@s1:e1", predicate: "value", value: "-1" },
};

const envelope = (data) => JSON.stringify({ version: "2.5", ok: true, command: "x", data });
const encoder = new TextEncoder();
const streamOf = (text) =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });

/** Run one tool and report the argv it handed the CLI. */
async function argvFor(name, input) {
  let command;
  const sandbox = {
    async spawn({ command: spawned }) {
      command = spawned;
      return {
        stdout: streamOf(envelope({})),
        stderr: streamOf(""),
        wait: async () => ({ exitCode: 0 }),
        kill: async () => {},
      };
    },
  };
  await tools[name].execute(input, {
    session: { id: "conformance" },
    getSandbox: async () => sandbox,
  });
  const invocation = command.slice(command.lastIndexOf("; ") + 2);
  return [...invocation.matchAll(/'((?:[^']|'"'"')*)'/g)].map((m) => m[1].replaceAll(`'"'"'`, "'"));
}

/** The CLI's own verdict: exit 2 is an argument or parse error; anything else means the argv parsed. */
function cliExit(argv) {
  const result = spawnSync(binary, argv.slice(1), { encoding: "utf8", timeout: 30_000 });
  if (result.error) throw result.error;
  return { status: result.status, stderr: result.stderr ?? "", stdout: result.stdout ?? "" };
}

test("every tool has a conformance input", () => {
  assert.deepEqual(Object.keys(tools).sort(), Object.keys(INPUTS).sort());
});

test("the CLI is available to check argv against", { skip: !available }, () => {
  const result = spawnSync(binary, ["--version"], { encoding: "utf8" });
  assert.equal(result.status, 0, `${binary} --version failed: ${result.stderr}`);
});

test("the check itself fails when a flag is wrong", { skip: !available }, () => {
  const argv = ["agent-desktop", "click", "@s1:e1", "--not-a-real-flag"];
  assert.equal(
    cliExit(argv).status,
    2,
    "a bogus flag must exit 2, or this whole file proves nothing",
  );
});

for (const [name, input] of Object.entries(INPUTS)) {
  test(`${name} builds argv the CLI accepts`, { skip: !available }, async () => {
    extension({ headed: true, autoInstall: false, manageDesktop: false });
    let argv;
    try {
      argv = await argvFor(name, input);
    } finally {
      extension({});
    }
    assert.equal(argv[0], "agent-desktop", "the argv must start with the binary");
    const { status, stderr, stdout } = cliExit(argv);
    assert.notEqual(
      status,
      2,
      `${name} -> ${argv.slice(1).join(" ")} was rejected as a usage error: ${stderr || stdout}`,
    );
  });
}

test("a tool runs the real CLI through a real sandbox command", { skip: !available }, async () => {
  extension({ binary, autoInstall: false, manageDesktop: false });
  const sandbox = createProcessSandbox();
  try {
    const data = await tools.status.execute(
      {},
      { session: { id: "real-cli" }, getSandbox: async () => sandbox },
    );
    assert.equal(typeof data?.version, "string", `status returned ${JSON.stringify(data)}`);
    assert.equal(typeof data?.platform, "string");
  } finally {
    extension({});
  }
});
