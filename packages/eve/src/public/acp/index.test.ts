import { describe, expect, it } from "vitest";

import { resolveAcpProviderConfig } from "./index.js";

describe("acp model config", () => {
  it("defaults to opencode without keeping the child process alive", () => {
    expect(resolveAcpProviderConfig()).toMatchObject({
      args: ["acp"],
      command: "opencode",
      persistSession: false,
      session: {
        cwd: process.cwd(),
        mcpServers: [],
      },
    });
  });

  it("accepts a model shorthand for preset agents", () => {
    expect(resolveAcpProviderConfig("opencode", "opencode-go/kimi-k2.7-code")).toMatchObject({
      command: "opencode",
      model: "opencode-go/kimi-k2.7-code",
    });
  });

  it("accepts arbitrary ACP commands for registry agents without presets", () => {
    expect(
      resolveAcpProviderConfig({
        args: ["acp"],
        command: "kimi",
        cwd: "/workspace",
        model: "moonshot-v1-auto",
      }),
    ).toMatchObject({
      args: ["acp"],
      command: "kimi",
      model: "moonshot-v1-auto",
      session: {
        cwd: "/workspace",
      },
    });
  });

  it("normalizes named MCP servers", () => {
    expect(
      resolveAcpProviderConfig("opencode", {
        mcpServers: {
          filesystem: {
            args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
            command: "npx",
          },
        },
      }).session.mcpServers,
    ).toEqual([
      {
        args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
        command: "npx",
        env: [],
        name: "filesystem",
      },
    ]);
  });
});
