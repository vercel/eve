import { afterEach, describe, expect, it, vi } from "vitest";

import { stripAnsi } from "#cli/ui/terminal-text.js";

import { runSetCommand, type SetCommandDependencies } from "./set.js";

function logger() {
  const errors: string[] = [];
  const logs: string[] = [];
  return {
    errors,
    logs,
    error: (message: string) => errors.push(message),
    log: (message: string) => logs.push(message),
  };
}

function dependencies(overrides: Partial<SetCommandDependencies> = {}): SetCommandDependencies {
  return {
    changeAgentModelSettings: vi.fn<SetCommandDependencies["changeAgentModelSettings"]>(
      async () => ({
        kind: "changed",
        changed: ["model", "reasoning"],
        model: "openai/gpt-5.6-sol",
        reasoning: "high",
      }),
    ),
    isEveProject: vi.fn(async () => true),
    ...overrides,
  };
}

afterEach(() => {
  process.exitCode = undefined;
});

describe("runSetCommand", () => {
  it("updates the model and reasoning through one shared source change", async () => {
    const output = logger();
    const deps = dependencies();

    await runSetCommand(
      output,
      "/project",
      { model: "openai/gpt-5.6-sol", reasoning: "high" },
      deps,
    );

    expect(deps.changeAgentModelSettings).toHaveBeenCalledWith({
      appRoot: "/project",
      patch: {
        model: { kind: "set", value: "openai/gpt-5.6-sol" },
        reasoning: { kind: "set", value: "high" },
        gatewayServiceTier: { kind: "keep" },
      },
    });
    expect(stripAnsi(output.logs.join("\n"))).toContain(
      "Model settings updated: model openai/gpt-5.6-sol, reasoning high. Live on your next prompt.",
    );
    expect(output.errors).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  it("updates reasoning without changing the model", async () => {
    const output = logger();
    const deps = dependencies();

    await runSetCommand(output, "/project", { reasoning: "low" }, deps);

    expect(deps.changeAgentModelSettings).toHaveBeenCalledWith({
      appRoot: "/project",
      patch: {
        model: { kind: "keep" },
        reasoning: { kind: "set", value: "low" },
        gatewayServiceTier: { kind: "keep" },
      },
    });
  });

  it("updates the model without changing reasoning", async () => {
    const output = logger();
    const deps = dependencies({
      changeAgentModelSettings: vi.fn<SetCommandDependencies["changeAgentModelSettings"]>(
        async () => ({
          kind: "changed",
          changed: ["model"],
          model: "openai/gpt-5.6-sol",
        }),
      ),
    });

    await runSetCommand(output, "/project", { model: "openai/gpt-5.6-sol" }, deps);

    expect(deps.changeAgentModelSettings).toHaveBeenCalledWith({
      appRoot: "/project",
      patch: {
        model: { kind: "set", value: "openai/gpt-5.6-sol" },
        reasoning: { kind: "keep" },
        gatewayServiceTier: { kind: "keep" },
      },
    });
    expect(stripAnsi(output.logs.join("\n"))).toContain(
      "Model changed to openai/gpt-5.6-sol. Live on your next prompt.",
    );
  });

  it("removes authored reasoning for the provider default", async () => {
    const output = logger();
    const deps = dependencies();

    await runSetCommand(output, "/project", { reasoning: "provider-default" }, deps);

    expect(deps.changeAgentModelSettings).toHaveBeenCalledWith({
      appRoot: "/project",
      patch: {
        model: { kind: "keep" },
        reasoning: { kind: "remove" },
        gatewayServiceTier: { kind: "keep" },
      },
    });
  });

  it("requires at least one setting", async () => {
    const output = logger();
    const deps = dependencies();

    await runSetCommand(output, "/project", {}, deps);

    expect(deps.changeAgentModelSettings).not.toHaveBeenCalled();
    expect(output.errors).toEqual(["Pass --model, --reasoning, or both."]);
    expect(process.exitCode).toBe(1);
  });

  it("rejects unsupported reasoning values before editing source", async () => {
    const output = logger();
    const deps = dependencies();

    await runSetCommand(output, "/project", { reasoning: "extreme" }, deps);

    expect(deps.changeAgentModelSettings).not.toHaveBeenCalled();
    expect(output.errors.join("\n")).toContain('received "extreme"');
    expect(process.exitCode).toBe(1);
  });

  it("reports source-change rejections as command failures", async () => {
    const output = logger();
    const deps = dependencies({
      changeAgentModelSettings: vi.fn<SetCommandDependencies["changeAgentModelSettings"]>(
        async () => ({ kind: "rejected", message: "Unknown model." }),
      ),
    });

    await runSetCommand(output, "/project", { model: "unknown/model" }, deps);

    expect(output.logs).toEqual([]);
    expect(output.errors).toEqual(["Unknown model."]);
    expect(process.exitCode).toBe(1);
  });

  it("formats source-change errors", async () => {
    const output = logger();
    const deps = dependencies({
      changeAgentModelSettings: vi.fn<SetCommandDependencies["changeAgentModelSettings"]>(
        async () => {
          throw new Error("agent.ts could not be read");
        },
      ),
    });

    await runSetCommand(output, "/project", { reasoning: "high" }, deps);

    expect(output.errors).toEqual(["Couldn't update model settings: agent.ts could not be read"]);
    expect(process.exitCode).toBe(1);
  });
});
