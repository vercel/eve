import { describe, expect, it } from "vitest";
import { buildHarnessDefinition } from "./harness.js";

describe("Buzz harness definition", () => {
  it("uses absolute launch metadata and stores no credentials", () => {
    const definition = buildHarnessDefinition({
      buzzCli: "/Applications/Buzz.app/Contents/MacOS/buzz",
      cliPath: "/opt/eve-buzz-acp-adapter/dist/cli.js",
      modelId: "anthropic/claude-sonnet-5",
      nodePath: "/usr/local/bin/node",
      target: "https://agent.example.com",
      vercelScope: "team_example",
    });

    expect(definition).toMatchObject({
      id: "eve-buzz-acp-adapter",
      label: "eve",
      command: "/usr/local/bin/node",
      args: ["/opt/eve-buzz-acp-adapter/dist/cli.js", "https://agent.example.com"],
      env: {
        BUZZ_CLI: "/Applications/Buzz.app/Contents/MacOS/buzz",
        EVE_MODEL_ID: "anthropic/claude-sonnet-5",
        EVE_VERCEL_SCOPE: "team_example",
      },
    });
    expect(JSON.stringify(definition)).not.toMatch(/PRIVATE|TOKEN|AUTH/i);
  });

  it("pins a local application directory", () => {
    expect(
      buildHarnessDefinition({
        appDirectory: "/workspace/weather",
        buzzCli: "buzz",
        cliPath: "/connector.js",
        modelId: "model",
        nodePath: "/node",
      }).env,
    ).toEqual({
      BUZZ_CLI: "buzz",
      EVE_MODEL_ID: "model",
      EVE_APP_DIR: "/workspace/weather",
    });
  });
});
