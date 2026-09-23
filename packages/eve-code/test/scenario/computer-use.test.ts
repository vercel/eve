import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";

import computerUseTool from "../../extension/tools/computer_use.ts";
import {
  computerUseDesktopSizeCommand,
  computerUseDisplayCommand,
  computerUseDriverCommand,
  computerUseDriverRequest,
  computerUseDriverStartCommand,
  computerUseFocusCommand,
  computerUseLaunchCommand,
  computerUseWindowLayoutCommand,
  recordingPath,
  screenshotPath,
} from "../../extension/lib/computer-use.ts";

const INTERACTIVE_ACTIONS = [
  { action: "click", x: 812, y: 436 },
  { action: "double_click", x: 812, y: 436 },
  { action: "triple_click", x: 812, y: 436 },
  {
    action: "drag",
    path: [
      { x: 10, y: 20 },
      { x: 30, y: 40 },
    ],
  },
  { action: "keypress", keys: ["ENTER"] },
  { action: "type", text: "hello" },
  { action: "clipboard_read", selection: "primary" },
  { action: "clipboard_write", selection: "clipboard", text: "hello" },
  { action: "sequence", actions: [{ action: "keypress", keys: ["ENTER"] }] },
] as const;

const sandbox = {
  resolvePath(path: string) {
    return `/custom/workspace/${path}`;
  },
};

function assertValidShell(command: string): void {
  const directory = mkdtempSync(join(tmpdir(), "computer-use-"));
  const path = join(directory, "command.sh");
  try {
    writeFileSync(path, command);
    execFileSync("bash", ["-n", path]);
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}

function driverResponse(screenshot: string, state: string, action: unknown = null): string {
  return JSON.stringify({ action, backend: "cua-driver", screenshot, state, version: "0.12.5" });
}

test("computer-use derives every artifact and driver path from the sandbox", () => {
  assert.equal(
    screenshotPath(sandbox, "desktop.png"),
    "/custom/workspace/computer-use/desktop.png",
  );
  assert.equal(screenshotPath(sandbox), "/custom/workspace/computer-use/latest.png");
  assert.equal(recordingPath(sandbox, "demo.mp4"), "/custom/workspace/computer-use/demo.mp4");
  assert.equal(
    computerUseDriverCommand(sandbox),
    "node '/custom/workspace/.eve-code/computer-use-driver/client.mjs'",
  );
  assert.deepEqual(
    computerUseDriverRequest(
      { action: "click", x: 128, y: 256, button: "left" },
      screenshotPath(sandbox, "click.png"),
    ),
    {
      action: { action: "click", x: 128, y: 256, button: "left" },
      screenshotPath: "/custom/workspace/computer-use/click.png",
    },
  );
});

test("computer-use startup commands remain valid and use resolved paths", () => {
  const display = computerUseDisplayCommand(sandbox);
  const driver = computerUseDriverStartCommand(sandbox);
  assert.match(display, /if ! xdpyinfo -display :99/u);
  assert.match(display, /-screen 0 1920x1080x24/u);
  assert.match(display, /xfwm4 --replace --compositor=on/u);
  assert.match(display, /custom\/workspace\/computer-use\/dbus-session-address/u);
  assert.match(driver, /CUA_DRIVER_RS_TELEMETRY_ENABLED=false/u);
  assert.match(driver, /COMPUTER_USE_REQUEST='\{"action":"health"\}'/u);
  assert.match(driver, /custom\/workspace\/.eve-code\/computer-use-driver\/server\.mjs/u);
  assertValidShell(display);
  assertValidShell(driver);
});

test("computer-use launch, focus, sizing, and layout commands remain valid", () => {
  const commands = [
    computerUseDesktopSizeCommand(sandbox, "social_16_9"),
    computerUseLaunchCommand(sandbox, { action: "launch", app: "xterm" }),
    computerUseLaunchCommand(sandbox, {
      action: "launch",
      app: "firefox",
      url: "https://example.com/search?q=it's&sort=new",
    }),
    computerUseFocusCommand(sandbox, "xterm", "secondary"),
    computerUseWindowLayoutCommand(sandbox, "left"),
  ];
  assert.match(commands[0], /xrandr --fb 1280x720/u);
  assert.match(commands[1], /ComputerUseTerminalPrimary/u);
  assert.match(commands[1], /custom\/workspace\/.eve-code\/managed-browser/u);
  assert.match(commands[2], /'https:\/\/example\.com\/search\?q=it'"'"'s&sort=new'/u);
  assert.match(commands[3], /ComputerUseTerminalSecondary/u);
  assert.match(commands[4], /windowsize .*"\$left_width"/u);
  for (const command of commands) assertValidShell(command);
});

test("computer-use accepts interactive actions without approval-only context", () => {
  const tool = computerUseTool;
  assert.ok(tool.inputSchema instanceof z.ZodType);
  for (const input of INTERACTIVE_ACTIONS) {
    assert.equal(tool.inputSchema.safeParse({ request: input }).success, true, input.action);
  }
});

test("computer-use never requests approval for observations or interactions", async () => {
  const tool = computerUseTool as {
    approval(ctx: {
      approvedTools: ReadonlySet<string>;
      toolInput: unknown;
      toolName: string;
    }): Promise<string> | string;
  };
  for (const toolInput of [undefined, { action: "screenshot" }, ...INTERACTIVE_ACTIONS]) {
    for (const approvedTools of [new Set<string>(), new Set(["code__computer_use"])]) {
      assert.equal(
        await tool.approval({ approvedTools, toolInput, toolName: "code__computer_use" }),
        "not-applicable",
      );
    }
  }
});

test("computer-use schema keeps browser, pacing, clipboard, and recording sequence constraints", () => {
  const tool = computerUseTool;
  assert.ok(tool.inputSchema instanceof z.ZodType);
  assert.equal(
    tool.inputSchema.safeParse({
      request: { action: "launch", app: "firefox", url: "https://eve.dev" },
    }).success,
    true,
  );
  assert.equal(
    tool.inputSchema.safeParse({
      request: { action: "launch", app: "firefox", url: "file:///etc/passwd" },
    }).success,
    false,
  );
  assert.equal(
    tool.inputSchema.safeParse({
      request: {
        action: "type",
        text: "eve dev",
        typingStyle: "natural",
      },
    }).success,
    true,
  );
  assert.equal(
    tool.inputSchema.safeParse({
      request: {
        action: "type",
        text: "eve dev",
        typingStyle: "natural",
        typingDelayMs: 10,
      },
    }).success,
    false,
  );
  assert.equal(
    tool.inputSchema.safeParse({
      request: {
        action: "clipboard_read",
        selection: "primary",
      },
    }).success,
    true,
  );
  assert.equal(
    tool.inputSchema.safeParse({
      request: {
        action: "sequence",
        actions: [
          { action: "record_start", path: "take.mp4" },
          { action: "keypress", keys: ["ENTER"] },
          { action: "record_stop" },
        ],
      },
    }).success,
    true,
  );
});

test("computer-use sends a recording sequence through one resolved driver request", async () => {
  const commands: Array<{ command: string; env?: Record<string, string> }> = [];
  const tool = computerUseTool as {
    execute(input: unknown, ctx: unknown): Promise<{ path: string | null; timings?: unknown }>;
  };
  const output = await tool.execute(
    {
      request: {
        action: "sequence",
        actions: [
          { action: "record_start", path: "take.mp4" },
          { action: "type", text: "echo hi", typingDelayMs: 50 },
          { action: "record_stop" },
        ],
      },
    },
    {
      abortSignal: undefined,
      getSandbox: async () => ({
        ...sandbox,
        run: async (input: { command: string; env?: Record<string, string> }) => {
          commands.push(input);
          return {
            exitCode: 0,
            stderr: "",
            stdout: driverResponse(
              "/custom/workspace/computer-use/latest.png",
              "grounding_window\\tTerminal",
              [{ action: "record_start", durationMs: 12, result: null }],
            ),
          };
        },
      }),
    },
  );
  assert.equal(commands.length, 1);
  assert.equal(
    commands[0]?.env?.COMPUTER_USE_SOCKET_PATH,
    "/custom/workspace/computer-use/cua-driver.sock",
  );
  const request = JSON.parse(commands[0]?.env?.COMPUTER_USE_REQUEST ?? "");
  assert.equal(request.action.actions[0].path, "/custom/workspace/computer-use/take.mp4");
  assert.equal(output.path, "/custom/workspace/computer-use/take.mp4");
  assert.deepEqual(output.timings, [{ action: "record_start", durationMs: 12, result: null }]);
});

test("computer-use advertises an object root while preserving action constraints", async () => {
  const { z } = await import("zod");
  const schema = z.toJSONSchema(computerUseTool.inputSchema as import("zod").z.ZodType, {
    io: "input",
  });
  assert.equal(schema.type, "object");
  for (const keyword of ["oneOf", "anyOf", "allOf"]) assert.equal(keyword in schema, false);
  assert.ok(schema.properties?.request);
});
