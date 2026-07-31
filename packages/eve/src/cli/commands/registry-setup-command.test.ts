import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import type { Prompter } from "#setup/prompter.js";
import { REGISTRY_SETUP_PROTOCOL_VERSION } from "#setup/registry-setup-protocol.js";
import { runRegistrySetupCommand } from "./registry-setup-command.js";

const { findPackageJSON, readFile, spawn } = vi.hoisted(() => ({
  findPackageJSON: vi.fn(),
  readFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({ readFile }));
vi.mock("node:module", () => ({ findPackageJSON }));
vi.mock("node:child_process", () => ({ spawn }));

function createPrompter(): Prompter {
  const fake = createFakePrompter({
    single: () => "selected",
    text: () => "answer",
  });
  fake.prompter.log.spinner = vi.fn(() => ({ stop: vi.fn() }));
  return fake.prompter;
}

function protocolChild(
  code = 0,
  signal: NodeJS.Signals | null = null,
  beforeClose?: (child: EventEmitter & { send: ReturnType<typeof vi.fn> }) => void,
) {
  const child = Object.assign(new EventEmitter(), {
    connected: true,
    send: vi.fn(),
    kill: vi.fn(),
    pid: undefined,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  setTimeout(() => {
    child.emit("message", { type: "ready", version: REGISTRY_SETUP_PROTOCOL_VERSION });
    if (beforeClose === undefined) {
      child.emit("message", { type: "result", outcome: { kind: "completed", facts: [] } });
    } else {
      beforeClose(child);
    }
    child.emit("close", code, signal);
  }, 0);
  return child;
}

const options = () => ({ prompter: createPrompter() });

describe("runRegistrySetupCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findPackageJSON.mockReturnValue("/project/node_modules/@acme/slack/package.json");
    readFile.mockResolvedValue(
      JSON.stringify({
        name: "@acme/slack",
        bin: { "acme-slack": "./dist/cli.js", other: "./dist/other.js" },
      }),
    );
  });

  it("runs a package binary with IPC while the parent owns stdin", async () => {
    spawn.mockReturnValue(protocolChild());

    await expect(
      runRegistrySetupCommand(
        "/project",
        { package: "@acme/slack", bin: "acme-slack", args: ["setup"] },
        "channel/slack",
        options(),
      ),
    ).resolves.toEqual({ kind: "completed", output: [] });

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      ["/project/node_modules/@acme/slack/dist/cli.js", "setup"],
      expect.objectContaining({
        cwd: "/project",
        env: expect.objectContaining({
          EVE_SETUP: "1",
          EVE_SETUP_ITEM: "channel/slack",
          EVE_SETUP_PROTOCOL: "1",
        }),
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      }),
    );
  });

  it("routes child prompts through the parent prompter", async () => {
    const child = protocolChild(0, null, (running) => {
      running.emit("message", {
        type: "prompt",
        id: 7,
        prompt: { kind: "text", message: "Workspace name" },
      });
      running.emit("message", { type: "result", outcome: { kind: "completed", facts: [] } });
    });
    const prompter = createPrompter();
    const readText = vi.spyOn(prompter, "text");
    spawn.mockReturnValue(child);

    await runRegistrySetupCommand(
      "/project",
      { package: "@acme/slack", bin: "acme-slack", args: ["setup"] },
      "channel/slack",
      { prompter },
    );

    expect(readText).toHaveBeenCalledWith({ kind: "text", message: "Workspace name" });
    await vi.waitFor(() =>
      expect(child.send).toHaveBeenCalledWith({ type: "prompt-result", id: 7, value: "answer" }),
    );
  });

  it("streams child output through the parent prompter", async () => {
    const child = protocolChild();
    const prompter = createPrompter();
    spawn.mockReturnValue(child);
    child.stdout.write("connecting\n");

    await runRegistrySetupCommand(
      "/project",
      { package: "@acme/slack", bin: "acme-slack", args: [] },
      "channel/slack",
      { prompter },
    );

    expect(prompter.log.commandOutput).toHaveBeenCalledWith("connecting");
  });

  it("uses a structured child failure instead of the exit code", async () => {
    const child = protocolChild(1, null, (running) => {
      running.emit("message", {
        type: "result",
        outcome: {
          kind: "failed",
          error: { message: "Photon approval was denied.", details: ["at setupPhoton"] },
        },
      });
    });
    spawn.mockReturnValue(child);

    await expect(
      runRegistrySetupCommand(
        "/project",
        { package: "@acme/slack", bin: "acme-slack", args: [] },
        "channel/photon-imessage",
        options(),
      ),
    ).rejects.toThrow("Photon approval was denied.\nat setupPhoton");
  });

  it("returns durable setup notes with successful completion", async () => {
    const child = protocolChild(0, null, (running) => {
      running.emit("message", {
        type: "result",
        outcome: {
          kind: "completed",
          facts: [
            { label: "Text your agent", value: "+15550000000", kind: "phone" },
            {
              label: "Photon project",
              value: "https://app.photon.codes/dashboard/project-id",
              kind: "url",
            },
          ],
        },
      });
    });
    spawn.mockReturnValue(child);

    await expect(
      runRegistrySetupCommand(
        "/project",
        { package: "@acme/slack", bin: "acme-slack", args: [] },
        "channel/photon-imessage",
        options(),
      ),
    ).resolves.toEqual({
      kind: "completed",
      output: [
        "Text your agent: +15550000000",
        "Photon project: https://app.photon.codes/dashboard/project-id",
      ],
    });
  });

  it("cancels the setup child through IPC and its process group", async () => {
    const child = Object.assign(new EventEmitter(), {
      connected: true,
      send: vi.fn(),
      kill: vi.fn(),
      pid: undefined,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    const controller = new AbortController();
    spawn.mockReturnValue(child);
    const setup = runRegistrySetupCommand(
      "/project",
      { package: "@acme/slack", bin: "acme-slack", args: [] },
      "channel/slack",
      { prompter: createPrompter(), signal: controller.signal },
    );
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    controller.abort();
    child.emit("message", { type: "result", outcome: { kind: "cancelled" } });
    child.emit("close", 130, null);

    await expect(setup).resolves.toEqual({ kind: "cancelled" });
    expect(child.send).toHaveBeenCalledWith({ type: "cancel" });
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("rejects a setup command that does not speak the protocol", async () => {
    const child = Object.assign(new EventEmitter(), {
      connected: true,
      send: vi.fn(),
      kill: vi.fn(),
      pid: undefined,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    setTimeout(() => child.emit("close", 0, null), 0);
    spawn.mockReturnValue(child);

    await expect(
      runRegistrySetupCommand(
        "/project",
        { package: "@acme/slack", bin: "acme-slack", args: [] },
        "channel/slack",
        options(),
      ),
    ).rejects.toThrow("exited with code 0 before reporting a result");
  });

  it("rejects a binary the installed package does not declare", async () => {
    await expect(
      runRegistrySetupCommand(
        "/project",
        { package: "@acme/slack", bin: "something-else", args: [] },
        "channel/slack",
        options(),
      ),
    ).rejects.toThrow('Package "@acme/slack" does not declare a "something-else" binary.');
    expect(spawn).not.toHaveBeenCalled();
  });

  it("does not download a missing setup package", async () => {
    findPackageJSON.mockReturnValue(undefined);

    await expect(
      runRegistrySetupCommand(
        "/project",
        { package: "@acme/slack", bin: "acme-slack", args: ["setup"] },
        "channel/slack",
        options(),
      ),
    ).rejects.toThrow(
      'Setup package "@acme/slack" is not installed. Run `eve add channel/slack` first.',
    );
    expect(spawn).not.toHaveBeenCalled();
  });
});
