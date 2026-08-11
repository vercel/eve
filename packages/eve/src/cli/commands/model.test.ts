import { afterEach, describe, expect, it, vi } from "vitest";

import { runAddModelCommand, type AddModelCommandDependencies } from "./model.js";

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

function dependencies(
  overrides: Partial<AddModelCommandDependencies> = {},
): AddModelCommandDependencies {
  return {
    changeAgentModel: vi.fn<AddModelCommandDependencies["changeAgentModel"]>(async ({ slug }) => ({
      kind: "changed",
      to: slug,
    })),
    isEveProject: vi.fn(async () => true),
    modelChangeRefusal: vi.fn(async () => null),
    ...overrides,
  };
}

afterEach(() => {
  process.exitCode = undefined;
});

describe("runAddModelCommand", () => {
  it("changes the model through the shared /model source-change path", async () => {
    const output = logger();
    const deps = dependencies();

    await runAddModelCommand(output, "/project", "openai/gpt-5.5", deps);

    expect(deps.modelChangeRefusal).toHaveBeenCalledWith("/project");
    expect(deps.changeAgentModel).toHaveBeenCalledWith({
      appRoot: "/project",
      slug: "openai/gpt-5.5",
    });
    expect(output.logs.join("\n")).toContain(
      "Model changed to openai/gpt-5.5. Live on your next prompt.",
    );
    expect(output.errors).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  it("reports model validation rejections as command failures", async () => {
    const output = logger();
    const deps = dependencies({
      changeAgentModel: vi.fn<AddModelCommandDependencies["changeAgentModel"]>(async () => ({
        kind: "rejected",
        message: "Unknown model.",
      })),
    });

    await runAddModelCommand(output, "/project", "unknown/model", deps);

    expect(output.logs).toEqual([]);
    expect(output.errors).toEqual(["Unknown model."]);
    expect(process.exitCode).toBe(1);
  });

  it("does not attempt an edit when the authored model is not rewritable", async () => {
    const output = logger();
    const changeAgentModel = vi.fn<AddModelCommandDependencies["changeAgentModel"]>();
    const deps = dependencies({
      changeAgentModel,
      modelChangeRefusal: vi.fn(async () => "Edit `model` in agent.ts."),
    });

    await runAddModelCommand(output, "/project", "openai/gpt-5.5", deps);

    expect(changeAgentModel).not.toHaveBeenCalled();
    expect(output.errors).toEqual(["Edit `model` in agent.ts."]);
    expect(process.exitCode).toBe(1);
  });

  it("formats source-change errors like /model", async () => {
    const output = logger();
    const deps = dependencies({
      changeAgentModel: vi.fn<AddModelCommandDependencies["changeAgentModel"]>(async () => {
        throw new Error("agent.ts could not be read");
      }),
    });

    await runAddModelCommand(output, "/project", "openai/gpt-5.5", deps);

    expect(output.errors).toEqual(["Couldn't change the model: agent.ts could not be read"]);
    expect(process.exitCode).toBe(1);
  });
});
