import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createDefaultSetupState, type SetupState } from "../state.js";
import type { OutputSink } from "../step.js";
import { runHeadless, runInteractive } from "../runner.js";
import { detectAiGateway } from "./detect-ai-gateway.js";

const silentSink: OutputSink = { write: () => {} };

function stateWithProjectPath(path: string): SetupState {
  return {
    ...createDefaultSetupState(),
    projectPath: { kind: "resolved", inPlace: false, path },
  };
}

describe("detectAiGateway box", () => {
  it("records an existing API key from .env.local through apply", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "eve-create-gateway-"));
    await writeFile(join(projectPath, ".env.local"), "AI_GATEWAY_API_KEY=test-key\n", "utf8");
    const box = detectAiGateway();

    const result = await runInteractive([box], stateWithProjectPath(projectPath), silentSink);

    expect(result.kind).toBe("done");
    if (result.kind !== "done") return;
    expect(result.state.aiGatewayCredentials).toEqual({ kind: "api-key", envFile: ".env.local" });
  });

  it("falls back to .env when .env.local has no key", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "eve-create-gateway-"));
    await writeFile(join(projectPath, ".env"), 'AI_GATEWAY_API_KEY="quoted-key"\n', "utf8");
    const box = detectAiGateway();

    const next = await runHeadless([box], stateWithProjectPath(projectPath), silentSink);

    expect(next.aiGatewayCredentials).toEqual({ kind: "api-key", envFile: ".env" });
  });

  it("keeps project resolution separate from API-key detection", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "eve-create-gateway-"));
    const state: SetupState = {
      ...stateWithProjectPath(projectPath),
      project: { kind: "linked", projectId: "prj_demo" },
    };
    const box = detectAiGateway();

    const next = await runHeadless([box], state, silentSink);

    expect(next.aiGatewayCredentials).toEqual({ kind: "unresolved" });
  });

  it("is skipped while the project path is unresolved", async () => {
    const box = detectAiGateway();
    const state = createDefaultSetupState();

    const next = await runHeadless([box], state, silentSink);

    expect(next.aiGatewayCredentials).toEqual({ kind: "unresolved" });
    expect(next).toEqual(state);
  });
});
