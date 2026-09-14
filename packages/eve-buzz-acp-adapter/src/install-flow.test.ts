import { describe, expect, it, vi } from "vitest";
import {
  chooseInstallTarget,
  classifyTarget,
  confirmInstall,
  type InstallPrompter,
} from "./install-flow.js";

function fakePrompter(answers: Array<string | boolean>): InstallPrompter {
  return {
    intro: vi.fn(),
    outro: vi.fn(),
    text: vi.fn(async () => String(answers.shift())),
    select: vi.fn(async () => answers.shift() as never),
    log: { success: vi.fn(), info: vi.fn() },
  };
}

describe("interactive install flow", () => {
  it("classifies local directories and secure remote URLs", () => {
    expect(classifyTarget("./weather", "/workspace")).toEqual({
      kind: "local",
      directory: "/workspace/weather",
    });
    expect(classifyTarget("https://agent.example.com/", "/workspace")).toEqual({
      kind: "remote",
      url: "https://agent.example.com",
    });
    expect(classifyTarget("agent.example.com", "/workspace")).toEqual({
      kind: "remote",
      url: "https://agent.example.com",
    });
    expect(() => classifyTarget("http://agent.example.com", "/workspace")).toThrow("HTTPS");
    expect(classifyTarget("http://127.0.0.1:2000", "/workspace")).toEqual({
      kind: "remote",
      url: "http://127.0.0.1:2000",
    });
  });

  it("asks for a local directory when no target was supplied", async () => {
    await expect(
      chooseInstallTarget({
        cwd: "/workspace",
        interactive: true,
        prompter: fakePrompter(["local", "./weather"]),
      }),
    ).resolves.toEqual({ kind: "local", directory: "/workspace/weather" });
  });

  it("asks for a deployed URL when selected", async () => {
    await expect(
      chooseInstallTarget({
        cwd: "/workspace",
        interactive: true,
        prompter: fakePrompter(["remote", "agent.example.com"]),
      }),
    ).resolves.toEqual({ kind: "remote", url: "https://agent.example.com" });
  });

  it("requires explicit target and confirmation outside a TTY", async () => {
    await expect(chooseInstallTarget({ cwd: "/workspace", interactive: false })).rejects.toThrow(
      "--local",
    );
    await expect(confirmInstall({ interactive: false, yes: false })).rejects.toThrow("--yes");
    await expect(confirmInstall({ interactive: false, yes: true })).resolves.toBe(true);
  });
});
