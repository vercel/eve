import { beforeEach, describe, expect, it, vi } from "vitest";

import { installConfiguredWorkflowWorld } from "#internal/workflow/configure-world.js";

const mocks = vi.hoisted(() => ({
  setWorld: vi.fn(),
}));

vi.mock("#compiled/@workflow/core/runtime.js", () => ({
  setWorld: mocks.setWorld,
}));

describe("installConfiguredWorkflowWorld", () => {
  beforeEach(() => {
    mocks.setWorld.mockClear();
  });

  it("installs and starts a world from the module default export", async () => {
    const world = createMockWorld();
    const createWorld = vi.fn(() => world);

    await expect(
      installConfiguredWorkflowWorld({
        module: { default: createWorld },
      }),
    ).resolves.toBe(world);

    expect(createWorld).toHaveBeenCalledOnce();
    expect(mocks.setWorld).toHaveBeenCalledWith(world);
    expect(world.start).toHaveBeenCalledOnce();
  });

  it("falls back to a createWorld export when no export name is configured", async () => {
    const world = createMockWorld();

    await installConfiguredWorkflowWorld({
      module: { createWorld: () => world },
    });

    expect(mocks.setWorld).toHaveBeenCalledWith(world);
  });

  it("rejects modules without a default or createWorld factory", async () => {
    await expect(
      installConfiguredWorkflowWorld({
        module: {},
      }),
    ).rejects.toThrow(
      'Configured Workflow world module must export a default function or "createWorld" function.',
    );

    expect(mocks.setWorld).not.toHaveBeenCalled();
  });

  it("rejects factories that do not return a Workflow World", async () => {
    await expect(
      installConfiguredWorkflowWorld({
        module: { default: () => ({}) },
      }),
    ).rejects.toThrow("Configured Workflow world factory did not return a valid World.");

    expect(mocks.setWorld).not.toHaveBeenCalled();
  });
});

function createMockWorld() {
  return {
    createQueueHandler: vi.fn(),
    events: {},
    start: vi.fn(),
  };
}
